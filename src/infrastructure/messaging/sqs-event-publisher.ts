import { SendMessageBatchCommand, type SQSClient } from "@aws-sdk/client-sqs";

export interface PublishableEvent {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Record<string, unknown>;
}

export interface EventPublisher {
  /** Publica e devolve, por evento, se deu certo. Nunca lança por falha parcial. */
  publish(events: PublishableEvent[]): Promise<Map<string, string | undefined>>;
}

/**
 * Publica eventos de integração na fila `wallet-events.fifo`.
 * `MessageDeduplicationId = eventId`: uma republicação dentro de 5 min é descartada pelo SQS
 * (otimização). Fora dessa janela, o consumidor deduplica pelo `eventId` do envelope.
 */
export class SqsEventPublisher implements EventPublisher {
  constructor(
    private readonly sqs: SQSClient,
    private readonly queueUrl: string,
  ) {}

  async publish(events: PublishableEvent[]): Promise<Map<string, string | undefined>> {
    const results = new Map<string, string | undefined>();
    for (let i = 0; i < events.length; i += 10) {
      const chunk = events.slice(i, i + 10);
      try {
        const res = await this.sqs.send(
          new SendMessageBatchCommand({
            QueueUrl: this.queueUrl,
            Entries: chunk.map((e, index) => ({
              Id: String(index),
              MessageBody: JSON.stringify(e.payload),
              MessageGroupId: e.aggregateId.slice(0, 128),
              MessageDeduplicationId: e.id,
              MessageAttributes: { eventType: { DataType: "String", StringValue: e.eventType } },
            })),
          }),
        );
        for (const ok of res.Successful ?? []) results.set(chunk[Number(ok.Id)]?.id ?? "", undefined);
        for (const failed of res.Failed ?? []) {
          results.set(chunk[Number(failed.Id)]?.id ?? "", failed.Message ?? failed.Code ?? "falha no envio");
        }
      } catch (error) {
        for (const e of chunk) results.set(e.id, error instanceof Error ? error.message : String(error));
      }
    }
    return results;
  }
}
