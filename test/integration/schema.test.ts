import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import { type TestDatabase, createTestDatabase, expectDbError } from "../support/database";
import { expectLedgerConsistent } from "../support/invariants";

/**
 * Prova que as garantias da seção 6 do desafio estão no schema: o PostgreSQL recusa
 * cada violação mesmo quando a escrita não passa pelo código da aplicação.
 */
let db: TestDatabase;
let sql: SQL;

const HASH = "a".repeat(64);
const NOW = "2026-10-29T12:00:00Z";

beforeAll(async () => {
  db = await createTestDatabase();
  sql = db.sql;
});
afterAll(async () => {
  await expectLedgerConsistent(sql); // invariante final: saldo == ledger em toda wallet que o banco aceitou
  await db?.drop();
});

/** Cria uma wallet com saldo inicial do jeito certo: wallet + OPENING + lançamento, na mesma transação. */
async function openWallet(balance = "100.00", currency = "BRL") {
  const walletId = crypto.randomUUID();
  const playerId = crypto.randomUUID();
  const openingId = crypto.randomUUID();
  await sql.begin(async (tx) => {
    await tx`insert into wallets (id, player_id, currency, balance, version, created_at, updated_at)
             values (${walletId}, ${playerId}, ${currency}, ${balance}, 1, ${NOW}, ${NOW})`;
    if (balance !== "0.00") {
      await insertTx(tx, { id: openingId, walletId, playerId, kind: "OPENING", amount: balance, currency, status: "PROCESSED" });
      await tx`insert into wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, wallet_version, created_at)
               values (${crypto.randomUUID()}, ${walletId}, ${openingId}, 'CREDIT', ${balance}, ${currency}, '0.00', ${balance}, 1, ${NOW})`;
    }
  });
  return { walletId, playerId, openingId };
}

interface TxRow {
  id?: string;
  walletId: string;
  playerId: string;
  kind?: string;
  amount?: string;
  currency?: string;
  status?: string;
  failureCode?: string | null;
  externalId?: string;
  idempotencyKey?: string;
  referenceExternalId?: string | null;
  referenceId?: string | null;
  providerId?: string;
}

async function insertTx(q: SQL, r: TxRow): Promise<string> {
  const id = r.id ?? crypto.randomUUID();
  const externalId = r.externalId ?? `ext-${id}`;
  const status = r.status ?? "PROCESSED";
  const terminal = ["PROCESSED", "REJECTED", "FAILED"].includes(status);
  await q`insert into wager_transactions (
            id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id,
            round_id, game_id, kind, amount, currency, reference_external_transaction_id, reference_transaction_id,
            status, failure_code, processed_at, next_attempt_at, created_at, updated_at)
          values (
            ${id}, ${r.providerId ?? "provider-a"}, ${externalId}, ${r.idempotencyKey ?? `provider-a:${externalId}`}, ${HASH},
            ${r.walletId}, ${r.playerId}, 'round-1', 'game-1', ${r.kind ?? "BET"}, ${r.amount ?? "10.00"}, ${r.currency ?? "BRL"},
            ${r.referenceExternalId ?? null}, ${r.referenceId ?? null}, ${status}, ${r.failureCode ?? null},
            ${terminal ? NOW : null}, ${status === "PENDING_REFERENCE" ? NOW : null}, ${NOW}, ${NOW})`;
  return id;
}

/** Movimento válido: transação + lançamento + atualização de saldo e versão. */
async function debit(walletId: string, playerId: string, amount: string, before: string, after: string, version: number) {
  const txId = crypto.randomUUID();
  await sql.begin(async (tx) => {
    await insertTx(tx, { id: txId, walletId, playerId, kind: "BET", amount });
    await tx`insert into wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, wallet_version, created_at)
             values (${crypto.randomUUID()}, ${walletId}, ${txId}, 'DEBIT', ${amount}, 'BRL', ${before}, ${after}, ${version}, ${NOW})`;
    await tx`update wallets set balance = ${after}, version = ${version}, updated_at = ${NOW} where id = ${walletId}`;
  });
  return txId;
}

