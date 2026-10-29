/** Configuração lida das variáveis de ambiente, com padrões para desenvolvimento local. */
export interface AppConfig {
  readonly port: number;
  readonly databaseUrl: string;
  /** Espera máxima por um lock de linha (ms) antes de responder falha transitória. */
  readonly lockTimeoutMs: number;
  /** Espera máxima por uma conexão livre do pool (ms) antes de responder falha transitória. */
  readonly dbConnectTimeoutMs: number;
  readonly pendingReference: {
    readonly enabled: boolean;
    readonly pollIntervalMs: number;
    /**
     * Primeira reavaliação de uma PENDING_REFERENCE, em ms após a chegada; as seguintes dobram.
     * Com 2 s e 8 tentativas, a janela total de espera é 2 + 4 + … + 256 s = 510 s (~8,5 min).
     */
    readonly baseDelayMs: number;
    /** Reavaliações à espera da referência antes de rejeitar (REFERENCE_NOT_FOUND / REFERENCE_STILL_PENDING). */
    readonly maxAttempts: number;
    /** Falhas de infraestrutura seguidas ao reavaliar antes de marcar FAILED. */
    readonly maxProcessingFailures: number;
    readonly batchSize: number;
  };
  readonly outbox: {
    readonly enabled: boolean;
    readonly pollIntervalMs: number;
    readonly batchSize: number;
  };
  readonly sqs: {
    readonly endpoint: string;
    readonly region: string;
    readonly accessKeyId: string;
    readonly secretAccessKey: string;
    readonly wagerQueueName: string;
    readonly wagerDlqName: string;
    readonly eventsQueueName: string;
    /** Recebimentos sem ack antes de o SQS mover a mensagem para a DLQ (redrive). */
    readonly maxReceiveCount: number;
    readonly visibilityTimeoutSeconds: number;
  };
  readonly consumer: {
    readonly enabled: boolean;
    /** Nome do consumidor na inbox: (consumer_name, message_id) é a chave de deduplicação. */
    readonly name: string;
    /** Long polling: quanto tempo cada ReceiveMessage espera por mensagens. */
    readonly waitTimeSeconds: number;
    /** Backoff de erro transitório: base · 2^(tentativa−1), limitado a max. */
    readonly retryBaseSeconds: number;
    readonly retryMaxSeconds: number;
    /** Tempo máximo para terminar a mensagem em andamento no SIGTERM. */
    readonly shutdownTimeoutMs: number;
    /** A cada quanto tempo a profundidade da DLQ é lida para a métrica. */
    readonly dlqPollIntervalMs: number;
  };
  /**
   * Injeção de falha, só para testes: o processo se mata (SIGKILL) logo depois do COMMIT de uma
   * mensagem e antes do ack. Prova, com um processo real, que a redelivery não duplica o efeito.
   */
  readonly faultInjection: {
    readonly crashAfterCommit: boolean;
  };
}

export function intFromEnv(name: string, fallback: number, min = 1): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < min) {
    throw new Error(`Variável de ambiente ${name} inválida: "${raw}"`);
  }
  return value;
}

export function boolFromEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  return raw === "true" || raw === "1";
}

export function loadConfig(): AppConfig {
  return {
    port: intFromEnv("PORT", 3000),
    databaseUrl: process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/wagering",
    lockTimeoutMs: intFromEnv("LOCK_TIMEOUT_MS", 5_000),
    dbConnectTimeoutMs: intFromEnv("DB_CONNECT_TIMEOUT_MS", 5_000),
    pendingReference: {
      enabled: boolFromEnv("PENDING_REFERENCE_WORKER_ENABLED", true),
      pollIntervalMs: intFromEnv("PENDING_REFERENCE_POLL_INTERVAL_MS", 1_000),
      baseDelayMs: intFromEnv("PENDING_REFERENCE_BASE_DELAY_MS", 2_000, 0),
      maxAttempts: intFromEnv("PENDING_REFERENCE_MAX_ATTEMPTS", 8),
      maxProcessingFailures: intFromEnv("PENDING_REFERENCE_MAX_PROCESSING_FAILURES", 5),
      batchSize: intFromEnv("PENDING_REFERENCE_BATCH_SIZE", 10),
    },
    outbox: {
      enabled: boolFromEnv("OUTBOX_PUBLISHER_ENABLED", true),
      pollIntervalMs: intFromEnv("OUTBOX_POLL_INTERVAL_MS", 500),
      batchSize: intFromEnv("OUTBOX_BATCH_SIZE", 10),
    },
    sqs: {
      endpoint: process.env.SQS_ENDPOINT ?? "http://localhost:4566",
      region: process.env.AWS_REGION ?? "us-east-1",
      accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? "test",
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? "test",
      wagerQueueName: process.env.WAGER_QUEUE_NAME ?? "wager-transactions.fifo",
      wagerDlqName: process.env.WAGER_DLQ_NAME ?? "wager-transactions-dlq.fifo",
      eventsQueueName: process.env.EVENTS_QUEUE_NAME ?? "wallet-events.fifo",
      maxReceiveCount: intFromEnv("WAGER_MAX_RECEIVE_COUNT", 5),
      visibilityTimeoutSeconds: intFromEnv("WAGER_VISIBILITY_TIMEOUT_SECONDS", 30),
    },
    consumer: {
      enabled: boolFromEnv("CONSUMER_ENABLED", true),
      name: process.env.CONSUMER_NAME ?? "wager-transactions-consumer",
      waitTimeSeconds: intFromEnv("CONSUMER_WAIT_TIME_SECONDS", 5, 0),
      retryBaseSeconds: intFromEnv("CONSUMER_RETRY_BASE_SECONDS", 2, 0),
      retryMaxSeconds: intFromEnv("CONSUMER_RETRY_MAX_SECONDS", 60, 0),
      shutdownTimeoutMs: intFromEnv("CONSUMER_SHUTDOWN_TIMEOUT_MS", 20_000),
      dlqPollIntervalMs: intFromEnv("CONSUMER_DLQ_POLL_INTERVAL_MS", 15_000),
    },
    faultInjection: {
      crashAfterCommit: boolFromEnv("FAULT_CRASH_AFTER_COMMIT", false),
    },
  };
}
