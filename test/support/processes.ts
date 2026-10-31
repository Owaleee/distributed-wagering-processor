import type { Subprocess } from "bun";
import { loadConfig } from "../../src/infrastructure/config";
import { ensureQueues } from "../../src/infrastructure/messaging/queue-setup";
import { createSqsClient } from "../../src/infrastructure/messaging/sqs-client";
import { testQueueNames } from "./app";
import { freePortRange } from "./ports";

/**
 * Sobe instâncias REAIS da aplicação como processos separados do sistema operacional
 * (`bun src/main.ts`), todas apontando para o mesmo PostgreSQL e as mesmas filas.
 * Nada é compartilhado em memória entre elas — exatamente como em produção com várias réplicas.
 */
export interface Instance {
  readonly index: number;
  readonly port: number;
  readonly baseUrl: string;
  process: Subprocess;
}

export interface Cluster {
  readonly instances: Instance[];
  readonly env: Record<string, string>;
  /** Sobe de novo a instância `index`; `envOverrides` troca variáveis só desta vez (ex.: tirar a injeção de falha). */
  restart(index: number, envOverrides?: Record<string, string>): Promise<void>;
  kill(index: number, signal?: NodeJS.Signals): Promise<number | null>;
  stopAll(): Promise<void>;
}

export async function startCluster(databaseUrl: string, size = 3, extraEnv: Record<string, string> = {}): Promise<Cluster> {
  const queues = testQueueNames();
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    DATABASE_URL: databaseUrl,
    WAGER_QUEUE_NAME: queues.wagerQueueName,
    WAGER_DLQ_NAME: queues.wagerDlqName,
    EVENTS_QUEUE_NAME: queues.eventsQueueName,
    WAGER_MAX_RECEIVE_COUNT: "5",
    WAGER_VISIBILITY_TIMEOUT_SECONDS: "3",
    CONSUMER_WAIT_TIME_SECONDS: "1",
    CONSUMER_RETRY_BASE_SECONDS: "0",
    CONSUMER_RETRY_MAX_SECONDS: "0",
    OUTBOX_POLL_INTERVAL_MS: "100",
    PENDING_REFERENCE_POLL_INTERVAL_MS: "200",
    PENDING_REFERENCE_BASE_DELAY_MS: "0",
    LOG_LEVEL: "silent",
    ...extraEnv,
  };
  // O papel do serviço `setup` do compose: as instâncias só localizam filas que já existem.
  const base = loadConfig();
  const setupConfig = {
    ...base,
    sqs: {
      ...base.sqs, ...queues,
      maxReceiveCount: Number(env.WAGER_MAX_RECEIVE_COUNT),
      visibilityTimeoutSeconds: Number(env.WAGER_VISIBILITY_TIMEOUT_SECONDS),
    },
  };
  await ensureQueues(createSqsClient(setupConfig), setupConfig);

  // Fora da faixa de portas de saída do sistema: ver `ports.ts` (o reinício reabre a mesma porta).
  const basePort = freePortRange(size);
  const instances: Instance[] = [];
  for (let i = 0; i < size; i++) {
    const port = basePort + i;
    instances.push({ index: i, port, baseUrl: `http://127.0.0.1:${port}`, process: spawn(env, port) });
  }
  await Promise.all(instances.map((inst) => waitReady(inst)));

  return {
    instances,
    env,
    async restart(index, envOverrides = {}) {
      const inst = instances[index]!;
      inst.process = spawn({ ...env, ...envOverrides }, inst.port);
      await waitReady(inst);
    },
    async kill(index, signal = "SIGKILL") {
      const inst = instances[index]!;
      inst.process.kill(signal);
      return inst.process.exited;
    },
    async stopAll() {
      await Promise.all(
        instances.map(async (inst) => {
          if (inst.process.exitCode === null && inst.process.signalCode === null) {
            inst.process.kill("SIGTERM");
            await Promise.race([inst.process.exited, new Promise((r) => setTimeout(r, 10_000))]);
            if (inst.process.exitCode === null) inst.process.kill("SIGKILL");
          }
        }),
      );
    },
  };
}

function spawn(env: Record<string, string>, port: number): Subprocess {
  return Bun.spawn(["bun", "src/main.ts"], {
    cwd: `${import.meta.dir}/../..`,
    env: { ...env, PORT: String(port) },
    stdout: "ignore",
    stderr: "inherit",
  });
}

async function waitReady(inst: Instance, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${inst.baseUrl}/health/ready`);
      if (res.status === 200) return;
    } catch {
      // ainda subindo
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`instância ${inst.index} (porta ${inst.port}) não ficou pronta`);
}
