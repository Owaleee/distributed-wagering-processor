import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type TestApp, api, startTestApp, wagerPayload } from "../support/app";
import { type TestDatabase, createTestDatabase } from "../support/database";
import { expectLedgerConsistent, expectNoStructuralViolations } from "../support/invariants";
import { buildConsumer, publishWager, receiveAll, sqsOf, waitFor } from "../support/sqs";

/**
 * Entradas hostis: o que um provedor com bug (ou um atacante) mandaria. Para cada uma:
 * nunca 500, nunca efeito no saldo, sempre o envelope de erro com correlationId.
 */
let db: TestDatabase;
let app: TestApp;
let client: ReturnType<typeof api>;
let wallet: { id: string; playerId: string };

beforeAll(async () => {
  db = await createTestDatabase();
  app = await startTestApp(db.url);
  client = api(app.baseUrl);
  wallet = (await client.createWallet("100.00")).body;
});
afterAll(async () => {
  await expectLedgerConsistent(db.sql);
  await expectNoStructuralViolations(db.sql);
  await app?.close();
  await db?.drop();
});

const balance = async () => (await client.get(`/wallets/${wallet.id}`)).body.balance.amount as string;
const txCount = async () => (await db.sql`select count(*)::int as n from wager_transactions where kind <> 'OPENING'`)[0].n as number;

async function raw(method: string, path: string, body: string | undefined, headers: Record<string, string> = {}) {
  const res = await fetch(`${app.baseUrl}${path}`, { method, headers, ...(body !== undefined ? { body } : {}) });
  const text = await res.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: res.status, json, correlation: res.headers.get("x-correlation-id") };
}

function expectCleanError(res: { status: number; json: any; correlation: string | null }, status: number) {
  expect(res.status).toBe(status);
  expect(typeof res.json?.error?.code).toBe("string");
  expect(typeof res.json?.error?.correlationId).toBe("string");
  expect(res.correlation).toBe(res.json.error.correlationId);
}

describe("valores de dinheiro hostis → 400, sem efeito", () => {
  const amounts: unknown[] = [
    "1e2", " 1.00", "1.00 ", "01.00", "-0.00", "+1.00", "1,00", "1.000", ".50", "1.", "١.٠٠", "0x10", "Infinity",
    "NaN", "1.00\n", "1_000.00", "0.00", "-5.00", "9999999999999999999.99", "", 1, 1.5, 0, -1, null, true, [], {},
    "100000000000000000000.00",
  ];
  test.each(amounts.map((a) => [JSON.stringify(a), a]))("amount %s", async (_label, amount) => {
    const before = await txCount();
    const res = await client.submit(wagerPayload(wallet, "BET", "1.00", { money: { amount: amount as string, currency: "BRL" } }));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_PAYLOAD");
    expect(await txCount()).toBe(before);
  });

  test.each(["brl", "BR", "BRLL", "", "B1L", "R$", null, 1].map((c) => [JSON.stringify(c), c]))("currency %s", async (_l, currency) => {
    const res = await client.submit(wagerPayload(wallet, "BET", "1.00", { money: { amount: "1.00", currency: currency as string } }));
    expect(res.status).toBe(400);
  });
});

