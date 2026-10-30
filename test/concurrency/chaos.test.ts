import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GetQueueUrlCommand, SendMessageCommand } from "@aws-sdk/client-sqs";
import { loadConfig } from "../../src/infrastructure/config";
import { createSqsClient } from "../../src/infrastructure/messaging/sqs-client";
import { type WagerPayload, api } from "../support/app";
import { type TestDatabase, createTestDatabase } from "../support/database";
import { expectLedgerConsistent, structuralViolations } from "../support/invariants";
import { type Cluster, startCluster } from "../support/processes";
import { queueDepth, waitFor } from "../support/sqs";

/**
 * Caos: 3 processos reais com HTTP, consumidor, outbox e worker de pendências ligados.
 * Operações aleatórias (seed fixa) chegam AO MESMO TEMPO por HTTP (instâncias sorteadas) e por SQS,
 * com a mesma operação pelos dois canais, mensagens repetidas, reversões antes da aposta e um
 * SIGKILL de uma instância no meio. A ordem final é imprevisível, então não há oráculo: o que se
 * exige são propriedades que valem em QUALQUER ordem.
 */
let db: TestDatabase;
let cluster: Cluster;
const sqs = createSqsClient(loadConfig());

beforeAll(async () => {
  db = await createTestDatabase();
  cluster = await startCluster(db.url, 3, { PENDING_REFERENCE_MAX_ATTEMPTS: "40", PENDING_REFERENCE_POLL_INTERVAL_MS: "100" });
});
afterAll(async () => {
  await cluster?.stopAll();
  await db?.drop();
});

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const at = (i: number) => api(cluster.instances[i % cluster.instances.length]!.baseUrl);

/** Como um provedor real: em 503 ou erro de rede, reenvia com a MESMA chave em outra instância. */
async function submitWithRetry(payload: WagerPayload, key: string, startAt: number) {
  for (let i = 0; i < 40; i++) {
    try {
      const res = await at(startAt + i).submit(payload, key);
      if (res.status !== 503) return res;
    } catch {
      // instância fora do ar
    }
    await Bun.sleep(100);
  }
  throw new Error(`não foi possível enviar ${payload.externalTransactionId}`);
}

