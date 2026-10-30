import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { DeleteMessageCommand } from "@aws-sdk/client-sqs";
import { TransientInfrastructureError } from "../../src/application/errors";
import { UNIT_OF_WORK, type TransactionalStore, type UnitOfWork } from "../../src/application/ports";
import { type TestApp, api, startTestApp, wagerPayload } from "../support/app";
import { type TestDatabase, createTestDatabase } from "../support/database";
import { expectLedgerConsistent, expectNoStructuralViolations } from "../support/invariants";
import { buildConsumer, publishWager, queueDepth, receiveAll, sqsOf, waitFor } from "../support/sqs";

/**
 * Consumidor SQS contra PostgreSQL e MiniStack reais. Cada teste usa wallets próprias e as filas
 * são exclusivas desta suíte. Falhas transitórias e "morte do processo" são injetadas por cima
 * da infraestrutura real (o banco e a fila continuam de verdade).
 */
let db: TestDatabase;
let app: TestApp;
let client: ReturnType<typeof api>;

beforeAll(async () => {
  db = await createTestDatabase();
  app = await startTestApp(db.url); // consumidor da aplicação desligado: cada teste controla o seu
  client = api(app.baseUrl);
});
afterAll(async () => {
  await expectLedgerConsistent(db.sql);
  await expectNoStructuralViolations(db.sql);
  await app?.close();
  await db?.drop();
});

async function newWallet(amount = "100.00") {
  return (await client.createWallet(amount)).body as { id: string; playerId: string };
}
const balanceOf = async (walletId: string) => (await client.get(`/wallets/${walletId}`)).body.balance.amount as string;
const txByExternal = async (externalId: string) =>
  (await db.sql`select status, failure_code from wager_transactions where external_transaction_id = ${externalId}`)[0] as
    | { status: string; failure_code: string | null }
    | undefined;
const debits = async (walletId: string) =>
  (await db.sql`select count(*)::int as n from wallet_ledger_entries where wallet_id = ${walletId} and direction = 'DEBIT'`)[0].n as number;

/** Unit of Work que falha de forma transitória nas primeiras N execuções (ex.: banco fora do ar). */
class FlakyUnitOfWork implements UnitOfWork {
  calls = 0;
  constructor(private readonly inner: UnitOfWork, private failures: number) {}
  run<T>(work: (store: TransactionalStore) => Promise<T>): Promise<T> {
    this.calls += 1;
    if (this.failures-- > 0) return Promise.reject(new TransientInfrastructureError("PostgreSQL indisponível (simulado)"));
    return this.inner.run(work);
  }
}

