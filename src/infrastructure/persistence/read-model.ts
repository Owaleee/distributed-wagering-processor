import type { MikroORM } from "@mikro-orm/postgresql";
import type { MoneyProps } from "../../domain/money/money";
import { hasNulByte } from "../../interface/text";
import { translateDbError } from "./db-errors";

export interface TransactionView {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: MoneyProps;
  status: string;
  failureCode?: string;
  referenceExternalTransactionId?: string;
  referenceTransactionId?: string;
  balance?: MoneyProps;
  createdAt: string;
  processedAt?: string;
}

export interface LedgerEntryView {
  id: string;
  transactionId: string;
  direction: string;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
  createdAt: string;
}

export interface WalletRow {
  id: string;
  playerId: string;
  balance: MoneyProps;
  version: number;
}

export interface ReconciliationSnapshot {
  walletId: string;
  storedBalance: MoneyProps;
  calculatedBalance: MoneyProps;
  difference: MoneyProps;
  checkedEntries: number;
}

/**
 * Consultas de leitura em SQL direto: não precisam do Identity Map nem de entidades de domínio,
 * e o SQL deixa explícito o que é lido (ordem estável do ledger, soma da reconciliação).
 */
export class ReadModel {
  constructor(private readonly orm: MikroORM) {}

  async wallet(walletId: string): Promise<WalletRow | undefined> {
    if (!UUID.test(walletId)) return undefined;
    const [row] = await this.query<{ id: string; player_id: string; balance: string; currency: string; version: number }>(
      `select id, player_id, balance, currency, version from wallets where id = ?`,
      [walletId],
    );
    return row === undefined
      ? undefined
      : { id: row.id, playerId: row.player_id, balance: { amount: row.balance, currency: row.currency }, version: row.version };
  }

  async transactionById(transactionId: string): Promise<TransactionView | undefined> {
    if (!UUID.test(transactionId)) return undefined;
    const [row] = await this.query<TxRow>(`select * from wager_transactions where id = ?`, [transactionId]);
    return row === undefined ? undefined : toTransactionView(row);
  }

  async transactionByExternalId(providerId: string, externalTransactionId: string): Promise<TransactionView | undefined> {
    // Um id com byte nulo não pode existir no banco (e quebraria o protocolo do driver): não encontrado.
    if (hasNulByte(providerId, externalTransactionId)) return undefined;
    const [row] = await this.query<TxRow>(
      `select * from wager_transactions where provider_id = ? and external_transaction_id = ?`,
      [providerId, externalTransactionId],
    );
    return row === undefined ? undefined : toTransactionView(row);
  }

  /** Página do ledger em ordem de gravação (`seq`), a partir do cursor. Estável: o ledger só cresce. */
  async ledgerPage(walletId: string, afterSeq: bigint, limit: number): Promise<{ entries: LedgerEntryView[]; lastSeq?: bigint; hasMore: boolean }> {
    const rows = await this.query<LedgerRow>(
      `select id, seq::text as seq, transaction_id, direction, amount, currency, balance_before, balance_after, wallet_version, created_at
         from wallet_ledger_entries
        where wallet_id = ? and seq > ?
        order by seq asc
        limit ?`,
      [walletId, afterSeq.toString(), limit + 1],
    );
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      entries: page.map((r) => ({
        id: r.id,
        transactionId: r.transaction_id,
        direction: r.direction,
        money: { amount: r.amount, currency: r.currency },
        balanceBefore: { amount: r.balance_before, currency: r.currency },
        balanceAfter: { amount: r.balance_after, currency: r.currency },
        walletVersion: r.wallet_version,
        createdAt: new Date(r.created_at).toISOString(),
      })),
      ...(last !== undefined ? { lastSeq: BigInt(last.seq) } : {}),
      hasMore: rows.length > limit,
    };
  }

  /**
   * Compara o saldo materializado com o saldo reconstruído pelo ledger, numa mesma foto do banco:
   * `FOR SHARE` na wallet impede que um movimento seja gravado no meio da contagem.
   * A aritmética é feita pelo PostgreSQL em NUMERIC (exata).
   */
  async reconciliationSnapshot(walletId: string): Promise<ReconciliationSnapshot | undefined> {
    if (!UUID.test(walletId)) return undefined;
    try {
      return await this.orm.em.fork().transactional(async (em) => {
        const rows = await em.execute<{ balance: string; currency: string }[]>(
          `select balance, currency from wallets where id = ? for share`,
          [walletId],
        );
        const wallet = rows[0];
        if (wallet === undefined) return undefined;
        const [agg] = await em.execute<{ calculated: string; entries: number; difference: string }[]>(
          `select coalesce(sum(case when direction = 'CREDIT' then amount else -amount end), 0)::numeric(20,2)::text as calculated,
                  count(*)::int as entries,
                  (?::numeric(20,2) - coalesce(sum(case when direction = 'CREDIT' then amount else -amount end), 0))::numeric(20,2)::text as difference
             from wallet_ledger_entries where wallet_id = ?`,
          [wallet.balance, walletId],
        );
        return {
          walletId,
          storedBalance: { amount: wallet.balance, currency: wallet.currency },
          calculatedBalance: { amount: agg?.calculated ?? "0.00", currency: wallet.currency },
          difference: { amount: agg?.difference ?? "0.00", currency: wallet.currency },
          checkedEntries: agg?.entries ?? 0,
        };
      });
    } catch (error) {
      throw translateDbError(error);
    }
  }

  private async query<T>(sql: string, params: unknown[]): Promise<T[]> {
    try {
      return await this.orm.em.fork().getConnection().execute<T[]>(sql, params);
    } catch (error) {
      throw translateDbError(error);
    }
  }
}

interface TxRow {
  id: string;
  provider_id: string;
  external_transaction_id: string;
  wallet_id: string;
  player_id: string;
  round_id: string;
  game_id: string;
  kind: string;
  amount: string;
  currency: string;
  status: string;
  failure_code: string | null;
  reference_external_transaction_id: string | null;
  reference_transaction_id: string | null;
  observed_balance: string | null;
  observed_currency: string | null;
  created_at: Date | string;
  processed_at: Date | string | null;
}

interface LedgerRow {
  id: string;
  seq: string;
  transaction_id: string;
  direction: string;
  amount: string;
  currency: string;
  balance_before: string;
  balance_after: string;
  wallet_version: number;
  created_at: Date | string;
}

function toTransactionView(r: TxRow): TransactionView {
  return {
    transactionId: r.id,
    providerId: r.provider_id,
    externalTransactionId: r.external_transaction_id,
    walletId: r.wallet_id,
    playerId: r.player_id,
    roundId: r.round_id,
    gameId: r.game_id,
    kind: r.kind,
    money: { amount: r.amount, currency: r.currency },
    status: r.status,
    ...(r.failure_code !== null ? { failureCode: r.failure_code } : {}),
    ...(r.reference_external_transaction_id !== null ? { referenceExternalTransactionId: r.reference_external_transaction_id } : {}),
    ...(r.reference_transaction_id !== null ? { referenceTransactionId: r.reference_transaction_id } : {}),
    ...(r.observed_balance !== null && r.observed_currency !== null
      ? { balance: { amount: r.observed_balance, currency: r.observed_currency } }
      : {}),
    createdAt: new Date(r.created_at).toISOString(),
    ...(r.processed_at !== null ? { processedAt: new Date(r.processed_at).toISOString() } : {}),
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
