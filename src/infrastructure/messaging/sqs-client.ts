import { SQSClient } from "@aws-sdk/client-sqs";
import type { AppConfig } from "../config";

export function createSqsClient(config: AppConfig): SQSClient {
  return new SQSClient({
    endpoint: config.sqs.endpoint,
    region: config.sqs.region,
    credentials: { accessKeyId: config.sqs.accessKeyId, secretAccessKey: config.sqs.secretAccessKey },
  });
}
