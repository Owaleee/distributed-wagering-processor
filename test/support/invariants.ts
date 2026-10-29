import { expect } from "bun:test";
import type { SQL } from "bun";

/**
 * Invariante final de todos os testes: saldo materializado == saldo reconstruído pelo ledger,
 * e a versão da wallet == número do último lançamento (quando há lançamentos).
 */
export async function expectLedgerConsistent(sql: SQL, walletId?: string): Promise<void> {
  const rows = await sql`
    select w.id, w.balance::text as balance,
           coalesce(sum(case when e.direction = 'CREDIT' then e.amount else -e.amount end), 0)::numeric(20,2)::text as rebuilt,
           w.version, coalesce(max(e.wallet_version), 1) as last_version
      from wallets w left join wallet_ledger_entries e on e.wallet_id = w.id
     where ${walletId ?? null}::uuid is null or w.id = ${walletId ?? null}::uuid
     group by w.id`;
  for (const r of rows as { id: string; balance: string; rebuilt: string; version: number; last_version: number }[]) {
    expect({ wallet: r.id, balance: r.rebuilt }).toEqual({ wallet: r.id, balance: r.balance });
    expect(r.version).toBe(r.last_version);
  }
}
