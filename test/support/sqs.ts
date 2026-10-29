import {
  GetQueueAttributesCommand,
  type Message,
  ReceiveMessageCommand,
  SendMessageCommand,
  type SQSClient,
} from "@aws-sdk/client-sqs";
import type { INestApplication } from "@nestjs/common";
import { QUEUE_URLS, SQS_CLIENT } from "../../src/app.module";
import { LOGGER, METRICS } from "../../src/application/observability";
import { CLOCK, UNIT_OF_WORK, type UnitOfWork } from "../../src/application/ports";
import type { QueueUrls } from "../../src/infrastructure/messaging/queue-setup";
import { WagerConsumer, type WagerConsumerHooks } from "../../src/infrastructure/messaging/wager-consumer";
import { PROCESS_WAGER } from "../../src/interface/http/tokens";
import type { WagerPayload } from "./app";

export function sqsOf(app: INestApplication) {
  const sqs = app.get<SQSClient>(SQS_CLIENT);
  const queues = app.get<QueueUrls>(QUEUE_URLS);
  return { sqs, queues };
}

/** Publica uma `WagerTransactionRequested`. O DeduplicationId do broker é aleatório de propósito:
 *  assim simulamos entregas repetidas que o FIFO não filtraria (at-least-once). */
export async function publishWager(
  app: INestApplication,
  data: WagerPayload,
  options: { messageId?: string; idempotencyKey?: string; rawBody?: string; occurredAt?: string } = {},
): Promise<string> {
  const { sqs, queues } = sqsOf(app);
  const messageId = options.messageId ?? `msg-${crypto.randomUUID()}`;
  const body =
    options.rawBody ??
    JSON.stringify({
      messageId,
      type: "WagerTransactionRequested",
      occurredAt: options.occurredAt ?? new Date().toISOString(),
      data: { ...data, idempotencyKey: options.idempotencyKey ?? `${data.providerId}:${data.externalTransactionId}` },
    });
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: queues.wagerQueueUrl,
      MessageBody: body,
      MessageGroupId: data.walletId,
      MessageDeduplicationId: crypto.randomUUID(),
    }),
  );
  return messageId;
}

/** Monta um consumidor avulso com as dependências reais da aplicação (para injetar falhas). */
export function buildConsumer(
  app: INestApplication,
  overrides: { uow?: UnitOfWork; hooks?: WagerConsumerHooks; shutdownTimeoutMs?: number } = {},
): WagerConsumer {
  const { sqs, queues } = sqsOf(app);
  return new WagerConsumer(
    sqs,
    overrides.uow ?? app.get(UNIT_OF_WORK),
    app.get(PROCESS_WAGER),
    app.get(CLOCK),
    app.get(LOGGER),
    app.get(METRICS),
    {
      queueUrl: queues.wagerQueueUrl,
      dlqUrl: queues.wagerDlqUrl,
      consumerName: "wager-transactions-consumer",
      maxReceiveCount: 3,
      waitTimeSeconds: 1,
      retryBaseSeconds: 0,
      retryMaxSeconds: 0,
      shutdownTimeoutMs: overrides.shutdownTimeoutMs ?? 5_000,
      dlqPollIntervalMs: 200,
    },
    overrides.hooks,
  );
}

export async function receiveAll(sqs: SQSClient, queueUrl: string, waitSeconds = 1): Promise<Message[]> {
  const res = await sqs.send(
    new ReceiveMessageCommand({
      QueueUrl: queueUrl, MaxNumberOfMessages: 10, WaitTimeSeconds: waitSeconds,
      MessageAttributeNames: ["All"], VisibilityTimeout: 30,
    }),
  );
  return res.Messages ?? [];
}

export async function queueDepth(sqs: SQSClient, queueUrl: string): Promise<{ visible: number; inFlight: number }> {
  const res = await sqs.send(
    new GetQueueAttributesCommand({
      QueueUrl: queueUrl,
      AttributeNames: ["ApproximateNumberOfMessages", "ApproximateNumberOfMessagesNotVisible"],
    }),
  );
  return {
    visible: Number(res.Attributes?.ApproximateNumberOfMessages ?? 0),
    inFlight: Number(res.Attributes?.ApproximateNumberOfMessagesNotVisible ?? 0),
  };
}

export async function waitFor<T>(fn: () => Promise<T | undefined | false>, timeoutMs = 15_000, what = "condição"): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value !== undefined && value !== false) return value;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timeout esperando ${what}`);
}
