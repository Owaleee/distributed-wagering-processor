import { type DynamicModule, type MiddlewareConsumer, Module, type NestModule } from "@nestjs/common";
import { APP_FILTER } from "@nestjs/core";
import { MikroORM } from "@mikro-orm/postgresql";
import { MikroOrmModule } from "@mikro-orm/nestjs";
import { GetQueueAttributesCommand, type SQSClient } from "@aws-sdk/client-sqs";
import { CLOCK, type Clock, ID_GENERATOR, type IdGenerator, UNIT_OF_WORK, type UnitOfWork } from "./application/ports";
import { LOGGER, type Logger, METRICS } from "./application/observability";
import { ProcessWagerTransaction } from "./application/wagering/process-wager-transaction";
import { CreateWallet } from "./application/wallets/create-wallet";
import { ReconcileWallet } from "./application/wallets/reconcile-wallet";
import type { AppConfig } from "./infrastructure/config";
import { BackgroundWorkers, type Startable } from "./infrastructure/messaging/messaging.lifecycle";
import { type QueueUrls, resolveQueues } from "./infrastructure/messaging/queue-setup";
import { createSqsClient } from "./infrastructure/messaging/sqs-client";
import { SqsEventPublisher } from "./infrastructure/messaging/sqs-event-publisher";
import { WagerConsumer } from "./infrastructure/messaging/wager-consumer";
import { OutboxRelay } from "./infrastructure/workers/outbox-relay";
import { PendingReferenceWorker } from "./infrastructure/workers/pending-reference-worker";
import { JsonLogger } from "./infrastructure/observability/json-logger";
import { PromMetrics } from "./infrastructure/observability/prom-metrics";
import { buildOrmConfig } from "./infrastructure/persistence/mikro-orm.config";
import { MikroOrmUnitOfWork } from "./infrastructure/persistence/mikro-orm-unit-of-work";
import { ReadModel } from "./infrastructure/persistence/read-model";
import { CorrelationMiddleware } from "./interface/http/correlation.middleware";
import { HealthController } from "./interface/http/health.controller";
import { HttpErrorsFilter } from "./interface/http/http-errors.filter";
import { ProviderAuthGuard } from "./interface/http/provider-auth.guard";
import {
  CREATE_WALLET, PROCESS_WAGER, PROM_METRICS, READ_MODEL, READINESS_CHECKS, RECONCILE_WALLET, type ReadinessCheck,
} from "./interface/http/tokens";
import { WageringController } from "./interface/http/wagering.controller";
import { WalletsController } from "./interface/http/wallets.controller";

export const APP_CONFIG = Symbol("APP_CONFIG");
export const SQS_CLIENT = Symbol("SQS_CLIENT");
export const QUEUE_URLS = Symbol("QUEUE_URLS");
export const WAGER_CONSUMER = Symbol("WAGER_CONSUMER");
export const WORKERS = Symbol("WORKERS");
export const OUTBOX_RELAY = Symbol("OUTBOX_RELAY");
export const PENDING_REFERENCE_WORKER = Symbol("PENDING_REFERENCE_WORKER");

/**
 * Composição da aplicação: aqui as portas da camada de aplicação recebem as implementações
 * de infraestrutura. Os casos de uso são classes simples, criadas por factories explícitas,
 * então podem ser testados sem o Nest.
 */
