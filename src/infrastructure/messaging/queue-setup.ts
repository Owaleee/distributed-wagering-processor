import { CreateQueueCommand, GetQueueAttributesCommand, GetQueueUrlCommand, type SQSClient } from "@aws-sdk/client-sqs";
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

/**
 * Localiza as filas que o `setup` criou, sem criá-las. A aplicação só usa o que já existe:
 * se uma fila faltar, o boot falha com erro claro em vez de criar uma fila com atributos errados.
 */
export async function resolveQueues(sqs: SQSClient, config: AppConfig): Promise<QueueUrls> {
  const url = async (name: string) =>
    required((await sqs.send(new GetQueueUrlCommand({ QueueName: name }))).QueueUrl, name);
  const [wagerQueueUrl, wagerDlqUrl, eventsQueueUrl] = await Promise.all([
    url(config.sqs.wagerQueueName),
    url(config.sqs.wagerDlqName),
    url(config.sqs.eventsQueueName),
  ]);
  return { wagerQueueUrl, wagerDlqUrl, eventsQueueUrl };
}

function required(value: string | undefined, what: string): string {
  if (value === undefined || value === "") throw new Error(`SQS não retornou a URL/ARN de ${what}`);
  return value;
}
