import type { Logger } from "../../application/observability";
import type { Startable } from "../messaging/messaging.lifecycle";

/**
 * Laço de trabalho periódico com encerramento gracioso: `stop()` espera a rodada em andamento
 * terminar (ela roda numa transação; interromper no meio só faria rollback).
 */
export abstract class PollingWorker implements Startable {
  abstract readonly name: string;
  private running = false;
  private loop: Promise<void> | undefined;
  private wake: (() => void) | undefined;

  protected constructor(
    protected readonly logger: Logger,
    private readonly intervalMs: number,
  ) {}

  /** Uma rodada. Devolve quantos itens processou: se > 0, a próxima rodada começa sem esperar. */
  protected abstract tick(): Promise<number>;

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loop = this.run();
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.wake?.();
    await this.loop;
  }

  private async run(): Promise<void> {
    while (this.running) {
      let processed = 0;
      try {
        processed = await this.tick();
      } catch (error) {
        this.logger.warn(`${this.name}: rodada falhou; tentando de novo`, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      if (processed === 0 && this.running) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, this.intervalMs);
          this.wake = () => {
            clearTimeout(timer);
            resolve();
          };
        });
      }
    }
  }
}