@Module({})
export class AppModule implements NestModule {
  static forRoot(config: AppConfig): DynamicModule {
    return {
      module: AppModule,
      imports: [
        MikroOrmModule.forRoot({
          ...buildOrmConfig(config.databaseUrl, { connectTimeoutMs: config.dbConnectTimeoutMs }),
          registerRequestContext: false,
        }),
      ],
      controllers: [HealthController, WalletsController, WageringController],
      providers: [
        { provide: APP_CONFIG, useValue: config },
        { provide: LOGGER, useValue: new JsonLogger({ service: "distributed-wagering-processor" }) },
        { provide: PROM_METRICS, useValue: new PromMetrics() },
        { provide: METRICS, useExisting: PROM_METRICS },
        { provide: CLOCK, useValue: { now: () => new Date() } satisfies Clock },
        { provide: ID_GENERATOR, useValue: { next: () => Bun.randomUUIDv7() } satisfies IdGenerator },
        {
          provide: UNIT_OF_WORK,
          inject: [MikroORM],
          useFactory: (orm: MikroORM) => new MikroOrmUnitOfWork(orm, { lockTimeoutMs: config.lockTimeoutMs }),
        },
        { provide: READ_MODEL, inject: [MikroORM], useFactory: (orm: MikroORM) => new ReadModel(orm) },
        {
          provide: PROCESS_WAGER,
          inject: [UNIT_OF_WORK, CLOCK, ID_GENERATOR, METRICS],
          useFactory: (uow: UnitOfWork, clock: Clock, ids: IdGenerator, metrics: PromMetrics) =>
            new ProcessWagerTransaction(uow, clock, ids, { pendingFirstDelayMs: config.pendingReference.baseDelayMs }, metrics),
        },
        {
          provide: CREATE_WALLET,
          inject: [UNIT_OF_WORK, CLOCK, ID_GENERATOR],
          useFactory: (uow: UnitOfWork, clock: Clock, ids: IdGenerator) => new CreateWallet(uow, clock, ids),
        },
        {
          provide: RECONCILE_WALLET,
          inject: [READ_MODEL, LOGGER, METRICS],
          useFactory: (rm: ReadModel, logger: Logger, metrics: PromMetrics) => new ReconcileWallet(rm, logger, metrics),
        },
        { provide: SQS_CLIENT, useFactory: () => createSqsClient(config) },
        {
          // Só localiza as filas criadas pelo `setup` (D5): a aplicação nunca cria nem altera filas.
          provide: QUEUE_URLS,
          inject: [SQS_CLIENT],
          useFactory: (sqs: SQSClient) => resolveQueues(sqs, config),
        },
        {
          provide: READINESS_CHECKS,
          inject: [MikroORM, SQS_CLIENT, QUEUE_URLS],
          useFactory: (orm: MikroORM, sqs: SQSClient, queues: QueueUrls): ReadinessCheck[] => {
            const queue = (url: string) => async () =>
              void (await sqs.send(new GetQueueAttributesCommand({ QueueUrl: url, AttributeNames: ["QueueArn"] })));
            return [
              { name: "postgres", check: async () => void (await orm.em.fork().getConnection().execute("select 1")) },
              { name: "sqs_wager_queue", check: queue(queues.wagerQueueUrl) },
              { name: "sqs_wager_dlq", check: queue(queues.wagerDlqUrl) },
              { name: "sqs_events_queue", check: queue(queues.eventsQueueUrl) },
            ];
          },
        },
        {
          provide: WAGER_CONSUMER,
          inject: [SQS_CLIENT, UNIT_OF_WORK, PROCESS_WAGER, CLOCK, LOGGER, METRICS, QUEUE_URLS],
          useFactory: (
            sqs: SQSClient, uow: UnitOfWork, processWager: ProcessWagerTransaction, clock: Clock,
            logger: Logger, metrics: PromMetrics, queues: QueueUrls,
          ) =>
            new WagerConsumer(
              sqs, uow, processWager, clock, logger, metrics,
              {
                queueUrl: queues.wagerQueueUrl,
                dlqUrl: queues.wagerDlqUrl,
                consumerName: config.consumer.name,
                maxReceiveCount: config.sqs.maxReceiveCount,
                waitTimeSeconds: config.consumer.waitTimeSeconds,
                retryBaseSeconds: config.consumer.retryBaseSeconds,
                retryMaxSeconds: config.consumer.retryMaxSeconds,
                shutdownTimeoutMs: config.consumer.shutdownTimeoutMs,
                dlqPollIntervalMs: config.consumer.dlqPollIntervalMs,
              },
              // Só em teste (FAULT_CRASH_AFTER_COMMIT): morre de verdade entre o COMMIT e o ack.
              config.faultInjection.crashAfterCommit ? { afterCommit: async () => void process.kill(process.pid, "SIGKILL") } : {},
            ),
        },
        {
          provide: OUTBOX_RELAY,
          inject: [MikroORM, SQS_CLIENT, QUEUE_URLS, CLOCK, LOGGER, METRICS],
          useFactory: (orm: MikroORM, sqs: SQSClient, queues: QueueUrls, clock: Clock, logger: Logger, metrics: PromMetrics) =>
            new OutboxRelay(orm, new SqsEventPublisher(sqs, queues.eventsQueueUrl), clock, logger, metrics, config.outbox),
        },
        {
          provide: PENDING_REFERENCE_WORKER,
          inject: [UNIT_OF_WORK, PROCESS_WAGER, CLOCK, ID_GENERATOR, LOGGER, METRICS],
          useFactory: (
            uow: UnitOfWork, processWager: ProcessWagerTransaction, clock: Clock, ids: IdGenerator, logger: Logger, metrics: PromMetrics,
          ) => new PendingReferenceWorker(uow, processWager, clock, ids, logger, metrics, config.pendingReference),
        },
        {
          provide: WORKERS,
          inject: [WAGER_CONSUMER, OUTBOX_RELAY, PENDING_REFERENCE_WORKER, LOGGER],
          useFactory: (consumer: WagerConsumer, relay: OutboxRelay, pending: PendingReferenceWorker, logger: Logger) => {
            const workers: Startable[] = [];
            if (config.consumer.enabled) workers.push(consumer);
            if (config.pendingReference.enabled) workers.push(pending);
            if (config.outbox.enabled) workers.push(relay);
            return new BackgroundWorkers(workers, logger);
          },
        },
        ProviderAuthGuard,
        { provide: APP_FILTER, useClass: HttpErrorsFilter },
      ],
      exports: [LOGGER, METRICS, PROM_METRICS, CLOCK, ID_GENERATOR, UNIT_OF_WORK, PROCESS_WAGER, APP_CONFIG, SQS_CLIENT, QUEUE_URLS, WAGER_CONSUMER, OUTBOX_RELAY, PENDING_REFERENCE_WORKER],
    };
  }

  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(CorrelationMiddleware).forRoutes("*");
  }
}
