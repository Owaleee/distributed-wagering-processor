import type { Logger, Metrics } from "../../application/observability";
import type { Clock, IdGenerator, UnitOfWork } from "../../application/ports";
import type { ProcessWagerTransaction } from "../../application/wagering/process-wager-transaction";
import { WagerTransactionFailed } from "../../domain/messaging/integration-event";
import { OutboxMessage } from "../../domain/messaging/outbox-message";
import { FailureCode } from "../../domain/wagering/failure-code";
import { WagerTransactionStatus } from "../../domain/wagering/wager-transaction";
import { PollingWorker } from "./polling-worker";

export interface PendingReferenceOptions {
  pollIntervalMs: number;
  /** Reavaliações à espera da referência antes de desistir (REFERENCE_NOT_FOUND / REFERENCE_STILL_PENDING). */
  maxAttempts: number;
  baseDelayMs: number;
  batchSize: number;
  /** Falhas de infraestrutura seguidas ao reavaliar antes de marcar FAILED. Contagem separada de `maxAttempts`. */
  maxProcessingFailures: number;
}

/**
 * Reprocessa transações PENDING_REFERENCE (REFUND/ROLLBACK/WIN que chegaram antes da referência).
 *
 * Cada pendência é reavaliada numa transação própria: `FOR UPDATE SKIP LOCKED` na linha da
 * pendência (dois workers nunca pegam a mesma) e depois o mesmo lock de wallet do fluxo normal.
 * Backoff exponencial: a 1ª reavaliação ocorre baseDelayMs depois da chegada e a n-ésima,
 * baseDelayMs · 2^(n−1) depois da anterior. Com os padrões (2 s, 8 tentativas) a janela total é
 * 2 + 4 + … + 256 s = 510 s (~8,5 min). Esgotada:
 * - referência ausente → REJECTED / REFERENCE_NOT_FOUND;
 * - referência presente, mas ainda pendente → REJECTED / REFERENCE_STILL_PENDING.
 * Erros de infraestrutura ao reavaliar contam à parte (`processing_failures`): depois de
 * `maxProcessingFailures` seguidos, a pendência vira FAILED / PROCESSING_FAILED, com evento.
 * Quando a referência chega a um estado final, o caso de uso acorda a pendência (next_attempt_at = agora).
 */
export class PendingReferenceWorker extends PollingWorker {
  readonly name = "pending-reference-worker";

  constructor(
    private readonly uow: UnitOfWork,
    private readonly processWager: ProcessWagerTransaction,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    logger: Logger,
    private readonly metrics: Metrics,
    private readonly options: PendingReferenceOptions,
  ) {
    super(logger, options.pollIntervalMs);
  }

  protected async tick(): Promise<number> {
    let processed = 0;
    while (processed < this.options.batchSize && (await this.processOne())) processed += 1;
    return processed;
  }

  /** Reavalia uma pendência vencida. Devolve false se não havia nenhuma. Exposto para testes. */
  async processOne(): Promise<boolean> {
    let claimed: { id: string; providerId: string; externalTransactionId: string } | undefined;
    try {
      const status = await this.uow.run(async (store) => {
        const now = this.clock.now();
        const [due] = await store.lockDuePendingReferences(now, 1);
        if (due === undefined) return undefined;
        const tx = due.transaction;
        claimed = { id: tx.id, providerId: tx.providerId, externalTransactionId: tx.externalTransactionId };

        const attempts = due.attempts + 1;
        const exhausted = attempts >= this.options.maxAttempts;
        const nextAttemptAt = new Date(now.getTime() + this.options.baseDelayMs * 2 ** attempts);
        const result = await this.processWager.retryPending(store, tx, {
          exhausted,
          // Uma reavaliação que chegou ao fim zera a sequência de falhas de infraestrutura.
          nextSchedule: { attempts, nextAttemptAt, processingFailures: 0 },
          trace: { correlationId: tx.id, causationId: tx.id },
        });

        const fields = { transactionId: tx.id, walletId: tx.walletId, providerId: tx.providerId, attempts, status: result };
        if (result === WagerTransactionStatus.PendingReference) {
          this.metrics.retry("pending_reference");
          this.logger.info("referência ainda ausente; nova tentativa agendada", { ...fields, nextAttemptAt: nextAttemptAt.toISOString() });
        } else {
          this.metrics.transactionProcessed(result, "worker");
          this.logger.info("pendência de referência resolvida", { ...fields, failureCode: tx.failureCode });
        }
        return result;
      });
      if (status === undefined) return false;
      // Uma pendência resolvida pode ser a referência de outra (ex.: ROLLBACK de um REFUND).
      if (claimed !== undefined) await this.processWager.wakeDependents({ status }, claimed.providerId, claimed.externalTransactionId);
      return true;
    } catch (error) {
      if (claimed === undefined) throw error; // nem chegou a travar uma pendência: a rodada falha e repete
      await this.recordFailure(claimed.id, error);
      return true;
    }
  }

  /**
   * A reavaliação falhou por erro de infraestrutura (a transação dela foi desfeita).
   * Conta a falha numa transação nova, sem gastar uma tentativa de referência. Depois de
   * `maxProcessingFailures` seguidas, a pendência vira FAILED — terminal e auditável, com evento —
   * em vez de ficar tentando para sempre.
   */
  private async recordFailure(transactionId: string, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    let failed: { providerId: string; externalTransactionId: string } | undefined;
    await this.uow.run(async (store) => {
      const pending = await store.lockPendingReference(transactionId);
      if (pending === undefined) return; // outro worker já resolveu
      const now = this.clock.now();
      const processingFailures = pending.processingFailures + 1;
      const tx = pending.transaction;
      const fields = {
        transactionId: tx.id, walletId: tx.walletId, providerId: tx.providerId,
        attempts: pending.attempts, processingFailures, error: message,
      };

      if (processingFailures >= this.options.maxProcessingFailures) {
        tx.fail(FailureCode.ProcessingFailed, now);
        store.updateTransaction(tx, now, { attempts: pending.attempts, nextAttemptAt: now, processingFailures });
        store.enqueue(
          OutboxMessage.enqueue(
            WagerTransactionFailed.from(tx, FailureCode.ProcessingFailed, {
              eventId: this.ids.next(), correlationId: tx.id, causationId: tx.id, occurredAt: now,
            }),
          ),
        );
        failed = { providerId: tx.providerId, externalTransactionId: tx.externalTransactionId };
        this.metrics.transactionProcessed(WagerTransactionStatus.Failed, "worker");
        this.logger.error("pendência marcada como FAILED após falhas de infraestrutura", fields);
        return;
      }
      const delay = this.options.baseDelayMs * 2 ** (processingFailures - 1);
      store.updateTransaction(tx, now, {
        attempts: pending.attempts, nextAttemptAt: new Date(now.getTime() + delay), processingFailures,
      });
      this.metrics.retry("pending_reference");
      this.logger.warn("falha ao reavaliar pendência; nova tentativa agendada", fields);
    });
    // Quem dependia desta transação não precisa esperar a própria janela para saber que ela falhou.
    if (failed !== undefined) {
      await this.processWager.wakeDependents({ status: WagerTransactionStatus.Failed }, failed.providerId, failed.externalTransactionId);
    }
  }
}
