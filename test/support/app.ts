import "reflect-metadata";
import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "../../src/app.module";
import { type AppConfig, loadConfig } from "../../src/infrastructure/config";
import { ensureQueues } from "../../src/infrastructure/messaging/queue-setup";
import { createSqsClient } from "../../src/infrastructure/messaging/sqs-client";

process.env.LOG_LEVEL ??= "silent";

export interface TestApp {
  readonly app: INestApplication;
  readonly baseUrl: string;
  close(): Promise<void>;
}

/** Filas com nome único por suíte: uma suíte nunca consome mensagens de outra. */
export function testQueueNames(): Pick<AppConfig["sqs"], "wagerQueueName" | "wagerDlqName" | "eventsQueueName"> {
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  return {
    wagerQueueName: `wager-transactions-${suffix}.fifo`,
    wagerDlqName: `wager-transactions-dlq-${suffix}.fifo`,
    eventsQueueName: `wallet-events-${suffix}.fifo`,
  };
}

export interface TestConfigOverrides {
  sqs?: Partial<AppConfig["sqs"]>;
  consumer?: Partial<AppConfig["consumer"]>;
  lockTimeoutMs?: number;
  dbConnectTimeoutMs?: number;
  pendingReference?: Partial<AppConfig["pendingReference"]>;
  outbox?: Partial<AppConfig["outbox"]>;
}

/** Configuração de teste: filas exclusivas, consumidor desligado por padrão (cada teste controla o seu) e tempos curtos. */
export function testConfig(databaseUrl: string, overrides: TestConfigOverrides = {}): AppConfig {
  const base = loadConfig();
  return {
    ...base,
    databaseUrl,
    port: 0,
    lockTimeoutMs: overrides.lockTimeoutMs ?? base.lockTimeoutMs,
    dbConnectTimeoutMs: overrides.dbConnectTimeoutMs ?? base.dbConnectTimeoutMs,
    pendingReference: {
      ...base.pendingReference, enabled: false, pollIntervalMs: 100, baseDelayMs: 0, maxAttempts: 3, maxProcessingFailures: 3,
      ...overrides.pendingReference,
    },
    outbox: { ...base.outbox, enabled: false, pollIntervalMs: 100, ...overrides.outbox },
    sqs: { ...base.sqs, ...testQueueNames(), maxReceiveCount: 3, visibilityTimeoutSeconds: 2, ...overrides.sqs },
    consumer: {
      ...base.consumer,
      enabled: false,
      waitTimeSeconds: 1,
      retryBaseSeconds: 0,
      retryMaxSeconds: 0,
      shutdownTimeoutMs: 5_000,
      dlqPollIntervalMs: 200,
      ...overrides.consumer,
    },
  };
}

/** Sobe a aplicação real (Nest + MikroORM) numa porta livre, apontando para o banco de teste. */
export async function startTestApp(databaseUrl: string, overrides: TestConfigOverrides | AppConfig = {}): Promise<TestApp> {
  const config: AppConfig = "databaseUrl" in overrides ? overrides : testConfig(databaseUrl, overrides);
  await ensureQueues(createSqsClient(config), config); // o papel do `setup`: a aplicação só localiza as filas
  const app = await NestFactory.create(AppModule.forRoot(config), { logger: false });
  await app.listen(0);
  const address = app.getHttpServer().address() as { port: number };
  return { app, baseUrl: `http://127.0.0.1:${address.port}`, close: () => app.close() };
}

export interface ApiResponse<T = any> {
  status: number;
  body: T;
  headers: Headers;
}

export function api(baseUrl: string) {
  const call = async <T = any>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<ApiResponse<T>> => {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { "content-type": "application/json", ...headers },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    return { status: res.status, body: (text ? JSON.parse(text) : undefined) as T, headers: res.headers };
  };
  return {
    get: <T = any>(path: string) => call<T>("GET", path),
    post: <T = any>(path: string, body?: unknown, headers?: Record<string, string>) => call<T>("POST", path, body, headers),
    createWallet: (amount = "100.00", currency = "BRL", playerId: string = crypto.randomUUID()) =>
      call("POST", "/wallets", { playerId, initialBalance: { amount, currency } }),
    submit: (payload: WagerPayload, idempotencyKey = `${payload.providerId}:${payload.externalTransactionId}`) =>
      call("POST", "/wagering/transactions", payload, { "Idempotency-Key": idempotencyKey }),
  };
}

export interface WagerPayload {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: { amount: string; currency: string };
  referenceExternalTransactionId?: string;
}

export function wagerPayload(wallet: { id: string; playerId: string }, kind: string, amount: string, extra: Partial<WagerPayload> = {}): WagerPayload {
  return {
    providerId: "provider-a",
    externalTransactionId: `tx-${crypto.randomUUID()}`,
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: "round-1",
    gameId: "fortune-chimp",
    kind,
    money: { amount, currency: "BRL" },
    ...extra,
  };
}
