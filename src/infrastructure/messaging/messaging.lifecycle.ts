import type { OnApplicationBootstrap, OnApplicationShutdown } from "@nestjs/common";
import type { Logger } from "../../application/observability";

export interface Startable {
  readonly name: string;
  start(): void;
  stop(): Promise<void>;
}

/**
 * Liga os processos de fundo (consumidor SQS, publicador da outbox, worker de pendentes)
 * no boot e os encerra no SIGTERM, em ordem: primeiro para de receber trabalho novo,
 * depois espera o que está em andamento.
 */
export class BackgroundWorkers implements OnApplicationBootstrap, OnApplicationShutdown {
  constructor(
    private readonly workers: Startable[],
    private readonly logger: Logger,
  ) {}

  onApplicationBootstrap(): void {
    for (const w of this.workers) w.start();
  }

  async onApplicationShutdown(signal?: string): Promise<void> {
    this.logger.info("encerrando processos de fundo", { signal, workers: this.workers.map((w) => w.name) });
    await Promise.allSettled(this.workers.map((w) => w.stop()));
  }
}
