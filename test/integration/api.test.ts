import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type TestApp, api, startTestApp, wagerPayload } from "../support/app";
import { type TestDatabase, createTestDatabase } from "../support/database";
import { expectLedgerConsistent } from "../support/invariants";

let db: TestDatabase;
let app: TestApp;
let client: ReturnType<typeof api>;

beforeAll(async () => {
  db = await createTestDatabase();
  app = await startTestApp(db.url);
  client = api(app.baseUrl);
});
afterAll(async () => {
  await expectLedgerConsistent(db.sql);
  await app?.close();
  await db?.drop();
});

async function newWallet(amount = "100.00") {
  const res = await client.createWallet(amount);
  expect(res.status).toBe(201);
  return res.body as { id: string; playerId: string; balance: { amount: string; currency: string }; version: number };
}

describe("POST /wallets", () => {
  test("cria com OPENING + crédito no ledger na mesma transação", async () => {
    const wallet = await newWallet("1000.00");
    expect(wallet.balance).toEqual({ amount: "1000.00", currency: "BRL" });
    expect(wallet.version).toBe(1);
    const ledger = await client.get(`/wallets/${wallet.id}/ledger`);
    expect(ledger.body.items).toHaveLength(1);
    expect(ledger.body.items[0]).toMatchObject({ direction: "CREDIT", money: { amount: "1000.00" }, balanceBefore: { amount: "0.00" } });
    const [opening] = await db.sql`select kind, status from wager_transactions where wallet_id = ${wallet.id}`;
    expect(opening).toEqual({ kind: "OPENING", status: "PROCESSED" });
  });

  test("saldo zero não gera lançamento", async () => {
    const wallet = await newWallet("0.00");
    expect((await client.get(`/wallets/${wallet.id}/ledger`)).body.items).toHaveLength(0);
  });

  test("wallet duplicada para o mesmo player + moeda → 409", async () => {
    const wallet = await newWallet("0.00");
    const dup = await client.createWallet("5.00", "BRL", wallet.playerId);
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe("WALLET_ALREADY_EXISTS");
    const other = await client.createWallet("5.00", "USD", wallet.playerId);
    expect(other.status).toBe(201);
  });

  test.each([
    ["amount number", { amount: 10, currency: "BRL" }],
    ["3 casas", { amount: "1.005", currency: "BRL" }],
    ["negativo", { amount: "-1.00", currency: "BRL" }],
    ["moeda inválida", { amount: "1.00", currency: "real" }],
  ])("payload inválido (%s) → 400", async (_label, initialBalance) => {
    const res = await client.post("/wallets", { playerId: crypto.randomUUID(), initialBalance });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_PAYLOAD");
  });

  test("GET de wallet inexistente → 404", async () => {
    const res = await client.get(`/wallets/${crypto.randomUUID()}`);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("WALLET_NOT_FOUND");
  });
});

