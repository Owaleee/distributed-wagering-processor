import type { IntegrationEvent } from "./integration-event";

export interface OutboxMessageState {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Readonly<Record<string, unknown>>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt?: Date | undefined;
  publishedAt?: Date | undefined;
}

/** Backoff exponencial da publicação: 1 s, 2 s, 4 s… limitado a 5 min. */
export const OUTBOX_BACKOFF = { baseMs: 1_000, maxMs: 300_000 } as const;

/**
 * Evento gravado na mesma transação SQL da alteração financeira e publicado depois do commit
 * por um worker. O id da mensagem é o eventId: o consumidor deduplica por ele.
 */
export class OutboxMessage {
  private constructor(
    public readonly id: string,
    public readonly aggregateId: string,
    public readonly eventType: string,
    public readonly payload: Readonly<Record<string, unknown>>,
    public readonly occurredAt: Date,
    private _attempts: number,
    private _nextAttemptAt?: Date,
    private _publishedAt?: Date,
  ) {}

  static enqueue(event: IntegrationEvent<unknown>): OutboxMessage {
    const payload = JSON.parse(JSON.stringify(event.toJSON())) as Record<string, unknown>;
    return new OutboxMessage(
      event.eventId, event.aggregateId, event.eventType, Object.freeze(payload),
      event.occurredAt, 0, event.occurredAt,
    );
  }

  static rehydrate(state: OutboxMessageState): OutboxMessage {
    return new OutboxMessage(
      state.id, state.aggregateId, state.eventType, state.payload, state.occurredAt,
      state.attempts, state.nextAttemptAt, state.publishedAt,
    );
  }

  get attempts(): number {
    return this._attempts;
  }
  get nextAttemptAt(): Date | undefined {
    return this._nextAttemptAt;
  }
  get publishedAt(): Date | undefined {
    return this._publishedAt;
  }

  isPending(): boolean {
    return this._publishedAt === undefined;
  }

  isDue(now: Date): boolean {
    return this.isPending() && (this._nextAttemptAt === undefined || this._nextAttemptAt.getTime() <= now.getTime());
  }

  markPublished(at: Date): void {
    if (this._publishedAt === undefined) this._publishedAt = at;
  }

  /** incrementa attempts e calcula o próximo nextAttemptAt (backoff) */
  scheduleRetry(now: Date): void {
    this._attempts += 1;
    const delay = Math.min(OUTBOX_BACKOFF.baseMs * 2 ** (this._attempts - 1), OUTBOX_BACKOFF.maxMs);
    this._nextAttemptAt = new Date(now.getTime() + delay);
  }
}