describe("campos e formatos hostis → 400", () => {
  const cases: [string, Record<string, unknown>][] = [
    ["kind minúsculo", { kind: "bet" }],
    ["kind interno", { kind: "OPENING" }],
    ["kind com espaço", { kind: "BET " }],
    ["walletId não-UUID", { walletId: "1 or 1=1" }],
    ["playerId não-UUID", { playerId: "player-1" }],
    ["providerId vazio", { providerId: "" }],
    ["providerId reservado", { providerId: "internal" }],
    ["providerId de 129 caracteres", { providerId: "p".repeat(129) }],
    ["externalTransactionId de 129 caracteres", { externalTransactionId: "e".repeat(129) }],
    ["roundId numérico", { roundId: 1 }],
    ["campo extra", { extra: "x" }],
    ["money com campo extra", { money: { amount: "1.00", currency: "BRL", scale: 2 } }],
    ["referência em BET", { referenceExternalTransactionId: "x" }],
    ["byte nulo no externalTransactionId", { externalTransactionId: "a\u0000b" }],
    ["byte nulo no providerId", { providerId: "p\u0000" }],
    ["byte nulo no roundId", { roundId: "r\u0000" }],
  ];
  test.each(cases)("%s", async (_label, override) => {
    const before = await txCount();
    const res = await client.submit({ ...wagerPayload(wallet, "BET", "1.00"), ...override } as never, `hostil-${crypto.randomUUID()}`);
    expect(res.status).toBe(400);
    expect(await txCount()).toBe(before);
  });

  test.each(["providerId", "externalTransactionId", "playerId", "walletId", "roundId", "gameId", "kind", "money"])(
    "sem %s", async (field) => {
      const payload: Record<string, unknown> = { ...wagerPayload(wallet, "BET", "1.00") };
      delete payload[field];
      expect((await client.submit(payload as never)).status).toBe(400);
    },
  );

  test("__proto__ e constructor no corpo não poluem nada e são recusados", async () => {
    const body = `{"__proto__":{"admin":true},"constructor":{"prototype":{"x":1}},${JSON.stringify(wagerPayload(wallet, "BET", "1.00")).slice(1)}`;
    const res = await raw("POST", "/wagering/transactions", body, { "content-type": "application/json", "idempotency-key": "proto-1" });
    expect(res.status).toBe(400);
    expect(({} as Record<string, unknown>).admin).toBeUndefined();
  });

  test.each([
    ["sem header", undefined],
    ["vazia", ""],
    ["257 caracteres", "k".repeat(257)],
  ])("Idempotency-Key %s → 400", async (_l, key) => {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (key !== undefined) headers["idempotency-key"] = key;
    const res = await raw("POST", "/wagering/transactions", JSON.stringify(wagerPayload(wallet, "BET", "1.00")), headers);
    expectCleanError(res, 400);
  });
});

describe("corpos e rotas hostis: erro limpo, nunca 500", () => {
  const H = { "content-type": "application/json", "idempotency-key": "body-1" };
  test.each([
    ["JSON quebrado", "{\"providerId\":", H, 400],
    ["array", "[1,2,3]", H, 400],
    ["string JSON", "\"BET\"", H, 400],
    ["null", "null", H, 400],
    ["corpo vazio", "", H, 400],
    ["text/plain", "BET 10", { ...H, "content-type": "text/plain" }, 400],
    ["corpo de 2 MB", JSON.stringify({ a: "x".repeat(2_000_000) }), H, 413],
  ] as const)("%s", async (_l, body, headers, status) => {
    const before = await txCount();
    expectCleanError(await raw("POST", "/wagering/transactions", body, headers as Record<string, string>), status);
    expect(await txCount()).toBe(before);
  });

  test.each([
    ["GET", "/wallets/not-a-uuid", 404],
    ["GET", "/wallets/00000000-0000-0000-0000-000000000000", 404],
    ["GET", "/wagering/transactions/' or 1=1 --", 404],
    ["GET", "/providers/p/wagering/transactions/%00", 404],
    ["GET", `/wallets/WALLET/ledger?cursor=lixo`, 400],
    ["GET", `/wallets/WALLET/ledger?cursor=${Buffer.from('{"s":"-1"}').toString("base64url")}`, 400],
    ["GET", `/wallets/WALLET/ledger?limit=0`, 400],
    ["GET", `/wallets/WALLET/ledger?limit=1000`, 400],
    ["GET", `/wallets/WALLET/ledger?limit=abc`, 400],
    ["POST", "/wallets/WALLET/reconciliation-x", 404],
    ["DELETE", "/wallets/WALLET", 404],
    ["GET", "/nao-existe", 404],
  ] as const)("%s %s", async (method, path, status) => {
    expectCleanError(await raw(method, path.replace("WALLET", wallet.id), undefined), status);
  });

  test("X-Correlation-Id hostil é trocado por um gerado (nada de injeção em log)", async () => {
    const res = await raw("GET", "/wallets/not-a-uuid", undefined, { "x-correlation-id": "abc\" , \"level\":\"error" });
    expect(res.json.error.correlationId).not.toContain("\"");
  });
});

