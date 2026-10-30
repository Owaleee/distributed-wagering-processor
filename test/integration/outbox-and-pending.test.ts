import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { DeleteMessageCommand } from "@aws-sdk/client-sqs";
import type { MikroORM } from "@mikro-orm/postgresql";
import { MikroORM as MikroORMToken } from "@mikro-orm/postgresql";
import { PENDING_REFERENCE_WORKER } from "../../src/app.module";
import { LOGGER, METRICS } from "../../src/application/observability";
import { CLOCK, ID_GENERATOR, UNIT_OF_WORK, type TransactionalStore } from "../../src/application/ports";
import { ProcessWagerTransaction } from "../../src/application/wagering/process-wager-transaction";
import type { WagerTransaction } from "../../src/domain/wagering/wager-transaction";
import { PendingReferenceWorker as Worker } from "../../src/infrastructure/workers/pending-reference-worker";
import { type EventPublisher, SqsEventPublisher } from "../../src/infrastructure/messaging/sqs-event-publisher";
import { OutboxRelay, type OutboxRelayHooks } from "../../src/infrastructure/workers/outbox-relay";
import type { PendingReferenceWorker } from "../../src/infrastructure/workers/pending-reference-worker";
import { type TestApp, api, startTestApp, wagerPayload } from "../support/app";
import { type TestDatabase, createTestDatabase } from "../support/database";
import { expectLedgerConsistent } from "../support/invariants";
import { receiveAll, sqsOf, waitFor } from "../support/sqs";

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

const newWallet = async (amount = "100.00") => (await client.createWallet(amount)).body as { id: string; playerId: string };

function buildRelay(options: { publisher?: EventPublisher; hooks?: OutboxRelayHooks; batchSize?: number } = {}): OutboxRelay {
  const { sqs, queues } = sqsOf(app.app);
  return new OutboxRelay(
    app.app.get<MikroORM>(MikroORMToken),
    options.publisher ?? new SqsEventPublisher(sqs, queues.eventsQueueUrl),
    app.app.get(CLOCK),
    app.app.get(LOGGER),
    app.app.get(METRICS),
    { pollIntervalMs: 50, batchSize: options.batchSize ?? 10 },
    options.hooks,
  );
}

const pendingCount = async () => (await db.sql`select count(*)::int as n from outbox_messages where published_at is null`)[0].n as number;

/** Consome (lê e apaga) todos os eventos publicados na fila de eventos. */
async function drainEvents(): Promise<Array<{ eventId: string; eventType: string }>> {
  const { sqs, queues } = sqsOf(app.app);
  const all: Array<{ eventId: string; eventType: string }> = [];
  for (;;) {
    const batch = await receiveAll(sqs, queues.eventsQueueUrl, 0);
    if (batch.length === 0) break;
    for (const m of batch) {
      all.push(JSON.parse(m.Body ?? "{}"));
      await sqs.send(new DeleteMessageCommand({ QueueUrl: queues.eventsQueueUrl, ReceiptHandle: m.ReceiptHandle }));
    }
  }
  return all;
}

