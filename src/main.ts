import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule, appLogger } from "./app.module";
import { loadConfig } from "./infrastructure/config";
import { NestJsonLogger } from "./infrastructure/observability/json-logger";

const config = loadConfig();
const app = await NestFactory.create(AppModule.forRoot(config), { logger: new NestJsonLogger(appLogger) });
await app.listen(config.port);

/**
 * Encerramento gracioso: SIGTERM/SIGINT → `app.close()` para de aceitar HTTP e dispara os hooks
 * onApplicationShutdown (os processos de fundo terminam o que estão fazendo). Sai com código 0.
 * Limite rígido de 25 s para não travar um deploy.
 */
let closing = false;
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    if (closing) return;
    closing = true;
    const hardStop = setTimeout(() => process.exit(1), 25_000);
    app.close().then(
      () => {
        clearTimeout(hardStop);
        process.exit(0);
      },
      () => process.exit(1),
    );
  });
}
