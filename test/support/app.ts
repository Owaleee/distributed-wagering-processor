import "reflect-metadata";
import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "../../src/app.module";
import { type AppConfig, loadConfig } from "../../src/infrastructure/config";

process.env.LOG_LEVEL ??= "silent";

export interface TestApp {
  readonly app: INestApplication;
  readonly baseUrl: string;
  close(): Promise<void>;
}

export interface TestConfigOverrides {
  lockTimeoutMs?: number;
  dbConnectTimeoutMs?: number;
  pendingReference?: Partial<AppConfig["pendingReference"]>;
}

/** Configuração de teste: a padrão, numa porta livre e apontando para o banco de teste. */
export function testConfig(databaseUrl: string, overrides: TestConfigOverrides = {}): AppConfig {
  const base = loadConfig();
  return {
    ...base,
    databaseUrl,
    port: 0,
    lockTimeoutMs: overrides.lockTimeoutMs ?? base.lockTimeoutMs,
    dbConnectTimeoutMs: overrides.dbConnectTimeoutMs ?? base.dbConnectTimeoutMs,
    pendingReference: { ...base.pendingReference, ...overrides.pendingReference },
  };
}

/** Sobe a aplicação real (Nest + MikroORM) numa porta livre, apontando para o banco de teste. */
export async function startTestApp(databaseUrl: string, overrides: TestConfigOverrides | AppConfig = {}): Promise<TestApp> {
  const config: AppConfig = "databaseUrl" in overrides ? overrides : testConfig(databaseUrl, overrides);
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
