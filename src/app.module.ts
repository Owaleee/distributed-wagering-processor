import { type DynamicModule, Module } from "@nestjs/common";
import type { AppConfig } from "./infrastructure/config";
import { HealthController } from "./interface/http/health.controller";

export const APP_CONFIG = Symbol("APP_CONFIG");

/**
 * Composição da aplicação: aqui as portas da camada de aplicação recebem as implementações
 * de infraestrutura. Cada fase do projeto acrescenta suas peças a este módulo.
 */
@Module({})
export class AppModule {
  static forRoot(config: AppConfig): DynamicModule {
    return {
      module: AppModule,
      controllers: [HealthController],
      providers: [{ provide: APP_CONFIG, useValue: config }],
    };
  }
}