describe("migrations", () => {
  test("são reversíveis: down remove tudo e up recria", async () => {
    const scratch = await createTestDatabase({ migrate: false });
    try {
      const all = [
        "Migration20261029170000InitialSchema",
        "Migration20261029190000PendingReferenceWorker",
        "Migration20261030010000OutboxRelayOrder",
        "Migration20261030020000ActiveWinLookup",
      ];
      expect(await scratch.migrateUp()).toEqual(all);
      expect(await scratch.migrateDown()).toEqual([...all].reverse());
      const left = await scratch.sql`select table_name from information_schema.tables
                                     where table_schema = 'public' and table_name <> 'mikro_orm_migrations'`;
      expect(left.length).toBe(0);
      expect(await scratch.migrateUp()).toEqual(all);
    } finally {
      await scratch.drop();
    }
  });
});

describe("wallets", () => {
  test("caminho feliz: abertura + débito consistente é aceito", async () => {
    const { walletId, playerId } = await openWallet("100.00");
    await debit(walletId, playerId, "80.00", "100.00", "20.00", 2);
    const [w] = await sql`select balance, version from wallets where id = ${walletId}`;
    expect(w).toEqual({ balance: "20.00", version: 2 });
  });

  test("no máximo uma wallet por player + moeda", async () => {
    const { playerId } = await openWallet("0.00");
    const msg = await expectDbError(
      sql`insert into wallets (id, player_id, currency, balance, version, created_at, updated_at)
          values (${crypto.randomUUID()}, ${playerId}, 'BRL', '0.00', 1, ${NOW}, ${NOW})`,
    );
    expect(msg).toContain("wallets_player_currency_key");
  });

  test("saldo negativo é recusado", async () => {
    const { walletId } = await openWallet("0.00");
    const msg = await expectDbError(sql`update wallets set balance = '-0.01' where id = ${walletId}`);
    expect(msg).toContain("wallets_balance_check");
  });

  test("saldo inicial sem lançamento de abertura é recusado no commit", async () => {
    const msg = await expectDbError(
      sql`insert into wallets (id, player_id, currency, balance, version, created_at, updated_at)
          values (${crypto.randomUUID()}, ${crypto.randomUUID()}, 'BRL', '50.00', 1, ${NOW}, ${NOW})`,
    );
    expect(msg).toContain("saldo inicial sem lançamento de abertura");
  });

  test("mudar o saldo sem lançamento no ledger é recusado no commit", async () => {
    const { walletId } = await openWallet("100.00");
    const msg = await expectDbError(sql`update wallets set balance = '200.00', version = 2 where id = ${walletId}`);
    expect(msg).toContain("sem lançamento no ledger");
  });

  test("mudar o saldo sem incrementar a versão é recusado", async () => {
    const { walletId } = await openWallet("100.00");
    const msg = await expectDbError(sql`update wallets set balance = '90.00' where id = ${walletId}`);
    expect(msg).toContain("incrementar a versão");
  });

  test("versão não muda se o saldo não muda", async () => {
    const { walletId } = await openWallet("100.00");
    const msg = await expectDbError(sql`update wallets set version = 2 where id = ${walletId}`);
    expect(msg).toContain("versão só muda quando o saldo muda");
  });

  test("wallets não podem ser apagadas", async () => {
    const { walletId } = await openWallet("0.00");
    expect(await expectDbError(sql`delete from wallets where id = ${walletId}`)).toContain("não podem ser apagadas");
  });
});

