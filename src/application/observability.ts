export const LOGGER = Symbol("LOGGER");
export const METRICS = Symbol("METRICS");

/** Campos de correlação que todo log deve carregar quando existirem. Nunca colocar payloads financeiros completos. */
export interface LogFields {
  correlationId?: string | undefined;
  messageId?: string | undefined;
  transactionId?: string | undefined;
  walletId?: string | undefined;
  providerId?: string | undefined;
  [key: string]: unknown;
}

export interface Logger {
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
}

export interface Metrics {
  /** Transações por status final. */
  transactionProcessed(status: string, source: "http" | "sqs" | "worker"): void;
  /** Requisição/mensagem duplicada detectada (replay de idempotência ou inbox). */
  duplicateDetected(kind: "idempotency_replay" | "inbox"): void;
  /** Nova tentativa (mensagem SQS, publicação da outbox, referência pendente). */
  retry(kind: "sqs" | "outbox" | "pending_reference"): void;
  /** Mensagem enviada para a DLQ pelo consumidor (erro permanente). */
  sentToDlq(reason: string): void;
  /**
   * Mensagens hoje na DLQ, inclusive as movidas pelo redrive do próprio SQS (que o código não vê).
   * É este número que um alerta deve observar.
   */
  dlqDepth(messages: number): void;
  /** Conflito de concorrência: lock demorou, unicidade concorrente. */
  lockConflict(kind: "lock_timeout" | "unique_conflict"): void;
  /** Idade (s) do evento mais antigo ainda não publicado. */
  outboxLag(seconds: number): void;
  /** Latência do processamento de uma transação. */
  processingLatency(seconds: number, source: "http" | "sqs" | "worker"): void;
  reconciliationDivergence(): void;
  /** Requisição recusada antes de virar transação (400 payload inválido, 404, 409 conflito). */
  requestRejected(code: string): void;
}
