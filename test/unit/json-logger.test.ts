import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { JsonLogger, NestJsonLogger, mikroOrmLogWriter } from "../../src/infrastructure/observability/json-logger";

let lines: Record<string, unknown>[];
let spy: ReturnType<typeof spyOn>;
let previousLevel: string | undefined;

beforeEach(() => {
  lines = [];
  previousLevel = process.env.LOG_LEVEL;
  process.env.LOG_LEVEL = "info";
  spy = spyOn(process.stdout, "write").mockImplementation(((chunk: string) => {
    lines.push(JSON.parse(chunk));
    return true;
  }) as typeof process.stdout.write);
});
afterEach(() => {
  spy.mockRestore();
  process.env.LOG_LEVEL = previousLevel;
});

describe("JsonLogger", () => {
  test("uma linha JSON por evento, com os campos de correlação", () => {
    new JsonLogger({ service: "svc" }).info("transação processada", {
      correlationId: "c-1", messageId: "m-1", transactionId: "t-1", walletId: "w-1", providerId: "p-1",
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      level: "info", msg: "transação processada", service: "svc",
      correlationId: "c-1", messageId: "m-1", transactionId: "t-1", walletId: "w-1", providerId: "p-1",
    });
    expect(typeof lines[0]?.time).toBe("string");
  });

  test("LOG_LEVEL filtra por nível", () => {
    const logger = new JsonLogger();
    process.env.LOG_LEVEL = "warn";
    logger.info("some");
    logger.warn("fica");
    logger.error("fica também");
    process.env.LOG_LEVEL = "silent";
    logger.error("some");
    expect(lines.map((l) => l.msg)).toEqual(["fica", "fica também"]);
  });
});

describe("logs do Nest e do MikroORM no mesmo formato", () => {
  test("Nest: contexto e stack viram campos", () => {
    const nest = new NestJsonLogger(new JsonLogger({ service: "svc" }));
    nest.log("Mapped {/health/live, GET} route", "RouterExplorer");
    nest.error("boot falhou", "Error: x\n    at y", "ExceptionHandler");
    expect(lines[0]).toMatchObject({ level: "info", component: "nest", context: "RouterExplorer" });
    expect(lines[1]).toMatchObject({ level: "error", msg: "boot falhou", context: "ExceptionHandler", stack: "Error: x\n    at y" });
  });

  test("MikroORM: sem códigos de cor", () => {
    mikroOrmLogWriter(new JsonLogger())("\u001b[33m[info] PostgreSQL connection error: x\u001b[39m");
    expect(lines[0]).toMatchObject({ level: "warn", component: "mikro-orm", msg: "[info] PostgreSQL connection error: x" });
  });
});
