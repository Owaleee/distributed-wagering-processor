import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { InboxMessage } from "../../src/domain/messaging/inbox-message";
import { UNIT_OF_WORK, type UnitOfWork } from "../../src/application/ports";
import { PROCESS_WAGER } from "../../src/interface/http/tokens";
import type { ProcessWagerTransaction } from "../../src/application/wagering/process-wager-transaction";
import { type TestApp, api, startTestApp, wagerPayload } from "../support/app";
import { type TestDatabase, createTestDatabase } from "../support/database";
import { expectLedgerConsistent, expectNoStructuralViolations } from "../support/invariants";

/**
 * Atomicidade entre wallet, transação, ledger, inbox e outbox: se qualquer etapa falhar antes do
 * COMMIT, nada fica gravado — nem o registro da inbox (a mensagem poderá ser reprocessada).
 */
let db: TestDatabase;
let app: TestApp;

beforeAll(async () => {
  db = await createTestDatabase();
  app = await startTestApp(db.url);
});
afterAll(async () => {
  await expectLedgerConsistent(db.sql);
  await expectNoStructuralViolations(db.sql);
  await app?.close();
  await db?.drop();
});

const inbox = () => {
  const message = InboxMessage.receive({
    consumerName: "wager-transactions-consumer", messageId: "msg-atomic", payloadHash: "a".repeat(64), receivedAt: new Date(),
  });
  message.markProcessed(new Date());
  return message;
};

const counts = async () =>
  (await db.sql`select
     (select count(*)::int from wager_transactions where kind <> 'OPENING') as txs,
     (select count(*)::int from wallet_ledger_entries) as entries,
     (select count(*)::int from inbox_messages) as inbox,
     (select count(*)::int from outbox_messages) as outbox`)[0];

describe("atomicidade", () => {
  test("falha depois de inbox + débito + ledger + outbox → rollback completo", async () => {
    const wallet = (await api(app.baseUrl).createWallet("100.00")).body as { id: string; playerId: string };
    const before = await counts();
    const uow = app.app.get<UnitOfWork>(UNIT_OF_WORK);
    const process = app.app.get<ProcessWagerTransaction>(PROCESS_WAGER);
    const bet = { ...wagerPayload(wallet, "BET", "60.00"), idempotencyKey: "atomic-1" };

    await expect(
      uow.run(async (store) => {
        await store.registerInbox(inbox());
        const result = await process.executeIn(store, bet, { correlationId: "c" });
        expect(String(result.status)).toBe("PROCESSED"); // tudo aplicado em memória e no UoW…
        throw new Error("falha simulada antes do COMMIT"); // …e então o processo falha
      }),
    ).rejects.toThrow("falha simulada");

    expect(await counts()).toEqual(before);
    expect((await api(app.baseUrl).get(`/wallets/${wallet.id}`)).body).toMatchObject({ balance: { amount: "100.00" }, version: 1 });

    // A mesma operação, refeita, é aplicada normalmente (nada "meio gravado" bloqueia).
    const retry = await uow.run(async (store) => {
      expect(await store.registerInbox(inbox())).toBe(true);
      return process.executeIn(store, bet, { correlationId: "c" });
    });
    expect(retry).toMatchObject({ status: "PROCESSED", idempotentReplay: false, balance: { amount: "40.00" } });
  });
});