describe("wallet_ledger_entries", () => {
  test("UPDATE, DELETE e TRUNCATE são bloqueados", async () => {
    await openWallet("10.00");
    expect(await expectDbError(sql`update wallet_ledger_entries set amount = '1.00'`)).toContain("imutável");
    expect(await expectDbError(sql`delete from wallet_ledger_entries`)).toContain("imutável");
    expect(await expectDbError(sql`truncate wallet_ledger_entries cascade`)).toContain("imutável");
  });

  test("aritmética que não fecha é recusada", async () => {
    const { walletId, playerId } = await openWallet("100.00");
    const txId = await insertTx(sql, { walletId, playerId });
    const msg = await expectDbError(
      sql`insert into wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, wallet_version, created_at)
          values (${crypto.randomUUID()}, ${walletId}, ${txId}, 'DEBIT', '10.00', 'BRL', '100.00', '95.00', 2, ${NOW})`,
    );
    expect(msg).toContain("wallet_ledger_entries_balanced");
  });

  test("dois lançamentos para a mesma versão (lost update) são recusados", async () => {
    const { walletId, playerId } = await openWallet("100.00");
    await debit(walletId, playerId, "80.00", "100.00", "20.00", 2);
    const msg = await expectDbError(debit(walletId, playerId, "80.00", "100.00", "20.00", 2));
    expect(msg).toContain("wallet_ledger_entries_wallet_version_key");
  });

  test("no máximo um lançamento por transação por wallet", async () => {
    const { walletId, playerId, openingId } = await openWallet("100.00");
    const msg = await expectDbError(
      sql`insert into wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, wallet_version, created_at)
          values (${crypto.randomUUID()}, ${walletId}, ${openingId}, 'CREDIT', '1.00', 'BRL', '100.00', '101.00', 2, ${NOW})`,
    );
    expect(msg).toContain("wallet_ledger_entries_transaction_wallet_key");
    expect(playerId).toBeString();
  });

  test("moeda do lançamento diferente da wallet é recusada", async () => {
    const { walletId, playerId } = await openWallet("100.00");
    const txId = await insertTx(sql, { walletId, playerId, currency: "USD" });
    const msg = await expectDbError(
      sql`insert into wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, wallet_version, created_at)
          values (${crypto.randomUUID()}, ${walletId}, ${txId}, 'CREDIT', '1.00', 'USD', '100.00', '101.00', 2, ${NOW})`,
    );
    expect(msg).toContain("wallet_ledger_entries_wallet_fk");
  });

  test("saldo negativo no lançamento é recusado", async () => {
    const { walletId, playerId } = await openWallet("10.00");
    const txId = await insertTx(sql, { walletId, playerId });
    const msg = await expectDbError(
      sql`insert into wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, wallet_version, created_at)
          values (${crypto.randomUUID()}, ${walletId}, ${txId}, 'DEBIT', '20.00', 'BRL', '10.00', '-10.00', 2, ${NOW})`,
    );
    expect(msg).toContain("balance_after_check");
  });
});

