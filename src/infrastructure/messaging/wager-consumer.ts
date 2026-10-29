import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  GetQueueAttributesCommand,
  type Message,
  ReceiveMessageCommand,
  SendMessageCommand,
  type SQSClient,
} from "@aws-sdk/client-sqs";
import { z } from "zod";
import { ApplicationError, TransientInfrastructureError } from "../../application/errors";
import type { Logger, Metrics } from "../../application/observability";
import type { Clock, UnitOfWork } from "../../application/ports";
import type { ProcessWagerTransaction, WagerResult } from "../../application/wagering/process-wager-transaction";
import { InboxMessage } from "../../domain/messaging/inbox-message";
import { canonicalJson } from "../../domain/wagering/payload-hash";
import { createHash } from "node:crypto";

/** Envelope da mensagem `WagerTransactionRequested` (README, seção 10). */
const messageSchema = z.object({
  messageId: z.string().min(1).max(256),
  type: z.literal("WagerTransactionRequested"),
  occurredAt: z.string().min(1),
  correlationId: z.string().min(1).max(128).optional(),
  data: z
    .object({
      providerId: z.string().min(1).max(128),
      externalTransactionId: z.string().min(1).max(128),
      idempotencyKey: z.string().min(1).max(256),
      playerId: z.uuid(),
      walletId: z.uuid(),
      roundId: z.string().min(1).max(128),
      gameId: z.string().min(1).max(128),
      kind: z.enum(["BET", "WIN", "LOSS", "REFUND", "ROLLBACK"]),
      money: z.object({ amount: z.string(), currency: z.string() }).strict(),
      referenceExternalTransactionId: z.string().min(1).max(128).optional(),
    })
    .strict(),
});
type WagerMessage = z.infer<typeof messageSchema>;

export interface WagerConsumerOptions {
  queueUrl: string;
  dlqUrl: string;
  consumerName: string;
  maxReceiveCount: number;
  waitTimeSeconds: number;
  retryBaseSeconds: number;
  retryMaxSeconds: number;
  shutdownTimeoutMs: number;
  /** A cada quanto tempo ler a profundidade da DLQ para a métrica `wager_dlq_depth`. */
  dlqPollIntervalMs: number;
}

/** Ganchos para testes de falha (ex.: simular a morte do processo entre o commit e o ack). */
export interface WagerConsumerHooks {
  afterCommit?: (messageId: string) => Promise<void>;
}

/** Como a mensagem terminou: decide ack, retry ou DLQ. */
type Outcome =
  | { kind: "ack"; result: WagerResult | "duplicate" }
  | { kind: "retry"; error: unknown }
  | { kind: "dlq"; reason: string; message: string };

/**
 * Consumidor da fila `wager-transactions.fifo`.
 *
 * - Usa o MESMO caso de uso da entrada HTTP (`executeIn`), dentro de uma transação que também
 *   grava a inbox `(consumerName, messageId)`: ou o efeito e o registro entram juntos, ou nenhum.
 * - `DeleteMessage` (ack) só depois do commit. Se o processo morrer antes do ack, a mensagem volta
 *   após o visibility timeout; a inbox reconhece a redelivery e só confirma, sem reaplicar.
 * - Erros: negócio (REJECTED) → ack; transitório → devolve com backoff; permanente → DLQ.
 *   O redrive da fila manda para a DLQ após `maxReceiveCount` tentativas, mesmo se o processo cair.
 * - Ordem FIFO: as mensagens de um lote são processadas em sequência. Se uma volta para a fila
 *   (retry), as seguintes do MESMO grupo (wallet) no lote são devolvidas sem processar: o SQS
 *   só as entrega de novo depois dela, e a ordem da wallet é preservada.
 * - SIGTERM (`stop`): para de buscar, conclui a mensagem em andamento e devolve as que não começaram.
 */
export class WagerConsumer {
  readonly name = "wager-consumer";
  private running = false;
  private loop: Promise<void> | undefined;
  private lastDlqPoll = 0;

  constructor(
    private readonly sqs: SQSClient,
    private readonly uow: UnitOfWork,
    private readonly processWager: ProcessWagerTransaction,
    private readonly clock: Clock,
    private readonly logger: Logger,
    private readonly metrics: Metrics,
    private readonly options: WagerConsumerOptions,
    private readonly hooks: WagerConsumerHooks = {},
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loop = this.run();
    this.logger.info("consumidor SQS iniciado", { queueUrl: this.options.queueUrl });
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    // Não aborta o long polling em andamento: um ReceiveMessage abortado do lado do cliente ainda
    // pode ter "recebido" mensagens no servidor, que ficariam invisíveis e gastariam uma tentativa.
    // O loop espera a resposta (no máximo waitTimeSeconds) e devolve o que veio sem processar.
    // O limite vale para tudo: se estourar, desiste de esperar (a mensagem em andamento ainda não
    // fez ack, então volta após o visibility timeout e a inbox impede efeito duplicado).
    const timedOut = await Promise.race([
      (this.loop ?? Promise.resolve()).then(
        () => false,
        () => false,
      ),
      sleep(this.options.shutdownTimeoutMs).then(() => true),
    ]);
    this.logger.info("consumidor SQS parado", { timedOut });
  }

