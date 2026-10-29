import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GetQueueUrlCommand, SendMessageCommand } from "@aws-sdk/client-sqs";
import { loadConfig } from "../../src/infrastructure/config";
import { createSqsClient } from "../../src/infrastructure/messaging/sqs-client";
import { type WagerPayload, api, wagerPayload } from "../support/app";
import { type TestDatabase, createTestDatabase } from "../support/database";
import { expectLedgerConsistent } from "../support/invariants";
import { type Cluster, startCluster } from "../support/processes";
import { waitFor } from "../support/sqs";

/**
 * Três processos independentes da aplicação (HTTP + consumidor SQS + outbox + worker de pendentes
 * em cada um), o mesmo PostgreSQL e as mesmas filas. Cobre os cenários 4 e 8 da seção 13:
 * ≥ 3 instâncias simultâneas e reinício do serviço com consistência final comprovada.
 * Os provedores reenviam em 503 ou erro de rede, sempre com a mesma Idempotency-Key.
 */
let db: TestDatabase;
let cluster: Cluster;
const sqs = createSqsClient(loadConfig());

beforeAll(async () => {
  db = await createTestDatabase();
  cluster = await startCluster(db.url, 3);
});
afterAll(async () => {
  await cluster?.stopAll();
  await db?.drop();
});

const at = (i: number) => api(cluster.instances[i % cluster.instances.length]!.baseUrl);

async function newWallet(amount: string) {
  const res = await at(0).createWallet(amount);
  expect(res.status).toBe(201);
  return res.body as { id: string; playerId: string };
}

/** Envia como um provedor faria: em erro de rede ou 503, reenvia com a MESMA key (em outra instância). */
async function submitWithRetry(payload: WagerPayload, startAt: number, attempts = 6) {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await at(startAt + i).submit(payload);
      if (res.status !== 503) return res;
    } catch {
      // instância fora do ar: tenta a próxima
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("não foi possível submeter a transação");
}

async function publish(data: WagerPayload, messageId = `msg-${crypto.randomUUID()}`) {
  const { QueueUrl } = await sqs.send(new GetQueueUrlCommand({ QueueName: cluster.env.WAGER_QUEUE_NAME }));
  await sqs.send(
    new SendMessageCommand({
      QueueUrl,
      MessageBody: JSON.stringify({
        messageId, type: "WagerTransactionRequested", occurredAt: "2026-10-29T12:00:00.000Z",
        data: { ...data, idempotencyKey: `${data.providerId}:${data.externalTransactionId}` },
      }),
      MessageGroupId: data.walletId,
      MessageDeduplicationId: crypto.randomUUID(),
    }),
  );
}

const balance = async (walletId: string) => (await at(2).get(`/wallets/${walletId}`)).body.balance.amount as string;
const count = async (q: string) => (await db.sql.unsafe(q))[0].n as number;

describe("três instâncias simultâneas", () => {
  test("hot wallet disputada pelas 3 instâncias, com cada aposta enviada em duplicata", async () => {
    const wallet = await newWallet("300.00");
    const bets = Array.from({ length: 60 }, () => wagerPayload(wallet, "BET", "10.00"));
    // cada aposta vai para duas instâncias diferentes ao mesmo tempo
    const results = await Promise.all(bets.flatMap((b, i) => [at(i).submit(b), at(i + 1).submit(b)]));

    const byTx = new Map(results.map((r) => [r.body.transactionId, r.body.status]));
    expect(byTx.size).toBe(60);
    expect([...byTx.values()].filter((s) => s === "PROCESSED")).toHaveLength(30);
    expect([...byTx.values()].filter((s) => s === "REJECTED")).toHaveLength(30);
    expect(await balance(wallet.id)).toBe("0.00");
    expect(await count(`select count(*)::int as n from wallet_ledger_entries where wallet_id = '${wallet.id}' and direction = 'DEBIT'`)).toBe(30);
    await expectLedgerConsistent(db.sql, wallet.id);
  });

  test("mensagens SQS consumidas pelas 3 instâncias: redeliveries não duplicam efeitos", async () => {
    const wallets = await Promise.all([newWallet("100.00"), newWallet("100.00"), newWallet("100.00")]);
    const ops = wallets.flatMap((w) => Array.from({ length: 10 }, () => wagerPayload(w, "BET", "3.00")));
    for (const op of ops) {
      const messageId = `msg-${crypto.randomUUID()}`;
      await publish(op, messageId);
      await publish(op, messageId); // a mesma mensagem entregue duas vezes
    }
    await waitFor(async () => {
      const n = await count(
        `select count(*)::int as n from wager_transactions where wallet_id in ('${wallets.map((w) => w.id).join("','")}') and kind = 'BET'`,
      );
      return n === 30;
    }, 30_000, "30 BETs processadas via SQS");
    for (const w of wallets) expect(await balance(w.id)).toBe("70.00");
    await expectLedgerConsistent(db.sql);
  });
});