describe("consumidor SQS", () => {
  test("processa a mensagem com o mesmo caso de uso do HTTP e faz ack após o commit", async () => {
    const consumer = buildConsumer(app.app);
    consumer.start();
    try {
      const wallet = await newWallet("100.00");
      const bet = wagerPayload(wallet, "BET", "25.00");
      const messageId = await publishWager(app.app, bet);
      await waitFor(async () => (await txByExternal(bet.externalTransactionId))?.status === "PROCESSED", 15_000, "BET processada");
      expect(await balanceOf(wallet.id)).toBe("75.00");
      const [inbox] = await db.sql`select processed_at is not null as done from inbox_messages where message_id = ${messageId}`;
      expect(inbox.done).toBe(true);
      const { sqs, queues } = sqsOf(app.app);
      await waitFor(async () => {
        const d = await queueDepth(sqs, queues.wagerQueueUrl);
        return d.visible === 0 && d.inFlight === 0;
      }, 10_000, "fila vazia");
    } finally {
      await consumer.stop();
    }
  });

  test("redelivery do mesmo messageId não duplica o efeito (inbox)", async () => {
    const wallet = await newWallet("100.00");
    const bet = wagerPayload(wallet, "BET", "10.00");
    const messageId = `msg-${crypto.randomUUID()}`;
    const occurredAt = new Date().toISOString();
    // Mesmo corpo, três entregas: o que o SQS faz em at-least-once.
    for (let i = 0; i < 3; i++) await publishWager(app.app, bet, { messageId, occurredAt });

    const consumers = [buildConsumer(app.app), buildConsumer(app.app)];
    consumers.forEach((c) => c.start());
    try {
      const { sqs, queues } = sqsOf(app.app);
      await waitFor(async () => {
        const d = await queueDepth(sqs, queues.wagerQueueUrl);
        return d.visible === 0 && d.inFlight === 0 && (await txByExternal(bet.externalTransactionId)) !== undefined;
      }, 15_000, "3 entregas consumidas");
    } finally {
      await Promise.all(consumers.map((c) => c.stop()));
    }
    expect(await debits(wallet.id)).toBe(1);
    expect(await balanceOf(wallet.id)).toBe("90.00");
    const [{ n }] = await db.sql`select count(*)::int as n from inbox_messages where message_id = ${messageId}`;
    expect(n).toBe(1);
  });

  test("messageIds diferentes com a mesma idempotency key → replay, um único efeito", async () => {
    const wallet = await newWallet("100.00");
    const bet = wagerPayload(wallet, "BET", "30.00");
    await publishWager(app.app, bet);
    await publishWager(app.app, bet);
    const consumer = buildConsumer(app.app);
    consumer.start();
    try {
      const { sqs, queues } = sqsOf(app.app);
      await waitFor(async () => {
        const d = await queueDepth(sqs, queues.wagerQueueUrl);
        return d.visible === 0 && d.inFlight === 0 && (await txByExternal(bet.externalTransactionId)) !== undefined;
      }, 15_000, "duas mensagens consumidas");
    } finally {
      await consumer.stop();
    }
    expect(await debits(wallet.id)).toBe(1);
    expect(await balanceOf(wallet.id)).toBe("70.00");
  });

  test("rejeição de negócio é terminal: ack, transação REJECTED gravada, nada na DLQ", async () => {
    const wallet = await newWallet("5.00");
    const bet = wagerPayload(wallet, "BET", "50.00");
    await publishWager(app.app, bet);
    const consumer = buildConsumer(app.app);
    consumer.start();
    try {
      await waitFor(async () => (await txByExternal(bet.externalTransactionId))?.status === "REJECTED", 15_000, "BET rejeitada");
    } finally {
      await consumer.stop();
    }
    expect((await txByExternal(bet.externalTransactionId))?.failure_code).toBe("INSUFFICIENT_FUNDS");
    const { sqs, queues } = sqsOf(app.app);
    const dlq = await receiveAll(sqs, queues.wagerDlqUrl, 0);
    expect(dlq.filter((m) => m.Body?.includes(bet.externalTransactionId))).toHaveLength(0);
  });

  test("erros permanentes vão direto para a DLQ com o motivo", async () => {
    const wallet = await newWallet("100.00");
    await publishWager(app.app, wagerPayload(wallet, "BET", "1.00"), { rawBody: "{ isto não é json" });
    await publishWager(app.app, wagerPayload(wallet, "OPENING", "1.00"));
    await publishWager(app.app, wagerPayload({ id: crypto.randomUUID(), playerId: crypto.randomUUID() }, "BET", "1.00"));
    const consumer = buildConsumer(app.app);
    consumer.start();
    const { sqs, queues } = sqsOf(app.app);
    const reasons: string[] = [];
    try {
      await waitFor(async () => {
        for (const m of await receiveAll(sqs, queues.wagerDlqUrl, 1)) {
          reasons.push(m.MessageAttributes?.failureReason?.StringValue ?? "?");
        }
        return reasons.length >= 3;
      }, 20_000, "3 mensagens na DLQ");
    } finally {
      await consumer.stop();
    }
    expect(reasons.sort()).toEqual(["INVALID_MESSAGE", "INVALID_MESSAGE", "WALLET_NOT_FOUND"]);
    expect(await balanceOf(wallet.id)).toBe("100.00");
  });

  test("erro transitório: volta para a fila e é processado depois, uma única vez", async () => {
    const wallet = await newWallet("100.00");
    const bet = wagerPayload(wallet, "BET", "20.00");
    await publishWager(app.app, bet);
    const flaky = new FlakyUnitOfWork(app.app.get(UNIT_OF_WORK), 2);
    const consumer = buildConsumer(app.app, { uow: flaky });
    consumer.start();
    try {
      await waitFor(async () => (await txByExternal(bet.externalTransactionId))?.status === "PROCESSED", 20_000, "processada após retries");
    } finally {
      await consumer.stop();
    }
    expect(flaky.calls).toBe(3);
    expect(await debits(wallet.id)).toBe(1);
  });

  test("erro transitório persistente: após maxReceiveCount a mensagem vai para a DLQ, sem efeito", async () => {
    const wallet = await newWallet("100.00");
    const bet = wagerPayload(wallet, "BET", "20.00");
    await publishWager(app.app, bet);
    const consumer = buildConsumer(app.app, { uow: new FlakyUnitOfWork(app.app.get(UNIT_OF_WORK), 1_000) });
    consumer.start();
    const { sqs, queues } = sqsOf(app.app);
    try {
      await waitFor(async () => {
        const dlq = await receiveAll(sqs, queues.wagerDlqUrl, 1);
        return dlq.some((m) => m.Body?.includes(bet.externalTransactionId));
      }, 30_000, "mensagem na DLQ via redrive");
    } finally {
      await consumer.stop();
    }
    expect(await txByExternal(bet.externalTransactionId)).toBeUndefined();
    expect(await balanceOf(wallet.id)).toBe("100.00");
  });

  test("processo morre DEPOIS do commit e ANTES do ack: redelivery é reconhecida, efeito único", async () => {
    const wallet = await newWallet("100.00");
    const bet = wagerPayload(wallet, "BET", "40.00");
    const messageId = await publishWager(app.app, bet);

    // Primeiro consumidor: commita e "morre" antes do DeleteMessage.
    const dying = buildConsumer(app.app, { hooks: { afterCommit: async () => { throw new Error("SIGKILL simulado"); } } });
    dying.start();
    await waitFor(async () => (await txByExternal(bet.externalTransactionId))?.status === "PROCESSED", 15_000, "commit do 1º consumidor");
    await dying.stop();
    expect(await balanceOf(wallet.id)).toBe("60.00");

    // Outra instância assume: a mensagem volta após o visibility timeout (2 s).
    const survivor = buildConsumer(app.app);
    survivor.start();
    const { sqs, queues } = sqsOf(app.app);
    try {
      await waitFor(async () => {
        const d = await queueDepth(sqs, queues.wagerQueueUrl);
        return d.visible === 0 && d.inFlight === 0;
      }, 20_000, "redelivery confirmada pelo 2º consumidor");
    } finally {
      await survivor.stop();
    }
    expect(await debits(wallet.id)).toBe(1);
    expect(await balanceOf(wallet.id)).toBe("60.00");
    const [{ n }] = await db.sql`select count(*)::int as n from inbox_messages where message_id = ${messageId}`;
    expect(n).toBe(1);
  });

  test("SIGTERM: stop() conclui a mensagem em andamento e não busca novas", async () => {
    const wallet = await newWallet("100.00");
    const bet = wagerPayload(wallet, "BET", "15.00");
    const inner = app.app.get<UnitOfWork>(UNIT_OF_WORK);
    let entered!: () => void;
    const inside = new Promise<void>((resolve) => (entered = resolve));
    const slow: UnitOfWork = {
      run: (work) => inner.run(async (store) => {
        entered();
        await new Promise((r) => setTimeout(r, 1_000)); // trabalho lento dentro da transação
        return work(store);
      }),
    };
    const consumer = buildConsumer(app.app, { uow: slow });
    consumer.start();
    await publishWager(app.app, bet);
    await inside;
    await consumer.stop(); // chega no meio do processamento
    expect((await txByExternal(bet.externalTransactionId))?.status).toBe("PROCESSED");
    const { sqs, queues } = sqsOf(app.app);
    const d = await queueDepth(sqs, queues.wagerQueueUrl);
    expect(d.visible + d.inFlight).toBe(0); // terminou e fez ack antes de parar

    // Parado não consome: a mensagem nova fica visível na fila, sem ninguém segurando.
    const later = wagerPayload(wallet, "BET", "1.00");
    await publishWager(app.app, later);
    await waitFor(async () => (await queueDepth(sqs, queues.wagerQueueUrl)).visible === 1, 10_000, "mensagem visível na fila");
    expect((await queueDepth(sqs, queues.wagerQueueUrl)).inFlight).toBe(0);
    expect(await txByExternal(later.externalTransactionId)).toBeUndefined();
    await receiveAll(sqs, queues.wagerQueueUrl, 0).then((ms) => Promise.all(ms.map((m) =>
      sqs.send(new DeleteMessageCommand({ QueueUrl: queues.wagerQueueUrl, ReceiptHandle: m.ReceiptHandle }))))); // limpa
  });
});

