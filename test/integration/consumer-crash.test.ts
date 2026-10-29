import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GetQueueUrlCommand, SendMessageCommand } from "@aws-sdk/client-sqs";
import { loadConfig } from "../../src/infrastructure/config";
import { createSqsClient } from "../../src/infrastructure/messaging/sqs-client";
import { api, wagerPayload } from "../support/app";
import { type TestDatabase, createTestDatabase } from "../support/database";
import { expectLedgerConsistent } from "../support/invariants";
import { type Cluster, startCluster } from "../support/processes";
import { queueDepth, waitFor } from "../support/sqs";

/**
 * O cenário mais perigoso do consumidor, com um processo REAL (`bun src/main.ts`):
 * o COMMIT do débito acontece e o processo morre (SIGKILL) antes do DeleteMessage.
 * A mensagem volta após o visibility timeout; a instância que a recebe encontra o registro
 * na inbox e só confirma. Resultado esperado: um único débito.
 */
let db: TestDatabase;
let cluster: Cluster;

beforeAll(async () => {
  db = await createTestDatabase();
  cluster = await startCluster(db.url, 1, { FAULT_CRASH_AFTER_COMMIT: "true" });
});
afterAll(async () => {
  await cluster?.stopAll();
  await expectLedgerConsistent(db.sql);
  await db?.drop();
});

describe("crash entre o commit e o ack (processo real)", () => {
  test("SIGKILL depois do COMMIT: a redelivery é reconhecida pela inbox e o débito acontece uma vez", async () => {
    const instance = cluster.instances[0]!;
    const client = api(instance.baseUrl);
    const wallet = (await client.createWallet("100.00")).body as { id: string; playerId: string };
    const bet = wagerPayload(wallet, "BET", "40.00");

    const sqs = createSqsClient(loadConfig());
    const queueUrl = (await sqs.send(new GetQueueUrlCommand({ QueueName: cluster.env.WAGER_QUEUE_NAME }))).QueueUrl!;
    const messageId = `msg-${crypto.randomUUID()}`;
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageGroupId: wallet.id,
        MessageDeduplicationId: messageId,
        MessageBody: JSON.stringify({
          messageId,
          type: "WagerTransactionRequested",
          occurredAt: new Date().toISOString(),
          data: { ...bet, idempotencyKey: `${bet.providerId}:${bet.externalTransactionId}` },
        }),
      }),
    );

    // O processo comita e se mata antes do ack.
    const exit = await Promise.race([instance.process.exited, Bun.sleep(20_000).then(() => "timeout" as const)]);
    expect(exit).not.toBe("timeout");
    expect(instance.process.signalCode).toBe("SIGKILL");
    const [committed] = await db.sql`select status from wager_transactions where external_transaction_id = ${bet.externalTransactionId}`;
    expect(committed?.status).toBe("PROCESSED");
    expect((await queueDepth(sqs, queueUrl)).inFlight).toBe(1); // sem ack: a mensagem só está invisível

    // Outra "instância" (a mesma porta, sem a injeção de falha) assume e recebe a redelivery.
    await cluster.restart(0, { FAULT_CRASH_AFTER_COMMIT: "false" });
    await waitFor(async () => {
      const depth = await queueDepth(sqs, queueUrl);
      return depth.visible === 0 && depth.inFlight === 0;
    }, 20_000, "redelivery confirmada");

    const [{ n: debits }] = await db.sql`select count(*)::int as n from wallet_ledger_entries
      where wallet_id = ${wallet.id} and direction = 'DEBIT'`;
    expect(debits).toBe(1);
    expect((await client.get(`/wallets/${wallet.id}`)).body.balance.amount).toBe("60.00");
    const [{ n: inbox }] = await db.sql`select count(*)::int as n from inbox_messages where message_id = ${messageId}`;
    expect(inbox).toBe(1);
  });
});
