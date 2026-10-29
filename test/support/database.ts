import { SQL } from "bun";
import { MikroORM } from "@mikro-orm/postgresql";
import { buildOrmConfig } from "../../src/infrastructure/persistence/mikro-orm.config";

/**
 * Cada suíte de integração ganha um banco PostgreSQL próprio, criado do zero e com as
 * migrations reais aplicadas. Nada de mocks: as constraints testadas são as do schema real.
 */
const ADMIN_URL = process.env.TEST_DATABASE_ADMIN_URL ?? "postgresql://postgres:postgres@localhost:5432/postgres";

export interface TestDatabase {
  readonly name: string;
  readonly url: string;
  /** Cliente SQL cru, para preparar cenários e conferir o estado do banco. */
  readonly sql: SQL;
  migrateUp(): Promise<string[]>;
  migrateDown(): Promise<string[]>;
  drop(): Promise<void>;
}

export async function createTestDatabase(options: { migrate?: boolean } = {}): Promise<TestDatabase> {
  const name = `wagering_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const admin = new SQL(ADMIN_URL);
  await admin.unsafe(`create database ${name}`);
  await admin.close();

  const url = new URL(ADMIN_URL);
  url.pathname = `/${name}`;
  const dbUrl = url.toString();
  const sql = new SQL(dbUrl);

  const withOrm = async <T>(fn: (orm: MikroORM) => Promise<T>): Promise<T> => {
    const orm = await MikroORM.init({ ...buildOrmConfig(dbUrl), debug: false });
    try {
      return await fn(orm);
    } finally {
      await orm.close();
    }
  };

  const db: TestDatabase = {
    name,
    url: dbUrl,
    sql,
    migrateUp: () => withOrm(async (orm) => (await orm.migrator.up()).map((m) => m.name)),
    migrateDown: () => withOrm(async (orm) => (await orm.migrator.down({ to: 0 })).map((m) => m.name)),
    async drop() {
      await sql.close();
      const a = new SQL(ADMIN_URL);
      await a.unsafe(`drop database if exists ${name} with (force)`);
      await a.close();
    },
  };
  if (options.migrate !== false) await db.migrateUp();
  return db;
}

/** Executa e devolve a mensagem de erro do PostgreSQL (ou falha o teste se não houver erro). */
export async function expectDbError(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("esperava que o PostgreSQL recusasse a operação, mas ela foi aceita");
}