  private async run(): Promise<void> {
    while (this.running) {
      await this.pollDlqDepth();
      let messages: Message[] = [];
      try {
        const res = await this.sqs.send(
          new ReceiveMessageCommand({
            QueueUrl: this.options.queueUrl,
            MaxNumberOfMessages: 10,
            WaitTimeSeconds: this.options.waitTimeSeconds,
            MessageSystemAttributeNames: ["ApproximateReceiveCount", "MessageGroupId"],
          }),
        );
        messages = res.Messages ?? [];
      } catch (error) {
        if (!this.running) break;
        this.logger.warn("falha ao buscar mensagens do SQS; tentando de novo", { error: errorMessage(error) });
        await sleep(1_000);
        continue;
      }

      // Em sequência: mensagens do mesmo grupo (wallet) chegam em ordem e devem ser aplicadas em ordem.
      const blockedGroups = new Set<string>();
      for (const [index, message] of messages.entries()) {
        if (!this.running) {
          await this.release(messages.slice(index));
          break;
        }
        const group = message.Attributes?.MessageGroupId;
        if (group !== undefined && blockedGroups.has(group)) {
          await this.release([message]);
          continue;
        }
        const outcome = await this.handle(message);
        if (outcome === "retry" && group !== undefined) blockedGroups.add(group);
      }
    }
  }

  /** Atualiza a métrica de profundidade da DLQ, no máximo a cada `dlqPollIntervalMs`. Só observação: nunca falha. */
  private async pollDlqDepth(): Promise<void> {
    const now = Date.now();
    if (now - this.lastDlqPoll < this.options.dlqPollIntervalMs) return;
    this.lastDlqPoll = now;
    try {
      const res = await this.sqs.send(
        new GetQueueAttributesCommand({ QueueUrl: this.options.dlqUrl, AttributeNames: ["ApproximateNumberOfMessages"] }),
      );
      this.metrics.dlqDepth(Number(res.Attributes?.ApproximateNumberOfMessages ?? 0));
    } catch (error) {
      this.logger.warn("falha ao ler a profundidade da DLQ", { error: errorMessage(error) });
    }
  }

  /** Processa uma mensagem do início ao fim. Nunca lança: toda falha vira ack, retry ou DLQ. */
  async handle(message: Message): Promise<Outcome["kind"]> {
    const started = performance.now();
    const receiveCount = Number(message.Attributes?.ApproximateReceiveCount ?? "1");
    const outcome = await this.process(message);
    const fields = { messageId: this.messageIdOf(message), receiveCount };

    try {
      switch (outcome.kind) {
        case "ack": {
          await this.hooks.afterCommit?.(fields.messageId);
          await this.ack(message);
          if (outcome.result === "duplicate") {
            this.metrics.duplicateDetected("inbox");
          } else {
            if (outcome.result.idempotentReplay) this.metrics.duplicateDetected("idempotency_replay");
            else this.metrics.transactionProcessed(outcome.result.status, "sqs");
            this.metrics.processingLatency((performance.now() - started) / 1000, "sqs");
          }
          return "ack";
        }
        case "retry": {
          if (outcome.error instanceof ApplicationError && outcome.error.details?.sqlState === "55P03") {
            this.metrics.lockConflict("lock_timeout");
          }
          const delay = Math.min(this.options.retryBaseSeconds * 2 ** (receiveCount - 1), this.options.retryMaxSeconds);
          this.metrics.retry("sqs");
          this.logger.warn("falha transitória; mensagem volta para a fila", {
            ...fields, delaySeconds: delay, error: errorMessage(outcome.error),
            willGoToDlq: receiveCount >= this.options.maxReceiveCount,
          });
          await this.sqs.send(
            new ChangeMessageVisibilityCommand({
              QueueUrl: this.options.queueUrl, ReceiptHandle: message.ReceiptHandle, VisibilityTimeout: delay,
            }),
          );
          return "retry";
        }
        case "dlq":
          await this.sendToDlq(message, outcome.reason, outcome.message);
          return "dlq";
      }
    } catch (error) {
      // Ack/visibilidade falhou: a mensagem volta sozinha após o visibility timeout; a inbox protege.
      this.logger.warn("falha ao confirmar mensagem no SQS", { ...fields, error: errorMessage(error) });
      return "retry";
    }
  }