describe("fuzz aleatório (seed fixa)", () => {
  test("600 corpos aleatórios: só 200/202/400/404/409/422, e o saldo só muda quando 200", async () => {
    let seed = 987654321;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
    const junk = (): unknown => pick([null, true, 0, -1, 1.5, "", "x", "BET", "1.00", "-1.00", [], {}, "😀", "a".repeat(300), wallet.id]);
    const fields = ["providerId", "externalTransactionId", "playerId", "walletId", "roundId", "gameId", "kind", "money", "referenceExternalTransactionId"];
    const seenStatus = new Set<number>();
    for (let i = 0; i < 600; i++) {
      const payload: Record<string, unknown> = { ...wagerPayload(wallet, pick(["BET", "WIN", "LOSS", "REFUND", "ROLLBACK"]), pick(["0.01", "1.00", "500.00"])) };
      for (const f of fields) if (rand() < 0.15) payload[f] = junk();
      if (rand() < 0.1) delete payload[pick(fields)];
      const before = await balance();
      const res = await client.submit(payload as never, rand() < 0.1 ? "repetida" : `fuzz-${i}`);
      seenStatus.add(res.status);
      expect([200, 202, 400, 404, 409, 422]).toContain(res.status);
      if (res.status !== 200) expect(await balance()).toBe(before);
    }
    expect(seenStatus.has(400)).toBe(true);
    expect(seenStatus.has(200)).toBe(true);
  }, 120_000);
});

describe("mensagens SQS hostis", () => {
  test("lixo vai para a DLQ com o motivo; o consumidor segue vivo e processa a próxima mensagem válida", async () => {
    const bodies = [
      "", "{", "null", "[]", "\"x\"", "{}",
      JSON.stringify({ messageId: "m", type: "Outro", occurredAt: "x", data: {} }),
      JSON.stringify({ messageId: "m".repeat(300), type: "WagerTransactionRequested", occurredAt: "x", data: {} }),
      JSON.stringify({ messageId: "m-ok-shape", type: "WagerTransactionRequested", occurredAt: "x",
        data: { ...wagerPayload(wallet, "BET", "1.00"), idempotencyKey: "k", money: { amount: 10, currency: "BRL" } } }),
      JSON.stringify({ messageId: "m-nul", type: "WagerTransactionRequested", occurredAt: "x",
        data: { ...wagerPayload(wallet, "BET", "1.00", { externalTransactionId: "a\u0000b" }), idempotencyKey: "k3" } }),
      JSON.stringify({ messageId: "m-internal", type: "WagerTransactionRequested", occurredAt: "x",
        data: { ...wagerPayload(wallet, "BET", "1.00", { providerId: "internal" }), idempotencyKey: "k2" } }),
    ];
    for (const body of bodies) await publishWager(app.app, wagerPayload(wallet, "BET", "1.00"), { rawBody: body || " " });
    const valid = wagerPayload(wallet, "BET", "2.00");
    await publishWager(app.app, valid);

    const before = await balance();
    const consumer = buildConsumer(app.app);
    consumer.start();
    const { sqs, queues } = sqsOf(app.app);
    const reasons: string[] = [];
    try {
      await waitFor(async () => {
        const [row] = await db.sql`select status from wager_transactions where external_transaction_id = ${valid.externalTransactionId}`;
        return row?.status === "PROCESSED";
      }, 30_000, "mensagem válida processada depois do lixo");
      await waitFor(async () => {
        for (const m of await receiveAll(sqs, queues.wagerDlqUrl, 1)) reasons.push(m.MessageAttributes?.failureReason?.StringValue ?? "?");
        return reasons.length >= bodies.length;
      }, 30_000, "lixo na DLQ");
    } finally {
      await consumer.stop();
    }
    expect(reasons.every((r) => ["INVALID_MESSAGE", "INVALID_PAYLOAD"].includes(r))).toBe(true);
    expect(Number(await balance())).toBe(Number(before) - 2);
  }, 90_000);
});
