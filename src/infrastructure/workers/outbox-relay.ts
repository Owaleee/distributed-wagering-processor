import type { MikroORM } from "@mikro-orm/postgresql";
import type { Logger, Metrics } from "../../application/observability";
import type { Clock } from "../../application/ports";
import { OutboxMessage } from "../../domain/messaging/outbox-message";
import type { EventPublisher } from "../messaging/sqs-event-publisher";
import { PollingWorker } from "./polling-worker";

interface OutboxRow {
  id: string;
  aggregate_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  occurred_at: Date;
  attempts: number;
  next_attempt_at: Date;
}

export interface OutboxRelayHooks {
  /** Chamado depois de publicar e antes do COMMIT que marca como publicado (testes de crash). */
  afterPublish?: (eventIds: string[]) => Promise<void>;
}

/**
 * Publicador da Transactional Outbox.
 *
 * Cada rodada abre uma transação, trava um lote de eventos pendentes com
 * `FOR UPDATE SKIP LOCKED` (vários publishers em paralelo pegam lotes diferentes),
 * publica no SQS e marca `published_at` no mesmo COMMIT.
 * Se o processo morrer depois de publicar e antes do COMMIT, o lock some com a conexão e outra
 * instância publica de novo: entrega at-least-once, com deduplicação pelo `eventId`.
 * Falha no envio → `scheduleRetry` (backoff exponencial do domínio) e `last_error`.
 *
 * SQL direto (e não o ORM) porque a seleção precisa de `ORDER BY … LIMIT … FOR UPDATE SKIP LOCKED`
 * numa tabela técnica, sem regra de domínio para hidratar; e as marcações são updates pontuais
 * por id dentro da mesma transação. O estado de cada evento continua decidido pelo `OutboxMessage`.
 *
 * Ordem: não há garantia de ordem global entre lotes, porque vários publishers rodam em paralelo.
 * Eventos de saldo usam `MessageGroupId = walletId` e carregam `walletVersion`: o consumidor
 * ordena e descarta duplicatas por ela (ver ARCHITECTURE, D18).
 */
export class OutboxRelay extends PollingWorker {
  readonly name = "outbox-relay";

  constructor(
    private readonly orm: MikroORM,
    private readonly publisher: EventPublisher,
    private readonly clock: Clock,
    logger: Logger,
    private readonly metrics: Metrics,
    private readonly options: { pollIntervalMs: number; batchSize: number },
    private readonly hooks: OutboxRelayHooks = {},
  ) {
    super(logger, options.pollIntervalMs);
  }

  protected async tick(): Promise<number> {
    const processed = await this.relayBatch();
    await this.reportLag();
    return processed;
  }

  /** Publica um lote. Exposto para testes. */
  async relayBatch(): Promise<number> {
    return this.orm.em.fork().transactional(async (em) => {
      const now = this.clock.now();
      const rows = await em.execute<OutboxRow[]>(
        `select id, aggregate_id, event_type, payload, occurred_at, attempts, next_attempt_at
           from outbox_messages
          where published_at is null and next_attempt_at <= ?
          order by occurred_at, id
          limit ?
          for update skip locked`,
        [now, this.options.batchSize],
      );
      if (rows.length === 0) return 0;

      const results = await this.publisher.publish(
        rows.map((r) => ({ id: r.id, aggregateId: r.aggregate_id, eventType: r.event_type, payload: r.payload })),
      );
      await this.hooks.afterPublish?.(rows.map((r) => r.id));

      const publishedAt = this.clock.now();
      for (const row of rows) {
        const message = OutboxMessage.rehydrate({
          id: row.id, aggregateId: row.aggregate_id, eventType: row.event_type, payload: row.payload,
          occurredAt: new Date(row.occurred_at), attempts: row.attempts, nextAttemptAt: new Date(row.next_attempt_at),
        });
        const error = results.has(row.id) ? results.get(row.id) : "sem resposta do publisher";
        if (error === undefined) {
          message.markPublished(publishedAt);
          await em.execute(`update outbox_messages set published_at = ?, last_error = null where id = ?`, [publishedAt, row.id]);
        } else {
          message.scheduleRetry(publishedAt);
          this.metrics.retry("outbox");
          await em.execute(
            `update outbox_messages set attempts = ?, next_attempt_at = ?, last_error = ? where id = ?`,
            [message.attempts, message.nextAttemptAt, error.slice(0, 500), row.id],
          );
          this.logger.warn("falha ao publicar evento; nova tentativa agendada", {
            eventId: row.id, eventType: row.event_type, attempts: message.attempts, error,
          });
        }
      }
      return rows.length;
    });
  }

  private async reportLag(): Promise<void> {
    const [row] = await this.orm.em.fork().getConnection().execute<{ lag: string | null }[]>(
      `select extract(epoch from (now() - min(occurred_at)))::text as lag from outbox_messages where published_at is null`,
    );
    this.metrics.outboxLag(row?.lag !== null && row?.lag !== undefined ? Math.max(0, Number(row.lag)) : 0);
  }
}
