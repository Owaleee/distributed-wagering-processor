import { Migration } from "@mikro-orm/migrations";

/**
 * Índice da outbox na mesma ordem em que o relay lê (`ORDER BY occurred_at, id LIMIT n`).
 * O índice anterior, em `next_attempt_at`, obrigava o banco a ordenar TODOS os eventos pendentes
 * a cada lote: com fila acumulada sob carga, cada lote ficava mais lento e o atraso crescia sozinho.
 * Com este, o banco percorre o índice em ordem e para nos primeiros `n` vencidos.
 */
export class Migration20261030010000OutboxRelayOrder extends Migration {
  override up(): void {
    this.addSql(`drop index if exists outbox_messages_pending_idx;`);
    this.addSql(`
      create index outbox_messages_pending_idx on outbox_messages (occurred_at, id)
        where published_at is null;
    `);
  }

  override down(): void {
    this.addSql(`drop index if exists outbox_messages_pending_idx;`);
    this.addSql(`
      create index outbox_messages_pending_idx on outbox_messages (next_attempt_at)
        where published_at is null;
    `);
  }
}