describe("transactional outbox", () => {
  test("eventos gravados no commit são publicados depois, com envelope completo", async () => {
    const wallet = await newWallet("100.00");
    await client.submit(wagerPayload(wallet, "BET", "10.00"));
    expect(await pendingCount()).toBeGreaterThan(0);

    const relay = buildRelay();
    while ((await relay.relayBatch()) > 0) {}
    expect(await pendingCount()).toBe(0);

    const events = await drainEvents();
    const types = events.map((e) => e.eventType);
    expect(types).toEqual(expect.arrayContaining(["WagerTransactionProcessed", "WalletBalanceChanged"]));
    const changed = events.find((e) => e.eventType === "WalletBalanceChanged") as unknown as {
      version: number; correlationId: string; data: { balanceAfter: { amount: string } };
    };
    expect(changed.version).toBe(1);
    expect(typeof changed.correlationId).toBe("string");
  });

  test("dois publishers concorrentes sobre a mesma outbox: cada evento publicado uma vez", async () => {
    const wallets = await Promise.all(Array.from({ length: 5 }, () => newWallet("100.00")));
    await Promise.all(wallets.flatMap((w) => Array.from({ length: 3 }, () => client.submit(wagerPayload(w, "BET", "1.00")))));
    const expected = (await db.sql`select id from outbox_messages where published_at is null`).map((r: { id: string }) => r.id);
    expect(expected.length).toBeGreaterThanOrEqual(30);

    const published: string[][] = [[], []];
    const relays = [0, 1].map((i) =>
      buildRelay({ batchSize: 3, hooks: { afterPublish: async (ids) => void published[i]!.push(...ids) } }),
    );
    relays.forEach((r) => r.start());
    await waitFor(async () => (await pendingCount()) === 0, 20_000, "outbox vazia");
    await Promise.all(relays.map((r) => r.stop()));

    // SKIP LOCKED: os lotes não se sobrepõem — nenhum evento foi publicado pelos dois.
    const both = published[0]!.filter((id) => published[1]!.includes(id));
    expect(both).toHaveLength(0);
    expect(published[0]!.length).toBeGreaterThan(0);
    expect(published[1]!.length).toBeGreaterThan(0);
    const events = await drainEvents();
    const ids = events.map((e) => e.eventId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(expect.arrayContaining(expected));
  });

  test("commit → processo morre antes de marcar → outra instância publica; duplicata é segura", async () => {
    const wallet = await newWallet("100.00");
    await client.submit(wagerPayload(wallet, "BET", "5.00"));
    const pendingIds = (await db.sql`select id from outbox_messages where published_at is null`).map((r: { id: string }) => r.id);

    // 1ª instância: publica e "morre" antes do COMMIT que marca published_at.
    const dying = buildRelay({ hooks: { afterPublish: async () => { throw new Error("SIGKILL simulado"); } } });
    await expect(dying.relayBatch()).rejects.toThrow("SIGKILL simulado");
    expect(await pendingCount()).toBe(pendingIds.length); // rollback: continua pendente

    // 2ª instância assume.
    const survivor = buildRelay();
    while ((await survivor.relayBatch()) > 0) {}
    expect(await pendingCount()).toBe(0);

    // O evento foi publicado (possivelmente duas vezes); o envelope tem o mesmo eventId,
    // e o FIFO ainda descarta a cópia dentro da janela de deduplicação.
    const ids = (await drainEvents()).map((e) => e.eventId);
    expect(ids).toEqual(expect.arrayContaining(pendingIds));
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("SQS indisponível: tentativa agendada com backoff e last_error; depois publica", async () => {
    const wallet = await newWallet("100.00");
    await client.submit(wagerPayload(wallet, "LOSS", "5.00"));
    const down: EventPublisher = {
      publish: async (events) => new Map(events.map((e) => [e.id, "SQS indisponível (simulado)"])),
    };
    await buildRelay({ publisher: down }).relayBatch();
    const [row] = await db.sql`select attempts, last_error, next_attempt_at > now() as later from outbox_messages where published_at is null limit 1`;
    expect(row).toEqual({ attempts: 1, last_error: "SQS indisponível (simulado)", later: true });

    await db.sql`update outbox_messages set next_attempt_at = now() - interval '1 second' where published_at is null`; // acelera o relógio
    while ((await buildRelay().relayBatch()) > 0) {}
    expect(await pendingCount()).toBe(0);
    await drainEvents();
  });
});

describe("referências fora de ordem", () => {
  const worker = () => app.app.get<PendingReferenceWorker>(PENDING_REFERENCE_WORKER);
  const statusOf = async (id: string) =>
    (await db.sql`select status, failure_code, attempts, processing_failures from wager_transactions where id = ${id}`)[0] as {
      status: string; failure_code: string | null; attempts: number; processing_failures: number;
    };
  // "Vencida" bem no passado: now() do PostgreSQL tem microssegundos e o Clock da aplicação, milissegundos;
  // no mesmo milissegundo, now() pareceria estar no futuro para o worker.
  const makeDue = (id: string) => db.sql`update wager_transactions set next_attempt_at = now() - interval '1 second' where id = ${id}`;

  test("ROLLBACK entregue antes da BET: fica pendente e é aplicado quando a BET chega", async () => {
    const wallet = await newWallet("100.00");
    const bet = wagerPayload(wallet, "BET", "30.00");
    const rollback = await client.submit(wagerPayload(wallet, "ROLLBACK", "30.00", { referenceExternalTransactionId: bet.externalTransactionId }));
    expect(rollback.status).toBe(202);

    await makeDue(rollback.body.transactionId);
    expect(await worker().processOne()).toBe(true); // BET ainda não chegou
    expect((await statusOf(rollback.body.transactionId)).status).toBe("PENDING_REFERENCE");

    await client.submit(bet); // chega a referência
    expect((await client.get(`/wallets/${wallet.id}`)).body.balance.amount).toBe("70.00");
    await makeDue(rollback.body.transactionId);
    await worker().processOne();
    const after = await statusOf(rollback.body.transactionId);
    expect(after.status).toBe("PROCESSED");
    expect((await client.get(`/wallets/${wallet.id}`)).body.balance.amount).toBe("100.00");
    const replay = await client.submit(wagerPayload(wallet, "ROLLBACK", "30.00", {
      referenceExternalTransactionId: bet.externalTransactionId,
      externalTransactionId: (await client.get(`/wagering/transactions/${rollback.body.transactionId}`)).body.externalTransactionId,
    }));
    // Replay de uma transação que estava pendente: responde o estado atual (202 → 200).
    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({ status: "PROCESSED", idempotentReplay: true, balance: { amount: "100.00" } });
  });

  test("referência nunca chega: após o limite vira REJECTED/REFERENCE_NOT_FOUND com evento", async () => {
    const wallet = await newWallet("100.00");
    const refund = await client.submit(wagerPayload(wallet, "REFUND", "10.00", { referenceExternalTransactionId: "fantasma" }));
    for (let i = 0; i < 3; i++) {
      await makeDue(refund.body.transactionId);
      await worker().processOne();
    }
    const final = await statusOf(refund.body.transactionId);
    expect(final).toMatchObject({ status: "REJECTED", failure_code: "REFERENCE_NOT_FOUND" });
    const [evt] = await db.sql`select payload->'data'->>'failureCode' as code from outbox_messages
                               where aggregate_id = ${refund.body.transactionId} and event_type = 'WagerTransactionRejected'`;
    expect(evt.code).toBe("REFERENCE_NOT_FOUND");
    expect((await client.get(`/wallets/${wallet.id}`)).body.balance.amount).toBe("100.00");
  });

  test("dois workers em paralelo: cada pendência é resolvida uma única vez", async () => {
    const wallet = await newWallet("0.00");
    const bets = Array.from({ length: 6 }, () => wagerPayload(wallet, "WIN", "5.00"));
    const pendings = await Promise.all(
      bets.map((b) => client.submit(wagerPayload(wallet, "ROLLBACK", "5.00", { referenceExternalTransactionId: b.externalTransactionId }))),
    );
    for (const b of bets) await client.submit(b); // as referências (WIN) chegam: saldo 30.00
    await db.sql`update wager_transactions set next_attempt_at = now() - interval '1 second' where status = 'PENDING_REFERENCE' and wallet_id = ${wallet.id}`;
    const w = worker();
    await Promise.all([
      (async () => { while (await w.processOne()) {} })(),
      (async () => { while (await w.processOne()) {} })(),
    ]);
    for (const p of pendings) expect((await statusOf(p.body.transactionId)).status).toBe("PROCESSED");
    expect((await client.get(`/wallets/${wallet.id}`)).body.balance.amount).toBe("0.00");
    const [{ n }] = await db.sql`select count(*)::int as n from wallet_ledger_entries where wallet_id = ${wallet.id} and direction = 'DEBIT'`;
    expect(n).toBe(6);
  });

  test("a referência chegou: a pendência é acordada na hora, sem esperar o backoff", async () => {
    const wallet = await newWallet("100.00");
    const bet = wagerPayload(wallet, "BET", "20.00");
    const rb = await client.submit(wagerPayload(wallet, "ROLLBACK", "20.00", { referenceExternalTransactionId: bet.externalTransactionId }));
    await db.sql`update wager_transactions set next_attempt_at = now() + interval '1 hour' where id = ${rb.body.transactionId}`;

    await client.submit(bet); // a BET chega: o caso de uso acorda quem esperava por ela
    const [row] = await db.sql`select next_attempt_at <= now() as due from wager_transactions where id = ${rb.body.transactionId}`;
    expect(row.due).toBe(true);
    expect(await worker().processOne()).toBe(true);
    expect((await statusOf(rb.body.transactionId)).status).toBe("PROCESSED");
    expect((await client.get(`/wallets/${wallet.id}`)).body.balance.amount).toBe("100.00");
  });

  test("referência que termina REJECTED também acorda a dependente, que é rejeitada logo", async () => {
    const wallet = await newWallet("10.00");
    const bet = wagerPayload(wallet, "BET", "50.00"); // vai ser rejeitada por saldo
    const refund = await client.submit(wagerPayload(wallet, "REFUND", "50.00", { referenceExternalTransactionId: bet.externalTransactionId }));
    await db.sql`update wager_transactions set next_attempt_at = now() + interval '1 hour' where id = ${refund.body.transactionId}`;

    expect((await client.submit(bet)).status).toBe(422);
    const [row] = await db.sql`select next_attempt_at <= now() as due from wager_transactions where id = ${refund.body.transactionId}`;
    expect(row.due).toBe(true); // acordada sem esperar a hora agendada
    await worker().processOne();
    expect(await statusOf(refund.body.transactionId)).toMatchObject({ status: "REJECTED", failure_code: "REFERENCE_NOT_PROCESSED" });
  });

  test("janela esgotada com a referência ainda pendente → REFERENCE_STILL_PENDING (não REFERENCE_NOT_FOUND)", async () => {
    const wallet = await newWallet("100.00");
    const win = wagerPayload(wallet, "WIN", "10.00", { referenceExternalTransactionId: "bet-que-nunca-chega" }); // fica pendente
    const winRes = await client.submit(win);
    expect(winRes.status).toBe(202);
    const rollback = await client.submit(wagerPayload(wallet, "ROLLBACK", "10.00", { referenceExternalTransactionId: win.externalTransactionId }));
    expect(rollback.status).toBe(202);
    // Só a reavaliação do ROLLBACK roda; o WIN continua pendente.
    await db.sql`update wager_transactions set next_attempt_at = now() + interval '1 hour' where id = ${winRes.body.transactionId}`;
    for (let i = 0; i < 3; i++) {
      await makeDue(rollback.body.transactionId);
      await worker().processOne();
    }
    expect(await statusOf(rollback.body.transactionId)).toMatchObject({ status: "REJECTED", failure_code: "REFERENCE_STILL_PENDING" });
  });

  test("WIN pendente cuja BET chega e é devolvida antes da reavaliação → ALREADY_REVERSED, sem crédito", async () => {
    const wallet = await newWallet("100.00");
    const bet = wagerPayload(wallet, "BET", "10.00");
    const win = await client.submit(wagerPayload(wallet, "WIN", "50.00", { referenceExternalTransactionId: bet.externalTransactionId }));
    expect(win.status).toBe(202);
    await db.sql`update wager_transactions set next_attempt_at = now() + interval '1 hour' where id = ${win.body.transactionId}`;
    await client.submit(bet);
    await client.submit(wagerPayload(wallet, "REFUND", "10.00", { referenceExternalTransactionId: bet.externalTransactionId }));
    await makeDue(win.body.transactionId);
    await worker().processOne();
    expect(await statusOf(win.body.transactionId)).toMatchObject({ status: "REJECTED", failure_code: "ALREADY_REVERSED" });
    expect((await client.get(`/wallets/${wallet.id}`)).body.balance.amount).toBe("100.00");
  });

  test("REFUND pendente cuja BET chega já com WIN pago → REFERENCE_ALREADY_SETTLED na reavaliação", async () => {
    const wallet = await newWallet("100.00");
    const bet = wagerPayload(wallet, "BET", "10.00");
    const refund = await client.submit(wagerPayload(wallet, "REFUND", "10.00", { referenceExternalTransactionId: bet.externalTransactionId }));
    expect(refund.status).toBe(202);
    await db.sql`update wager_transactions set next_attempt_at = now() + interval '1 hour' where id = ${refund.body.transactionId}`;
    await client.submit(bet);
    await client.submit(wagerPayload(wallet, "WIN", "50.00", { referenceExternalTransactionId: bet.externalTransactionId }));
    await makeDue(refund.body.transactionId);
    await worker().processOne();
    expect(await statusOf(refund.body.transactionId)).toMatchObject({ status: "REJECTED", failure_code: "REFERENCE_ALREADY_SETTLED" });
    expect((await client.get(`/wallets/${wallet.id}`)).body.balance.amount).toBe("140.00");
  });

  test("falha de infraestrutura em todas as tentativas → FAILED / PROCESSING_FAILED, auditável e com evento", async () => {
    const wallet = await newWallet("100.00");
    const refund = await client.submit(wagerPayload(wallet, "REFUND", "10.00", { referenceExternalTransactionId: "bet-x" }));

    // Caso de uso que falha sempre ao reavaliar (ex.: um bug ou dado corrompido que derruba a transação).
    class Broken extends ProcessWagerTransaction {
      override async retryPending(_s: TransactionalStore, _t: WagerTransaction): Promise<never> {
        throw new Error("falha permanente simulada");
      }
    }
    const broken = new Broken(app.app.get(UNIT_OF_WORK), app.app.get(CLOCK), app.app.get(ID_GENERATOR), { pendingFirstDelayMs: 0 });
    const w = new Worker(app.app.get(UNIT_OF_WORK), broken, app.app.get(CLOCK), app.app.get(ID_GENERATOR),
      app.app.get(LOGGER), app.app.get(METRICS),
      { pollIntervalMs: 50, maxAttempts: 3, baseDelayMs: 0, batchSize: 1, maxProcessingFailures: 3 });

    for (let i = 0; i < 3; i++) {
      await makeDue(refund.body.transactionId);
      expect(await w.processOne()).toBe(true);
    }
    // As falhas de infraestrutura têm contador próprio: nenhuma tentativa de referência foi gasta.
    expect(await statusOf(refund.body.transactionId)).toMatchObject({
      status: "FAILED", failure_code: "PROCESSING_FAILED", attempts: 0, processing_failures: 3,
    });
    const [evt] = await db.sql`select event_type from outbox_messages where aggregate_id = ${refund.body.transactionId} and event_type = 'WagerTransactionFailed'`;
    expect(evt.event_type).toBe("WagerTransactionFailed");
    expect((await client.get(`/wallets/${wallet.id}`)).body.balance.amount).toBe("100.00");
    // terminal: não é mais reprocessada
    await makeDue(refund.body.transactionId).catch(() => undefined);
    expect(await worker().processOne()).toBe(false);
  });
});

describe("ciclo de vida na aplicação", () => {
  test("com os workers ligados, a aplicação resolve a pendência e publica os eventos sozinha", async () => {
    const own = await startTestApp(db.url, {
      outbox: { enabled: true },
      pendingReference: { enabled: true, maxAttempts: 50 },
    });
    try {
      const ownClient = api(own.baseUrl);
      const wallet = (await ownClient.createWallet("100.00")).body as { id: string; playerId: string };
      const bet = wagerPayload(wallet, "BET", "25.00");
      const rollback = await ownClient.submit(wagerPayload(wallet, "ROLLBACK", "25.00", { referenceExternalTransactionId: bet.externalTransactionId }));
      expect(rollback.status).toBe(202);
      await ownClient.submit(bet);
      await waitFor(async () => {
        const [row] = await db.sql`select status from wager_transactions where id = ${rollback.body.transactionId}`;
        return row.status === "PROCESSED";
      }, 15_000, "pendência resolvida pelo worker");
      expect((await ownClient.get(`/wallets/${wallet.id}`)).body.balance.amount).toBe("100.00");
      await waitFor(async () => {
        const [row] = await db.sql`select count(*)::int as n from outbox_messages
          where published_at is null and (aggregate_id = ${wallet.id} or aggregate_id = ${rollback.body.transactionId})`;
        return row.n === 0;
      }, 15_000, "eventos publicados pelo relay");
    } finally {
      await own.close(); // onApplicationShutdown → workers param
    }
  });
});
