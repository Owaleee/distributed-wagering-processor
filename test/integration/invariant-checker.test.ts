import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type TestApp, api, startTestApp, wagerPayload } from "../support/app";
import { type TestDatabase, createTestDatabase } from "../support/database";
import { structuralViolations } from "../support/invariants";

/**
 * Testa o verificador de invariantes: um verificador que nunca acusa nada também "passaria".
 * Cada adulteração aqui só é possível desligando os triggers de proteção (session_replication_role).
 */
let db: TestDatabase;
let app: TestApp;
let client: ReturnType<typeof api>;

beforeAll(async () => {
  db = await createTestDatabase();
  app = await startTestApp(db.url);
  client = api(app.baseUrl);
});
afterAll(async () => {
  await app?.close();
  await db?.drop();
});

async function tamper(statement: (tx: Bun.SQL) => Promise<unknown>) {
  await db.sql.begin(async (tx) => {
    await tx`set local session_replication_role = replica`;
    await statement(tx);
  });
}

describe("verificador de invariantes estruturais", () => {
  test("um banco produzido só pela aplicação não tem violações", async () => {
    const wallet = (await client.createWallet("100.00")).body;
    const bet = wagerPayload(wallet, "BET", "10.00");
    await client.submit(bet);
    await client.submit(wagerPayload(wallet, "WIN", "25.00", { referenceExternalTransactionId: bet.externalTransactionId }));
    await client.submit(wagerPayload(wallet, "LOSS", "5.00"));
    await client.submit(wagerPayload(wallet, "BET", "999.00"));
    expect(await structuralViolations(db.sql)).toEqual({});
  });

  test("detecta saldo adulterado, corrente quebrada, evento faltando e crédito em dobro", async () => {
    const wallet = (await client.createWallet("100.00")).body;
    const bet = wagerPayload(wallet, "BET", "10.00");
    const betRes = await client.submit(bet);
    const winRes = await client.submit(wagerPayload(wallet, "WIN", "30.00", { referenceExternalTransactionId: bet.externalTransactionId }));

    await tamper((tx) => tx`update wallets set balance = balance + 1 where id = ${wallet.id}`);
    await tamper((tx) => tx`update wallet_ledger_entries set balance_before = balance_before + 1, balance_after = balance_after + 1
                             where transaction_id = ${winRes.body.transactionId}`);
    await tamper((tx) => tx`delete from outbox_messages where aggregate_id = ${betRes.body.transactionId}`);
    // Um REFUND "processado" da BET com o WIN mantido: o crédito em dobro que a regra impede.
    await tamper((tx) => tx`insert into wager_transactions
        (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id, round_id, game_id,
         kind, amount, currency, reference_external_transaction_id, reference_transaction_id, status, processed_at,
         attempts, processing_failures, created_at, updated_at)
      values (${crypto.randomUUID()}, 'provider-a', ${`forged-${crypto.randomUUID()}`}, ${`forged-${crypto.randomUUID()}`},
              ${"0".repeat(64)}, ${wallet.id}, ${wallet.playerId}, 'round-1', 'fortune-chimp', 'REFUND', '10.00', 'BRL',
              ${bet.externalTransactionId}, ${betRes.body.transactionId}, 'PROCESSED', now(), 0, 0, now(), now())`);

    const found = Object.keys(await structuralViolations(db.sql));
    expect(found).toEqual(expect.arrayContaining([
      "saldo != soma do ledger",
      "corrente quebrada (antes != depois do anterior)",
      "transação sem o evento do seu estado na outbox",
      "BET devolvida com prêmio pago e mantido (crédito em dobro)",
      "transação que mexe no saldo sem exatamente 1 lançamento",
    ]));
  });
});