describe("POST /wagering/transactions", () => {
  test("BET processada → 200 com saldo; replay idêntico → mesma resposta com idempotentReplay", async () => {
    const wallet = await newWallet("1000.00");
    const bet = wagerPayload(wallet, "BET", "25.00");
    const first = await client.submit(bet);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ status: "PROCESSED", balance: { amount: "975.00", currency: "BRL" }, idempotentReplay: false });

    await client.submit(wagerPayload(wallet, "BET", "100.00")); // saldo muda depois
    const replay = await client.submit(bet);
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual({ ...first.body, idempotentReplay: true }); // saldo observado na época: 975.00
  });

  test("mesma Idempotency-Key com payload diferente → 409, sem efeito", async () => {
    const wallet = await newWallet("100.00");
    const bet = wagerPayload(wallet, "BET", "10.00");
    await client.submit(bet);
    const conflict = await client.submit({ ...bet, money: { amount: "11.00", currency: "BRL" } });
    expect(conflict.status).toBe(409);
    expect(conflict.body.error.code).toBe("IDEMPOTENCY_CONFLICT");
    expect((await client.get(`/wallets/${wallet.id}`)).body.balance.amount).toBe("90.00");
  });

  test("409 não expõe ids internos: só o motivo", async () => {
    const wallet = await newWallet("100.00");
    const bet = wagerPayload(wallet, "BET", "10.00");
    const first = await client.submit(bet);
    const conflict = await client.submit({ ...bet, money: { amount: "11.00", currency: "BRL" } });
    expect(conflict.body.error.details).toEqual({ reason: "PAYLOAD_MISMATCH" });
    expect(JSON.stringify(conflict.body)).not.toContain(first.body.transactionId);

    // mesmo externalTransactionId, outra chave → 409 também
    const reused = await client.submit(bet, "outra-chave");
    expect(reused.status).toBe(409);
    expect(reused.body.error.details).toEqual({ reason: "EXTERNAL_ID_REUSED" });
  });

  test("Idempotency-Key é por provedor: a mesma chave em outro provedor é outra operação", async () => {
    const wallet = await newWallet("100.00");
    const key = `shared-key-${crypto.randomUUID()}`;
    const a = await client.submit(wagerPayload(wallet, "BET", "10.00"), key);
    const b = await client.submit(wagerPayload(wallet, "BET", "20.00", { providerId: "provider-b" }), key);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(b.body.idempotentReplay).toBe(false);
    expect(b.body.balance.amount).toBe("70.00");
  });

  test("providerId \"internal\" é reservado → 400, sem efeito", async () => {
    const wallet = await newWallet("100.00");
    const res = await client.submit(wagerPayload(wallet, "BET", "1.00", { providerId: "internal", externalTransactionId: `opening:${wallet.id}` }));
    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({ code: "INVALID_PAYLOAD", details: { field: "providerId" } });
    expect((await client.get(`/wallets/${wallet.id}`)).body.balance.amount).toBe("100.00");
  });

  test("400 e 409 entram na métrica de requisições recusadas", async () => {
    const metrics = await fetch(`${app.baseUrl}/metrics`).then((r) => r.text());
    expect(metrics).toMatch(/http_requests_rejected_total\{code="IDEMPOTENCY_CONFLICT"\} [1-9]/);
    expect(metrics).toMatch(/http_requests_rejected_total\{code="INVALID_PAYLOAD"\} [1-9]/);
  });

  test("saldo insuficiente → 422 REJECTED, auditável, replay também 422", async () => {
    const wallet = await newWallet("10.00");
    const bet = wagerPayload(wallet, "BET", "50.00");
    const res = await client.submit(bet);
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ status: "REJECTED", failureCode: "INSUFFICIENT_FUNDS", balance: { amount: "10.00" } });
    const replay = await client.submit(bet);
    expect(replay.status).toBe(422);
    expect(replay.body.idempotentReplay).toBe(true);
    const stored = await client.get(`/wagering/transactions/${res.body.transactionId}`);
    expect(stored.body).toMatchObject({ status: "REJECTED", failureCode: "INSUFFICIENT_FUNDS", kind: "BET" });
  });

  test("ciclo BET → WIN → LOSS e consultas por id interno e externo", async () => {
    const wallet = await newWallet("100.00");
    const bet = wagerPayload(wallet, "BET", "10.00");
    await client.submit(bet);
    const win = await client.submit(wagerPayload(wallet, "WIN", "35.50", { referenceExternalTransactionId: bet.externalTransactionId }));
    expect(win.body.balance.amount).toBe("125.50");
    const loss = await client.submit(wagerPayload(wallet, "LOSS", "10.00"));
    expect(loss.status).toBe(200);
    expect(loss.body.balance.amount).toBe("125.50");

    const byExternal = await client.get(`/providers/provider-a/wagering/transactions/${bet.externalTransactionId}`);
    expect(byExternal.body).toMatchObject({ kind: "BET", status: "PROCESSED", money: { amount: "10.00" } });
    const w = await client.get(`/wallets/${wallet.id}`);
    expect(w.body.version).toBe(3); // abertura, BET, WIN — LOSS não muda versão
  });

  test("REFUND reverte a BET uma única vez", async () => {
    const wallet = await newWallet("100.00");
    const bet = wagerPayload(wallet, "BET", "40.00");
    await client.submit(bet);
    const refund = await client.submit(wagerPayload(wallet, "REFUND", "40.00", { referenceExternalTransactionId: bet.externalTransactionId }));
    expect(refund.body).toMatchObject({ status: "PROCESSED", balance: { amount: "100.00" } });
    const again = await client.submit(wagerPayload(wallet, "ROLLBACK", "40.00", { referenceExternalTransactionId: bet.externalTransactionId }));
    expect(again.status).toBe(422);
    expect(again.body.failureCode).toBe("ALREADY_REVERSED");
  });

  test("ROLLBACK de WIN sem saldo → REVERSAL_INSUFFICIENT_FUNDS", async () => {
    const wallet = await newWallet("0.00");
    const win = wagerPayload(wallet, "WIN", "30.00");
    await client.submit(win);
    await client.submit(wagerPayload(wallet, "BET", "20.00"));
    const rb = await client.submit(wagerPayload(wallet, "ROLLBACK", "30.00", { referenceExternalTransactionId: win.externalTransactionId }));
    expect(rb.status).toBe(422);
    expect(rb.body.failureCode).toBe("REVERSAL_INSUFFICIENT_FUNDS");
  });

  test("referência ausente → 202 PENDING_REFERENCE", async () => {
    const wallet = await newWallet("100.00");
    const refund = await client.submit(wagerPayload(wallet, "REFUND", "5.00", { referenceExternalTransactionId: "bet-que-ainda-nao-chegou" }));
    expect(refund.status).toBe(202);
    expect(refund.body.status).toBe("PENDING_REFERENCE");
    const [row] = await db.sql`select next_attempt_at is not null as scheduled from wager_transactions where id = ${refund.body.transactionId}`;
    expect(row.scheduled).toBe(true);
  });

  test("replay de uma pendência devolve o estado atual da transação (ainda 202 enquanto pendente)", async () => {
    const wallet = await newWallet("100.00");
    const refund = wagerPayload(wallet, "REFUND", "5.00", { referenceExternalTransactionId: `bet-${crypto.randomUUID()}` });
    const first = await client.submit(refund);
    const replay = await client.submit(refund);
    expect(replay.status).toBe(202);
    expect(replay.body).toEqual({ ...first.body, idempotentReplay: true });
  });

  test("LOSS e REJECTED não geram WalletBalanceChanged (o saldo não mudou)", async () => {
    const wallet = await newWallet("10.00");
    const loss = await client.submit(wagerPayload(wallet, "LOSS", "3.00"));
    const rejected = await client.submit(wagerPayload(wallet, "BET", "50.00"));
    expect(loss.status).toBe(200);
    expect(rejected.status).toBe(422);
    const rows = await db.sql`select event_type, payload->'data'->>'transactionId' as tx from outbox_messages
      where payload->'data'->>'transactionId' in (${loss.body.transactionId}, ${rejected.body.transactionId}) order by event_type`;
    expect(rows.map((r: { event_type: string; tx: string }) => [r.event_type, r.tx])).toEqual([
      ["WagerTransactionProcessed", loss.body.transactionId],
      ["WagerTransactionRejected", rejected.body.transactionId],
    ]);
    const balanceEvents = await db.sql`select count(*)::int as n from outbox_messages
      where event_type = 'WalletBalanceChanged' and aggregate_id = ${wallet.id}`;
    expect(balanceEvents[0].n).toBe(1); // só o da abertura
  });

  test("moeda diferente da wallet → 422 CURRENCY_MISMATCH", async () => {
    const wallet = await newWallet("100.00");
    const res = await client.submit(wagerPayload(wallet, "BET", "1.00", { money: { amount: "1.00", currency: "USD" } }));
    expect(res.status).toBe(422);
    expect(res.body.failureCode).toBe("CURRENCY_MISMATCH");
    expect(res.body.balance).toEqual({ amount: "100.00", currency: "BRL" });
  });

  test("OPENING não pode ser submetido → 400", async () => {
    const wallet = await newWallet("0.00");
    const res = await client.submit(wagerPayload(wallet, "OPENING", "1.00"));
    expect(res.status).toBe(400);
  });

  test("sem Idempotency-Key → 400", async () => {
    const wallet = await newWallet("0.00");
    const res = await client.post("/wagering/transactions", wagerPayload(wallet, "BET", "1.00"));
    expect(res.status).toBe(400);
  });

  test("wallet inexistente → 404", async () => {
    const res = await client.submit(wagerPayload({ id: crypto.randomUUID(), playerId: crypto.randomUUID() }, "BET", "1.00"));
    expect(res.status).toBe(404);
  });

  test("toda transação aplicada gera eventos na outbox na mesma transação", async () => {
    const wallet = await newWallet("50.00");
    const res = await client.submit(wagerPayload(wallet, "BET", "5.00"));
    const events = await db.sql`select event_type from outbox_messages where aggregate_id in (${res.body.transactionId}, ${wallet.id}) order by event_type`;
    expect(events.map((e: { event_type: string }) => e.event_type)).toEqual(
      expect.arrayContaining(["WagerTransactionProcessed", "WalletBalanceChanged"]),
    );
  });
});

