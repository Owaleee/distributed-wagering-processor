import { CreateQueueCommand, GetQueueAttributesCommand, type SQSClient } from "@aws-sdk/client-sqs";
import type { AppConfig } from "../config";

export interface QueueUrls {
  readonly wagerQueueUrl: string;
  readonly wagerDlqUrl: string;
  readonly eventsQueueUrl: string;
}

/**
 * Cria as filas se não existirem (CreateQueue é idempotente quando os atributos são iguais).
 * A DLQ é ligada à fila principal por RedrivePolicy: depois de `maxReceiveCount`
 * recebimentos sem ack, o próprio SQS move a mensagem para a DLQ.
 */
export async function ensureQueues(sqs: SQSClient, config: AppConfig): Promise<QueueUrls> {
  const fifo = { FifoQueue: "true", ContentBasedDeduplication: "false" };

  const dlq = await sqs.send(new CreateQueueCommand({ QueueName: config.sqs.wagerDlqName, Attributes: fifo }));
  const wagerDlqUrl = required(dlq.QueueUrl, config.sqs.wagerDlqName);
  const dlqAttributes = await sqs.send(
    new GetQueueAttributesCommand({ QueueUrl: wagerDlqUrl, AttributeNames: ["QueueArn"] }),
  );
  const dlqArn = required(dlqAttributes.Attributes?.QueueArn, `${config.sqs.wagerDlqName} (ARN)`);

  const main = await sqs.send(
    new CreateQueueCommand({
      QueueName: config.sqs.wagerQueueName,
      Attributes: {
        ...fifo,
        VisibilityTimeout: String(config.sqs.visibilityTimeoutSeconds),
        RedrivePolicy: JSON.stringify({ deadLetterTargetArn: dlqArn, maxReceiveCount: config.sqs.maxReceiveCount }),
      },
    }),
  );
  const events = await sqs.send(new CreateQueueCommand({ QueueName: config.sqs.eventsQueueName, Attributes: fifo }));

  return {
    wagerQueueUrl: required(main.QueueUrl, config.sqs.wagerQueueName),
    wagerDlqUrl,
    eventsQueueUrl: required(events.QueueUrl, config.sqs.eventsQueueName),
  };
}

function required(value: string | undefined, what: string): string {
  if (value === undefined || value === "") throw new Error(`SQS não retornou a URL/ARN de ${what}`);
  return value;
}
