import { type DynamicModule, type MiddlewareConsumer, Module, type NestModule } from "@nestjs/common";
import { APP_FILTER } from "@nestjs/core";
import { MikroORM } from "@mikro-orm/postgresql";
import { MikroOrmModule } from "@mikro-orm/nestjs";
import { CLOCK, type Clock, ID_GENERATOR, type IdGenerator, UNIT_OF_WORK, type UnitOfWork } from "./application/ports";
import { LOGGER, type Logger, METRICS } from "./application/observability";
import { ProcessWagerTransaction } from "./application/wagering/process-wager-transaction";
import { CreateWallet } from "./application/wallets/create-wallet";
import { ReconcileWallet } from "./application/wallets/reconcile-wallet";
import type { AppConfig } from "./infrastructure/config";
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
        {
          provide: READINESS_CHECKS,
          inject: [MikroORM],
          useFactory: (orm: MikroORM): ReadinessCheck[] => [
            { name: "postgres", check: async () => void (await orm.em.fork().getConnection().execute("select 1")) },
          ],
        },
        ProviderAuthGuard,
        { provide: APP_FILTER, useClass: HttpErrorsFilter },
      ],
      exports: [LOGGER, METRICS, PROM_METRICS, CLOCK, ID_GENERATOR, UNIT_OF_WORK, PROCESS_WAGER, APP_CONFIG],
    };
  }

  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(CorrelationMiddleware).forRoutes("*");
  }
}