describe("ledger paginado", () => {
  test("cursor opaco e estável percorre tudo sem repetir", async () => {
    const wallet = await newWallet("100.00");
    for (let i = 0; i < 7; i++) await client.submit(wagerPayload(wallet, "BET", "1.00"));
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const qs: string = cursor === null ? "?limit=3" : `?limit=3&cursor=${cursor}`;
      const page = await client.get(`/wallets/${wallet.id}/ledger${qs}`);
      expect(page.status).toBe(200);
      seen.push(...page.body.items.map((i: { id: string }) => i.id));
      cursor = page.body.nextCursor;
    } while (cursor !== null);
    expect(seen).toHaveLength(8);
    expect(new Set(seen).size).toBe(8);
    expect((await client.get(`/wallets/${wallet.id}/ledger?cursor=lixo`)).status).toBe(400);
  });
});

describe("reconciliação", () => {
  test("consistente", async () => {
    const wallet = await newWallet("975.00");
    await client.submit(wagerPayload(wallet, "BET", "75.00"));
    const res = await client.post(`/wallets/${wallet.id}/reconciliation`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      walletId: wallet.id,
      storedBalance: { amount: "900.00", currency: "BRL" },
      calculatedBalance: { amount: "900.00", currency: "BRL" },
      difference: { amount: "0.00", currency: "BRL" },
      consistent: true,
      checkedEntries: 2,
    });
  });

  test("divergência é sinalizada e não corrigida", async () => {
    const wallet = await newWallet("100.00");
    // Adulteração deliberada: só é possível desligando os triggers de proteção.
    await db.sql.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`update wallets set balance = '130.00' where id = ${wallet.id}`;
    });
    const res = await client.post(`/wallets/${wallet.id}/reconciliation`);
    expect(res.body).toMatchObject({ consistent: false, difference: { amount: "30.00" } });
    const after = await client.get(`/wallets/${wallet.id}`);
    expect(after.body.balance.amount).toBe("130.00"); // nada foi "consertado" silenciosamente
    // restaura para a invariante final da suíte
    await db.sql.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`update wallets set balance = '100.00' where id = ${wallet.id}`;
    });
    const metrics = await fetch(`${app.baseUrl}/metrics`).then((r) => r.text());
    expect(metrics).toContain("wallet_reconciliation_divergences_total 1");
  });
});