  private async process(message: Message): Promise<Outcome> {
    let envelope: WagerMessage;
    try {
      envelope = messageSchema.parse(JSON.parse(message.Body ?? ""));
    } catch (error) {
      return { kind: "dlq", reason: "INVALID_MESSAGE", message: errorMessage(error).slice(0, 500) };
    }
    const { data } = envelope;
    const fields = {
      messageId: envelope.messageId,
      correlationId: envelope.correlationId ?? envelope.messageId,
      walletId: data.walletId,
      providerId: data.providerId,
    };
    const payloadHash = createHash("sha256").update(canonicalJson(envelope)).digest("hex");

    try {
      const result = await this.uow.run(async (store) => {
        const now = this.clock.now();
        const inbox = InboxMessage.receive({
          consumerName: this.options.consumerName,
          messageId: envelope.messageId,
          payloadHash,
          receivedAt: now,
        });
        inbox.markProcessed(now); // gravado no mesmo COMMIT do efeito: se a transação cair, nada fica
        const first = await store.registerInbox(inbox);
        if (!first) {
          const stored = await store.findInbox(this.options.consumerName, envelope.messageId);
          if (stored?.payloadHash !== payloadHash) {
            this.logger.warn("messageId repetido com conteúdo diferente; mantida a primeira versão", fields);
          }
          return "duplicate" as const;
        }
        return this.processWager.executeIn(store, data, {
          correlationId: fields.correlationId,
          causationId: envelope.messageId,
        });
      });
      if (result === "duplicate") {
        this.logger.info("mensagem duplicada ignorada (inbox)", fields);
      } else {
        if (!result.idempotentReplay) await this.processWager.wakeDependents(result, data.providerId, data.externalTransactionId);
        this.logger.info("transação processada via SQS", {
          ...fields, transactionId: result.transactionId, status: result.status,
          failureCode: result.failureCode, idempotentReplay: result.idempotentReplay,
        });
      }
      return { kind: "ack", result };
    } catch (error) {
      if (error instanceof ApplicationError && error.category !== "transient") {
        // Payload inválido, wallet inexistente, conflito de idempotência: reenviar não resolve.
        this.logger.warn("mensagem com erro permanente", { ...fields, code: error.code, error: error.message });
        return { kind: "dlq", reason: error.code, message: error.message };
      }
      if (error instanceof TransientInfrastructureError || error instanceof ApplicationError) {
        return { kind: "retry", error };
      }
      // Erro inesperado (possível bug): trata como transitório; o redrive manda para a DLQ se persistir.
      this.logger.error("erro inesperado ao processar mensagem", { ...fields, error: errorMessage(error) });
      return { kind: "retry", error };
    }
  }

  private async ack(message: Message): Promise<void> {
    await this.sqs.send(new DeleteMessageCommand({ QueueUrl: this.options.queueUrl, ReceiptHandle: message.ReceiptHandle }));
  }

  /** Erro permanente: copia para a DLQ com o motivo e remove da fila principal. */
  private async sendToDlq(message: Message, reason: string, detail: string): Promise<void> {
    const messageId = this.messageIdOf(message);
    await this.sqs.send(
      new SendMessageCommand({
        QueueUrl: this.options.dlqUrl,
        MessageBody: message.Body ?? "",
        // Grupo próprio por mensagem: na DLQ não há ordem a preservar, e um grupo único
        // bloquearia as demais enquanto uma estivesse sendo inspecionada.
        MessageGroupId: messageId.slice(0, 128),
        MessageDeduplicationId: (message.MessageId ?? messageId).slice(0, 128),
        MessageAttributes: {
          failureReason: { DataType: "String", StringValue: reason },
          failureDetail: { DataType: "String", StringValue: detail.slice(0, 256) || reason },
        },
      }),
    );
    await this.ack(message);
    this.metrics.sentToDlq(reason);
    this.logger.warn("mensagem enviada para a DLQ", { messageId, reason });
  }

  /** Devolve à fila, imediatamente, mensagens recebidas que não chegaram a ser processadas. */
  private async release(messages: Message[]): Promise<void> {
    await Promise.allSettled(
      messages.map((m) =>
        this.sqs.send(new ChangeMessageVisibilityCommand({ QueueUrl: this.options.queueUrl, ReceiptHandle: m.ReceiptHandle, VisibilityTimeout: 0 })),
      ),
    );
  }

  private messageIdOf(message: Message): string {
    try {
      const parsed = JSON.parse(message.Body ?? "") as { messageId?: unknown };
      if (typeof parsed.messageId === "string") return parsed.messageId;
    } catch {
      // corpo inválido
    }
    return message.MessageId ?? "unknown";
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
