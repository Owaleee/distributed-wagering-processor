import type { LoggerService } from "@nestjs/common";
import type { LogFields, Logger } from "../../application/observability";

type Level = "error" | "warn" | "info";
const RANK: Record<Level | "silent", number> = { silent: 0, error: 1, warn: 2, info: 3 };

/** Nível mínimo vindo de LOG_LEVEL (silent, error, warn, info; padrão info). Lido a cada linha: testes podem mudar. */
function enabled(level: Level): boolean {
  const configured = (process.env.LOG_LEVEL ?? "info") as keyof typeof RANK;
  return RANK[level] <= (RANK[configured] ?? RANK.info);
}

/** Log estruturado: uma linha JSON por evento, em stdout (o padrão para coletores de log). */
export class JsonLogger implements Logger {
  constructor(private readonly base: Record<string, unknown> = {}) {}

  info(msg: string, fields?: LogFields): void {
    this.write("info", msg, fields);
  }
  warn(msg: string, fields?: LogFields): void {
    this.write("warn", msg, fields);
  }
  error(msg: string, fields?: LogFields): void {
    this.write("error", msg, fields);
  }

  /** Mesmo formato, com campos fixos extras (ex.: `component`). */
  child(fields: Record<string, unknown>): JsonLogger {
    return new JsonLogger({ ...this.base, ...fields });
  }

  private write(level: Level, msg: string, fields?: LogFields): void {
    if (!enabled(level)) return;
    const line = JSON.stringify({ time: new Date().toISOString(), level, msg, ...this.base, ...fields });
    process.stdout.write(`${line}\n`);
  }
}

/**
 * Faz os logs internos do NestJS (boot, rotas, erros de bootstrap) saírem no mesmo JSON da
 * aplicação, com `component: "nest"` e o contexto do Nest. Sem isso, um erro de boot sairia em
 * texto colorido, que um coletor de logs não consegue indexar.
 */
export class NestJsonLogger implements LoggerService {
  private readonly logger: JsonLogger;

  constructor(base: JsonLogger) {
    this.logger = base.child({ component: "nest" });
  }

  log(message: unknown, ...optional: unknown[]): void {
    this.logger.info(text(message), { context: context(optional) });
  }
  warn(message: unknown, ...optional: unknown[]): void {
    this.logger.warn(text(message), { context: context(optional) });
  }
  error(message: unknown, ...optional: unknown[]): void {
    // Nest chama error(mensagem, stack?, contexto?)
    const [maybeStack, maybeContext] = optional;
    const stack = typeof maybeStack === "string" && maybeStack.includes("\n") ? maybeStack : undefined;
    this.logger.error(text(message), {
      context: stack !== undefined ? (typeof maybeContext === "string" ? maybeContext : undefined) : context(optional),
      stack: stack ?? (message instanceof Error ? message.stack : undefined),
    });
  }
  debug(): void {}
  verbose(): void {}
}

/** Mensagens do MikroORM (avisos de conexão, migrations) no mesmo JSON, sem códigos de cor. */
export function mikroOrmLogWriter(base: JsonLogger): (message: string) => void {
  const logger = base.child({ component: "mikro-orm" });
  return (message) => logger.warn(stripAnsi(message).trim());
}

function text(message: unknown): string {
  if (message instanceof Error) return `${message.name}: ${message.message}`;
  return typeof message === "string" ? message : JSON.stringify(message);
}

function context(optional: unknown[]): string | undefined {
  const last = optional.at(-1);
  return typeof last === "string" ? last : undefined;
}

function stripAnsi(value: string): string {
  // biome-ignore lint: sequências de escape ANSI
  return value.replace(/\u001b\[[0-9;]*m/g, "");
}
