import { Migration } from "@mikro-orm/migrations";

/**
 * Índice para a regra "não reverter uma BET cujo WIN já foi pago": busca os WIN PROCESSED
 * que apontam para uma BET (reference_transaction_id), só entre eles.
 */
export class Migration20261030020000ActiveWinLookup extends Migration {
  override up(): void {
    this.addSql(`
      create index wager_transactions_processed_win_by_reference_idx
        on wager_transactions (reference_transaction_id)
        where kind = 'WIN' and status = 'PROCESSED';
    `);
  }

  override down(): void {
    this.addSql(`drop index if exists wager_transactions_processed_win_by_reference_idx;`);
  }
}
