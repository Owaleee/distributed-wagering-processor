/** Configuração lida das variáveis de ambiente, com padrões para desenvolvimento local. */
export interface AppConfig {
  readonly port: number;
  readonly databaseUrl: string;
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
  };
}