describe("wager_transactions", () => {
  test("idempotency key é única por provedor (e não colide entre provedores)", async () => {
    const { walletId, playerId } = await openWallet("0.00");
    await insertTx(sql, { walletId, playerId, idempotencyKey: "k-1", externalId: "e-1" });
    const msg = await expectDbError(insertTx(sql, { walletId, playerId, idempotencyKey: "k-1", externalId: "e-2" }));
    expect(msg).toContain("wager_transactions_provider_idempotency_key");
    await insertTx(sql, { walletId, playerId, providerId: "provider-b", idempotencyKey: "k-1", externalId: "e-1" });
  });

  test("(provider, externalTransactionId) é único", async () => {
    const { walletId, playerId } = await openWallet("0.00");
    await insertTx(sql, { walletId, playerId, idempotencyKey: "k-a", externalId: "same" });
    const msg = await expectDbError(insertTx(sql, { walletId, playerId, idempotencyKey: "k-b", externalId: "same" }));
    expect(msg).toContain("wager_transactions_provider_external_key");
  });

  test("REFUND sem referência é recusado", async () => {
    const { walletId, playerId } = await openWallet("0.00");
    const msg = await expectDbError(insertTx(sql, { walletId, playerId, kind: "REFUND" }));
    expect(msg).toContain("wager_transactions_reference_required");
  });

  test("REJECTED exige failure_code", async () => {
    const { walletId, playerId } = await openWallet("0.00");
    const msg = await expectDbError(insertTx(sql, { walletId, playerId, status: "REJECTED", failureCode: null }));
    expect(msg).toContain("wager_transactions_failure_code_consistency");
  });

  test("valor zero ou negativo é recusado", async () => {
    const { walletId, playerId } = await openWallet("0.00");
    expect(await expectDbError(insertTx(sql, { walletId, playerId, amount: "0.00" }))).toContain("amount_check");
  });

  test("estado terminal não muda mais", async () => {
    const { walletId, playerId } = await openWallet("0.00");
    const id = await insertTx(sql, { walletId, playerId, status: "REJECTED", failureCode: "INSUFFICIENT_FUNDS" });
    const msg = await expectDbError(sql`update wager_transactions set status = 'PROCESSED', failure_code = null where id = ${id}`);
    expect(msg).toContain("estado terminal");
  });

  test("PENDING_REFERENCE pode ser concluída, mas campos de negócio não mudam", async () => {
    const { walletId, playerId } = await openWallet("0.00");
    const id = await insertTx(sql, { walletId, playerId, kind: "REFUND", referenceExternalId: "ghost", status: "PENDING_REFERENCE" });
    expect(await expectDbError(sql`update wager_transactions set amount = '99.00' where id = ${id}`)).toContain("imutáveis");
    await sql`update wager_transactions set status = 'REJECTED', failure_code = 'REFERENCE_NOT_FOUND', processed_at = ${NOW} where id = ${id}`;
    const [row] = await sql`select status from wager_transactions where id = ${id}`;
    expect(row.status).toBe("REJECTED");
  });

  test("transações não podem ser apagadas", async () => {
    const { walletId, playerId } = await openWallet("0.00");
    const id = await insertTx(sql, { walletId, playerId, status: "PENDING_REFERENCE", kind: "REFUND", referenceExternalId: "x" });
    expect(await expectDbError(sql`delete from wager_transactions where id = ${id}`)).toContain("append-only");
  });

  test("a mesma referência não pode ser revertida duas vezes (nem por tipos diferentes)", async () => {
    const { walletId, playerId } = await openWallet("0.00");
    const betId = await insertTx(sql, { walletId, playerId, kind: "BET", externalId: "bet-1" });
    await insertTx(sql, { walletId, playerId, kind: "REFUND", referenceExternalId: "bet-1", referenceId: betId });
    const msg = await expectDbError(
      insertTx(sql, { walletId, playerId, kind: "ROLLBACK", referenceExternalId: "bet-1", referenceId: betId }),
    );
    expect(msg).toContain("wager_transactions_single_reversal_idx");
  });

  test("reversões REJECTED da mesma referência não bloqueiam (ficam auditáveis)", async () => {
    const { walletId, playerId } = await openWallet("0.00");
    const betId = await insertTx(sql, { walletId, playerId, kind: "BET", externalId: "bet-2" });
    for (let i = 0; i < 2; i++) {
      await insertTx(sql, {
        walletId, playerId, kind: "REFUND", referenceExternalId: "bet-2", referenceId: betId,
        status: "REJECTED", failureCode: "AMOUNT_MISMATCH",
      });
    }
    const [{ count }] = await sql`select count(*)::int as count from wager_transactions where reference_transaction_id = ${betId}`;
    expect(count).toBe(2);
  });
});

describe("inbox", () => {
  test("(consumer_name, message_id) é único", async () => {
    await sql`insert into inbox_messages (consumer_name, message_id, payload_hash, received_at) values ('c', 'm-1', ${HASH}, ${NOW})`;
    const msg = await expectDbError(
      sql`insert into inbox_messages (consumer_name, message_id, payload_hash, received_at) values ('c', 'm-1', ${HASH}, ${NOW})`,
    );
    expect(msg).toContain("inbox_messages_pkey");
    await sql`insert into inbox_messages (consumer_name, message_id, payload_hash, received_at) values ('other', 'm-1', ${HASH}, ${NOW})`;
  });
});