describe("caos concorrente", () => {
  test("HTTP + SQS + duplicatas + fora de ordem + SIGKILL: nenhuma operação com dois efeitos, banco íntegro", async () => {
    const rand = mulberry32(20261030);
    const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
    const chance = (p: number) => rand() < p;
    const queueUrl = (await sqs.send(new GetQueueUrlCommand({ QueueName: cluster.env.WAGER_QUEUE_NAME }))).QueueUrl!;

    const wallets = await Promise.all(
      Array.from({ length: 6 }, async () => (await at(0).createWallet("200.00")).body as { id: string; playerId: string }),
    );

    // 1) Monta as operações: rodadas com BET, às vezes WIN da BET, às vezes REFUND/ROLLBACK de uma delas.
    const ops: { payload: WagerPayload; key: string }[] = [];
    let n = 0;
    for (const w of wallets) {
      for (let r = 0; r < 18; r++) {
        const round = `round-${r}`;
        const base = { providerId: "chaos", playerId: w.playerId, walletId: w.id, roundId: round, gameId: "g" };
        const bet = { ...base, externalTransactionId: `bet-${n++}`, kind: "BET", money: { amount: pick(["1.00", "5.00", "20.00", "45.00"]), currency: "BRL" } };
        ops.push({ payload: bet, key: `k-${bet.externalTransactionId}` });
        if (chance(0.5)) {
          const win = { ...base, externalTransactionId: `win-${n++}`, kind: "WIN", money: { amount: pick(["2.00", "10.00", "60.00"]), currency: "BRL" },
            referenceExternalTransactionId: bet.externalTransactionId };
          ops.push({ payload: win, key: `k-${win.externalTransactionId}` });
          if (chance(0.3)) {
            const rb = { ...base, externalTransactionId: `rbw-${n++}`, kind: "ROLLBACK", money: win.money, referenceExternalTransactionId: win.externalTransactionId };
            ops.push({ payload: rb, key: `k-${rb.externalTransactionId}` });
          }
        }
        if (chance(0.35)) {
          const kind = pick(["REFUND", "ROLLBACK"]);
          const rev = { ...base, externalTransactionId: `rev-${n++}`, kind, money: bet.money, referenceExternalTransactionId: bet.externalTransactionId };
          ops.push({ payload: rev, key: `k-${rev.externalTransactionId}` });
        }
        if (chance(0.15)) {
          const loss = { ...base, externalTransactionId: `loss-${n++}`, kind: "LOSS", money: bet.money };
          ops.push({ payload: loss, key: `k-${loss.externalTransactionId}` });
        }
      }
    }
    // Embaralha: reversões e WINs chegam muitas vezes antes da BET (fora de ordem).
    for (let i = ops.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [ops[i], ops[j]] = [ops[j]!, ops[i]!];
    }

    // 2) Dispara tudo ao mesmo tempo, por canais sorteados, com duplicatas.
    const responses = new Map<string, { status: number; transactionId?: string; replay?: boolean }[]>();
    const record = (ext: string, r: { status: number; body: { transactionId?: string; idempotentReplay?: boolean } }) => {
      const list = responses.get(ext) ?? [];
      list.push({ status: r.status, transactionId: r.body?.transactionId, replay: r.body?.idempotentReplay });
      responses.set(ext, list);
    };
    const publish = async (op: { payload: WagerPayload; key: string }, messageId: string) =>
      sqs.send(new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageGroupId: op.payload.walletId,
        MessageDeduplicationId: crypto.randomUUID(), // o broker não filtra: simula at-least-once
        MessageBody: JSON.stringify({ messageId, type: "WagerTransactionRequested", occurredAt: new Date().toISOString(),
          data: { ...op.payload, idempotencyKey: op.key } }),
      }));

    let killed = false;
    const sends = ops.map(async (op, i) => {
      await Bun.sleep(Math.floor(rand() * 400));
      const channel = rand();
      if (channel < 0.45) {
        record(op.payload.externalTransactionId, await submitWithRetry(op.payload, op.key, i));
      } else if (channel < 0.75) {
        const messageId = `m-${op.payload.externalTransactionId}`;
        await publish(op, messageId);
        if (chance(0.4)) await publish(op, messageId); // a mesma mensagem entregue de novo
      } else {
        // a mesma operação pelos DOIS canais
        await publish(op, `m-${op.payload.externalTransactionId}`);
        record(op.payload.externalTransactionId, await submitWithRetry(op.payload, op.key, i));
      }
      if (!killed && i === Math.floor(ops.length / 2)) {
        killed = true;
        await cluster.kill(1, "SIGKILL"); // no meio da carga, com mensagens em andamento
      }
    });
    await Promise.all(sends);
    await cluster.restart(1);

    // 3) Espera assentar: fila vazia, nenhuma pendência, outbox drenada.
    await waitFor(async () => {
      const depth = await queueDepth(sqs, queueUrl);
      const [{ pending }] = await db.sql`select count(*)::int as pending from wager_transactions where status = 'PENDING_REFERENCE'`;
      const [{ unpublished }] = await db.sql`select count(*)::int as unpublished from outbox_messages where published_at is null`;
      return depth.visible === 0 && depth.inFlight === 0 && pending === 0 && unpublished === 0;
    }, 120_000, "sistema assentado");

    // 4) Propriedades que valem em qualquer ordem.
    const [{ total }] = await db.sql`select count(*)::int as total from wager_transactions where provider_id = 'chaos'`;
    expect(total).toBe(ops.length); // cada operação lógica existe uma única vez, venha por onde vier

    for (const [ext, list] of responses) {
      const ids = new Set(list.filter((r) => r.transactionId !== undefined).map((r) => r.transactionId));
      expect({ ext, ids: ids.size }).toEqual({ ext, ids: 1 }); // todas as respostas falam da MESMA transação
      expect(list.every((r) => [200, 202, 422].includes(r.status))).toBe(true); // nenhum 500, nenhum 409
    }
    const [{ inboxDup }] = await db.sql`select count(*)::int as "inboxDup" from (
      select message_id from inbox_messages group by consumer_name, message_id having count(*) > 1) d`;
    expect(inboxDup).toBe(0);

    await expectLedgerConsistent(db.sql);
    expect(await structuralViolations(db.sql)).toEqual({});

    const summary = await db.sql`select status, coalesce(failure_code, '-') as code, count(*)::int as n
      from wager_transactions where provider_id = 'chaos' group by 1, 2 order by 1, 2`;
    console.log(`caos: ${ops.length} operações`, JSON.stringify(summary));
  }, 300_000);
});