describe("falha e reinício", () => {
  test("SIGKILL de uma instância no meio da carga; após reiniciar, tudo fecha", async () => {
    const wallets = await Promise.all(Array.from({ length: 4 }, () => newWallet("1000.00")));
    const ops = wallets.flatMap((w) => Array.from({ length: 25 }, (_, i) =>
      wagerPayload(w, i % 5 === 4 ? "WIN" : "BET", i % 5 === 4 ? "7.50" : "12.25"),
    ));

    const inflight = ops.map((op, i) => submitWithRetry(op, i));
    // Mata no meio da carga: assim que as primeiras operações tiverem sido gravadas (condição, não tempo).
    const ids = wallets.map((w) => `'${w.id}'`).join(",");
    await waitFor(async () => (await count(`select count(*)::int as n from wager_transactions
      where wallet_id in (${ids}) and kind <> 'OPENING'`)) > 0, 10_000, "carga começou");
    await cluster.kill(1, "SIGKILL"); // morte abrupta: sem shutdown gracioso
    await Promise.all(inflight);
    await cluster.restart(1);

    // Provedor reenvia tudo (não sabe o que foi aplicado): replays, nenhum efeito novo.
    const replays = await Promise.all(ops.map((op, i) => submitWithRetry(op, i)));
    expect(replays.every((r) => r.body.idempotentReplay === true)).toBe(true);

    // 20 BETs de 12.25 e 5 WINs de 7.50 por wallet: 1000 − 245 + 37.50 = 792.50
    for (const w of wallets) expect(await balance(w.id)).toBe("792.50");
    await expectLedgerConsistent(db.sql);

    // Eventos confirmados nunca se perdem: a outbox drena mesmo com a instância que morreu.
    await waitFor(async () => (await count(`select count(*)::int as n from outbox_messages where published_at is null`)) === 0,
      30_000, "outbox drenada");
  });

  test("SIGKILL de uma instância consumindo a fila; as outras assumem e cada mensagem tem efeito único", async () => {
    const wallets = await Promise.all([newWallet("100.00"), newWallet("100.00"), newWallet("100.00")]);
    const ops = wallets.flatMap((w) => Array.from({ length: 20 }, () => wagerPayload(w, "BET", "2.50")));
    for (const op of ops) await publish(op);
    const ids = wallets.map((w) => `'${w.id}'`).join(",");
    const applied = () => count(`select count(*)::int as n from wager_transactions where wallet_id in (${ids}) and kind = 'BET'`);

    await waitFor(async () => (await applied()) > 0, 15_000, "consumo começou");
    await cluster.kill(0, "SIGKILL"); // mensagens dela em andamento voltam após o visibility timeout
    await waitFor(async () => (await applied()) === 60, 45_000, "60 BETs aplicadas pelas instâncias restantes");
    await cluster.restart(0);

    for (const w of wallets) expect(await balance(w.id)).toBe("50.00");
    expect(await count(`select count(*)::int as n from wallet_ledger_entries where wallet_id in (${ids}) and direction = 'DEBIT'`)).toBe(60);
    await expectLedgerConsistent(db.sql);
  });

  test("fora de ordem entre instâncias: ROLLBACK numa, BET noutra, worker de qualquer uma resolve", async () => {
    const wallet = await newWallet("100.00");
    const bet = wagerPayload(wallet, "BET", "40.00");
    const rollback = await at(0).submit(wagerPayload(wallet, "ROLLBACK", "40.00", { referenceExternalTransactionId: bet.externalTransactionId }));
    expect(rollback.status).toBe(202);
    expect((await at(1).submit(bet)).status).toBe(200);
    await waitFor(async () => (await at(2).get(`/wagering/transactions/${rollback.body.transactionId}`)).body.status === "PROCESSED",
      15_000, "ROLLBACK resolvido");
    expect(await balance(wallet.id)).toBe("100.00");
    await expectLedgerConsistent(db.sql, wallet.id);
  });

  test("SIGTERM encerra a instância de forma graciosa (exit 0) e as outras seguem atendendo", async () => {
    const code = await cluster.kill(2, "SIGTERM");
    expect(code).toBe(0);
    const wallet = await newWallet("10.00");
    const res = await at(0).submit(wagerPayload(wallet, "BET", "1.00"));
    expect(res.status).toBe(200);
    await cluster.restart(2);
    expect((await at(2).get(`/wallets/${wallet.id}`)).body.balance.amount).toBe("9.00");
  });
});
