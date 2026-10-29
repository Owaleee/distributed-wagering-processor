/**
 * Prepara a infraestrutura: aplica as migrations pendentes e cria as filas.
 * É o ÚNICO responsável por isso: roda no serviço `setup` do docker compose, antes das
 * instâncias da aplicação (que só usam o que já existe).
 */
import "reflect-metadata";
import { MikroORM } from "@mikro-orm/postgresql";
import { loadConfig } from "../src/infrastructure/config";
import { buildOrmConfig } from "../src/infrastructure/persistence/mikro-orm.config";
import { createSqsClient } from "../src/infrastructure/messaging/sqs-client";
import { ensureQueues } from "../src/infrastructure/messaging/queue-setup";

const config = loadConfig();

const orm = await MikroORM.init(buildOrmConfig(config.databaseUrl));
try {
  const applied = await orm.migrator.up();
  console.log(JSON.stringify({ msg: "migrations aplicadas", count: applied.length, names: applied.map((m) => m.name) }));
} finally {
  await orm.close();
}

const queues = await ensureQueues(createSqsClient(config), config);
console.log(JSON.stringify({ msg: "filas prontas", ...queues }));
