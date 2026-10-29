import { defineConfig } from "@mikro-orm/postgresql";
import { Migrator } from "@mikro-orm/migrations";
import { migrationsList } from "./migrations";

export function buildOrmConfig(databaseUrl: string) {
  return defineConfig({
    clientUrl: databaseUrl,
    entities: [],
    discovery: { warnWhenNoEntities: false },
    extensions: [Migrator],
    migrations: {
      migrationsList,
      transactional: true,
      allOrNothing: true,
      snapshot: false,
      silent: process.env.LOG_LEVEL === "silent",
    },
    pool: { min: 2, max: 20 },
  });
}
