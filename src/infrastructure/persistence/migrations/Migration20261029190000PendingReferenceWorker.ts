import { Migration } from "@mikro-orm/migrations";

/**
 * Suporte ao worker de transações PENDING_REFERENCE:
 * - índice parcial para acordar as pendências quando a referência chega
 *   (busca por provider_id + reference_external_transaction_id, só entre as pendentes);
 * - `processing_failures`: falhas de infraestrutura ao reavaliar, contadas à parte de `attempts`
 *   (tentativas de encontrar a referência). São problemas diferentes com limites diferentes.
 */
export class Migration20261029190000PendingReferenceWorker extends Migration {
  override up(): void {
    this.addSql(`
      create index wager_transactions_pending_by_reference_idx
        on wager_transactions (provider_id, reference_external_transaction_id)
        where status = 'PENDING_REFERENCE';
    `);
    this.addSql(`
      alter table wager_transactions
        add column processing_failures integer not null default 0 check (processing_failures >= 0);
    `);
  }

  override down(): void {
    this.addSql(`alter table wager_transactions drop column if exists processing_failures;`);
    this.addSql(`drop index if exists wager_transactions_pending_by_reference_idx;`);
  }
}