describe("contrato de observabilidade", () => {
  test("/metrics expõe todas as métricas exigidas", async () => {
    const text = await fetch(`${app.baseUrl}/metrics`).then((r) => r.text());
    for (const name of [
      "wager_transactions_total", // transações por status e origem
      "wager_duplicates_detected_total", // duplicatas (replay de idempotência e inbox)
      "wager_retries_total", // novas tentativas (SQS, outbox, pendências)
      "wager_dlq_messages_total", // envios para a DLQ pelo consumidor
      "wager_dlq_depth", // profundidade real da DLQ (inclui redrive)
      "wager_lock_conflicts_total", // lock timeout e unicidade concorrente
      "outbox_lag_seconds", // idade do evento pendente mais antigo
      "wager_processing_seconds", // latência
      "http_requests_rejected_total", // 400/404/409
      "wallet_reconciliation_divergences_total",
    ]) {
      expect(text).toContain(`# TYPE ${name} `);
    }
  });
});

describe("health", () => {
  test("live e ready", async () => {
    expect((await client.get("/health/live")).body).toEqual({ status: "ok" });
    const ready = await client.get("/health/ready");
    expect(ready.status).toBe(200);
    expect(ready.body.checks).toEqual({ postgres: "up", sqs_wager_queue: "up", sqs_wager_dlq: "up", sqs_events_queue: "up" });
  });
});
