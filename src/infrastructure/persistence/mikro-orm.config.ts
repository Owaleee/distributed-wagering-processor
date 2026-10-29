import { defineConfig } from "@mikro-orm/postgresql";
import { Migrator } from "@mikro-orm/migrations";
import { ALL_ENTITIES } from "./entities";
import { migrationsList } from "./migrations";

export interface OrmOptions {
  /**
   * Espera máxima por uma conexão livre do pool (ms). Sem isso, sob saturação a requisição
   * esperaria indefinidamente; com isso, ela falha como transitória (503) e o provedor reenvia.
   */
  connectTimeoutMs?: number;
}

export function buildOrmConfig(databaseUrl: string, options: OrmOptions = {}) {
  return defineConfig({
    clientUrl: databaseUrl,
    entities: ALL_ENTITIES,
    extensions: [Migrator],
    migrations: {
      migrationsList,
      transactional: true,
      allOrNothing: true,
      snapshot: false,
      silent: process.env.LOG_LEVEL === "silent",
    },
    pool: { min: 2, max: 20 },
    // Repassado ao Pool do driver `pg`.
    driverOptions: { connectionTimeoutMillis: options.connectTimeoutMs ?? 5_000 },
  });
}
