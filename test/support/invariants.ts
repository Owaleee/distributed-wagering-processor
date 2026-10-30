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

/**
 * Verificador rígido: cada consulta procura um estado que NUNCA deveria existir.
 * Usado depois dos testes de caos e do teste baseado em modelo. Devolve as violações por regra.
 */
export async function structuralViolations(sql: SQL): Promise<Record<string, unknown[]>> {
  const checks: Record<string, Promise<unknown[]>> = {
    "saldo negativo": sql`select id, balance from wallets where balance < 0`,

    "saldo != soma do ledger": sql`
      select w.id from wallets w left join wallet_ledger_entries e on e.wallet_id = w.id
       group by w.id, w.balance
      having w.balance <> coalesce(sum(case when e.direction = 'CREDIT' then e.amount else -e.amount end), 0)`,

    "versões do ledger com buraco ou fora do fim": sql`
      select w.id from wallets w join wallet_ledger_entries e on e.wallet_id = w.id
       group by w.id, w.version
      having max(e.wallet_version) <> w.version
          or count(*) <> max(e.wallet_version) - min(e.wallet_version) + 1`,

    "lançamento cuja conta não fecha": sql`
      select id from wallet_ledger_entries
       where balance_after <> balance_before + case when direction = 'CREDIT' then amount else -amount end`,

    "corrente quebrada (antes != depois do anterior)": sql`
      select e.id from wallet_ledger_entries e
        join wallet_ledger_entries p on p.wallet_id = e.wallet_id and p.wallet_version = e.wallet_version - 1
       where e.balance_before <> p.balance_after`,

    "primeiro lançamento não parte de zero": sql`
      select e.id from wallet_ledger_entries e
       where e.wallet_version = (select min(wallet_version) from wallet_ledger_entries x where x.wallet_id = e.wallet_id)
         and e.balance_before <> 0`,

    "transação que mexe no saldo sem exatamente 1 lançamento": sql`
      select t.id, t.kind, t.status, count(e.id) as entries from wager_transactions t
        left join wallet_ledger_entries e on e.transaction_id = t.id
       group by t.id
      having count(e.id) <> case when t.status = 'PROCESSED' and t.kind <> 'LOSS' then 1 else 0 end`,

    "lançamento com valor, wallet ou direção diferentes da transação": sql`
      select t.id from wager_transactions t join wallet_ledger_entries e on e.transaction_id = t.id
        left join wager_transactions r on r.id = t.reference_transaction_id
       where e.amount <> t.amount or e.wallet_id <> t.wallet_id or e.currency <> t.currency
          or e.direction <> case
               when t.kind in ('BET') then 'DEBIT'
               when t.kind in ('WIN', 'REFUND', 'OPENING') then 'CREDIT'
               when t.kind = 'ROLLBACK' and r.kind = 'BET' then 'CREDIT'
               when t.kind = 'ROLLBACK' then 'DEBIT'
             end`,

    "saldo observado diferente do saldo após o lançamento": sql`
      select t.id from wager_transactions t join wallet_ledger_entries e on e.transaction_id = t.id
       where t.observed_balance is distinct from e.balance_after`,

    "reversão processada sem referência válida": sql`
      select t.id from wager_transactions t left join wager_transactions r on r.id = t.reference_transaction_id
       where t.kind in ('REFUND', 'ROLLBACK') and t.status = 'PROCESSED'
         and (r.id is null or r.status <> 'PROCESSED' or r.amount <> t.amount or r.wallet_id <> t.wallet_id
              or r.round_id <> t.round_id or r.provider_id <> t.provider_id
              or (t.kind = 'REFUND' and r.kind <> 'BET')
              or (t.kind = 'ROLLBACK' and r.kind not in ('BET', 'WIN', 'REFUND')))`,

    "referência revertida mais de uma vez": sql`
      select reference_transaction_id from wager_transactions
       where kind in ('REFUND', 'ROLLBACK') and status = 'PROCESSED'
       group by reference_transaction_id having count(*) > 1`,

    "BET devolvida com prêmio pago e mantido (crédito em dobro)": sql`
      select b.id from wager_transactions b
        join wager_transactions rev on rev.reference_transaction_id = b.id
             and rev.kind in ('REFUND', 'ROLLBACK') and rev.status = 'PROCESSED'
        join wager_transactions w on w.reference_transaction_id = b.id and w.kind = 'WIN' and w.status = 'PROCESSED'
       where b.kind = 'BET'
         and not exists (select 1 from wager_transactions wr where wr.reference_transaction_id = w.id
                          and wr.kind in ('REFUND', 'ROLLBACK') and wr.status = 'PROCESSED')`,

    "status terminal sem horário ou rejeição sem código": sql`
      select id from wager_transactions
       where (status in ('PROCESSED', 'REJECTED', 'FAILED') and processed_at is null)
          or (status in ('REJECTED', 'FAILED') and failure_code is null)
          or (status in ('PROCESSED', 'PENDING_REFERENCE') and failure_code is not null)`,

    "pendência sem agendamento ou terminal com agendamento": sql`
      select id from wager_transactions
       where (status = 'PENDING_REFERENCE' and next_attempt_at is null)
          or (status in ('PROCESSED', 'REJECTED', 'FAILED') and next_attempt_at is not null)`,

    "transação sem o evento do seu estado na outbox": sql`
      select t.id, t.status from wager_transactions t
       where t.kind <> 'OPENING'
         and not exists (select 1 from outbox_messages o where o.aggregate_id = t.id::text and o.event_type =
               case t.status when 'PROCESSED' then 'WagerTransactionProcessed'
                             when 'REJECTED' then 'WagerTransactionRejected'
                             when 'FAILED' then 'WagerTransactionFailed'
                             else 'WagerTransactionPendingReference' end)`,

    "evento de estado final duplicado para a mesma transação": sql`
      select aggregate_id, event_type from outbox_messages
       where event_type in ('WagerTransactionProcessed', 'WagerTransactionRejected', 'WagerTransactionFailed')
       group by aggregate_id, event_type having count(*) > 1`,

    "WalletBalanceChanged não bate 1:1 com o ledger": sql`
      select e.id from wallet_ledger_entries e
       where (select count(*) from outbox_messages o
               where o.event_type = 'WalletBalanceChanged' and o.aggregate_id = e.wallet_id::text
                 and (o.payload->'data'->>'walletVersion')::int = e.wallet_version
                 and o.payload->'data'->'balanceAfter'->>'amount' = e.balance_after::text) <> 1`,
  };
  const results: Record<string, unknown[]> = {};
  for (const [name, query] of Object.entries(checks)) {
    const rows = await query;
    if (rows.length > 0) results[name] = rows.slice(0, 5);
  }
  return results;
}

export async function expectNoStructuralViolations(sql: SQL): Promise<void> {
  expect(await structuralViolations(sql)).toEqual({});
}
