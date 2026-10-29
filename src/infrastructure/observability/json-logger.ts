import type { LogFields, Logger } from "../../application/observability";

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

  private write(level: string, msg: string, fields?: LogFields): void {
    if (process.env.LOG_LEVEL === "silent") return;
    const line = JSON.stringify({ time: new Date().toISOString(), level, msg, ...this.base, ...fields });
    process.stdout.write(`${line}\n`);
  }
}