describe("correções da revisão", () => {
  test("ordem FIFO: se uma mensagem volta para a fila, a seguinte da mesma wallet não passa na frente", async () => {
    const wallet = await newWallet("100.00");
    const first = wagerPayload(wallet, "BET", "10.00");
    const second = wagerPayload(wallet, "BET", "20.00");
    await publishWager(app.app, first);
    await publishWager(app.app, second); // mesmo MessageGroupId (a wallet): chegam no mesmo lote
    const flaky = new FlakyUnitOfWork(app.app.get(UNIT_OF_WORK), 1); // só a primeira tentativa falha
    const consumer = buildConsumer(app.app, { uow: flaky });
    consumer.start();
    try {
      await waitFor(async () => (await txByExternal(second.externalTransactionId))?.status === "PROCESSED", 20_000, "as duas processadas");
      await waitFor(async () => (await txByExternal(first.externalTransactionId))?.status === "PROCESSED", 20_000, "a primeira processada");
    } finally {
      await consumer.stop();
    }
    const versions = await db.sql`select t.external_transaction_id as ext, e.wallet_version as v
      from wallet_ledger_entries e join wager_transactions t on t.id = e.transaction_id
      where e.wallet_id = ${wallet.id} and t.kind = 'BET'`;
    const versionOf = (ext: string) => versions.find((r: { ext: string }) => r.ext === ext)?.v as number;
    expect(versionOf(first.externalTransactionId)).toBeLessThan(versionOf(second.externalTransactionId));
  });

  test("a métrica wager_dlq_depth conta também o que o redrive do SQS moveu para a DLQ", async () => {
    const wallet = await newWallet("100.00");
    const bet = wagerPayload(wallet, "BET", "20.00");
    await publishWager(app.app, bet);
    const consumer = buildConsumer(app.app, { uow: new FlakyUnitOfWork(app.app.get(UNIT_OF_WORK), 1_000) });
    consumer.start();
    try {
      // Ninguém envia para a DLQ pelo código: é o redrive (maxReceiveCount) que move a mensagem.
      await waitFor(async () => {
        const metrics = await fetch(`${app.baseUrl}/metrics`).then((r) => r.text());
        return /^wager_dlq_depth [1-9]/m.test(metrics);
      }, 30_000, "gauge da DLQ ≥ 1");
    } finally {
      await consumer.stop();
    }
    const metrics = await fetch(`${app.baseUrl}/metrics`).then((r) => r.text());
    expect(metrics).not.toMatch(/wager_dlq_messages_total\{reason="TRANSIENT/); // não foi o código que enviou
    expect(await balanceOf(wallet.id)).toBe("100.00");
  });

  test("stop() respeita o shutdownTimeoutMs mesmo com uma mensagem travada", async () => {
    const wallet = await newWallet("100.00");
    const inner = app.app.get<UnitOfWork>(UNIT_OF_WORK);
    let entered!: () => void;
    const inside = new Promise<void>((resolve) => (entered = resolve));
    const stuck: UnitOfWork = {
      run: (work) => inner.run(async (store) => {
        entered();
        await new Promise((r) => setTimeout(r, 4_000)); // bem mais que o limite de 300 ms
        return work(store);
      }),
    };
    const bet = wagerPayload(wallet, "BET", "5.00");
    const consumer = buildConsumer(app.app, { uow: stuck, shutdownTimeoutMs: 300 });
    consumer.start();
    await publishWager(app.app, bet);
    await inside;
    const started = performance.now();
    await consumer.stop();
    expect(performance.now() - started).toBeLessThan(1_500);
    // A mensagem não teve ack: termina na mesma transação e, se o processo morresse, voltaria para a fila.
    await waitFor(async () => (await txByExternal(bet.externalTransactionId))?.status === "PROCESSED", 15_000, "mensagem concluída");
    expect(await debits(wallet.id)).toBe(1);
  });
});

describe("ciclo de vida na aplicação", () => {
  test("com CONSUMER_ENABLED, a aplicação consome sozinha e para no shutdown", async () => {
    const own = await startTestApp(db.url, { consumer: { enabled: true } });
    try {
      const ownClient = api(own.baseUrl);
      const wallet = (await ownClient.createWallet("50.00")).body as { id: string; playerId: string };
      const bet = wagerPayload(wallet, "BET", "5.00");
      await publishWager(own.app, bet);
      await waitFor(async () => (await txByExternal(bet.externalTransactionId))?.status === "PROCESSED", 15_000, "consumo automático");
      expect((await ownClient.get(`/wallets/${wallet.id}`)).body.balance.amount).toBe("45.00");
    } finally {
      await own.close(); // dispara onApplicationShutdown → consumer.stop()
    }
  });
});
