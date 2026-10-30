import { describe, expect, test } from "bun:test";
import type { ArgumentsHost } from "@nestjs/common";
import { IdempotencyConflictError, TransientInfrastructureError, ValidationError } from "../../src/application/errors";
import type { Logger, Metrics } from "../../src/application/observability";
import { InvalidTransactionStateError, UnbalancedLedgerEntryError } from "../../src/domain/shared/domain-error";
import { HttpErrorsFilter } from "../../src/interface/http/http-errors.filter";

function run(exception: unknown) {
  const res = { statusCode: 0, headers: {} as Record<string, string>, payload: undefined as any };
  const response = {
    status(code: number) {
      res.statusCode = code;
      return response;
    },
    headersSent: false,
    setHeader(name: string, value: string) {
      res.headers[name.toLowerCase()] = value;
    },
    json(body: unknown) {
      res.payload = body;
    },
  };
  const request = { method: "POST", path: "/wagering/transactions", correlationId: "corr-1", header: () => undefined };
  const host = {
    switchToHttp: () => ({ getResponse: () => response, getRequest: () => request }),
  } as unknown as ArgumentsHost;
  const logs: { level: string; msg: string; fields: any }[] = [];
  const rejected: string[] = [];
  const logger: Logger = {
    info: (msg, fields) => logs.push({ level: "info", msg, fields }),
    warn: (msg, fields) => logs.push({ level: "warn", msg, fields }),
    error: (msg, fields) => logs.push({ level: "error", msg, fields }),
  };
  const metrics = { requestRejected: (code: string) => rejected.push(code), lockConflict: () => {} } as unknown as Metrics;
  new HttpErrorsFilter(logger, metrics).catch(exception, host);
  return { res, logs, rejected };
}

describe("HttpErrorsFilter", () => {
  test("erro de programação do domínio vira 500 e log de erro, não 400", () => {
    for (const error of [new InvalidTransactionStateError("PROCESSED", "REJECTED"), new UnbalancedLedgerEntryError("x")]) {
      const { res, logs } = run(error);
      expect(res.statusCode).toBe(500);
      expect(res.payload.error.code).toBe("INTERNAL_ERROR");
      expect(logs[0]?.level).toBe("error");
    }
  });

  test("400 e 409 são contados e logados só com código e campos, sem valores enviados", () => {
    const invalid = run(new ValidationError("corpo inválido", { issues: [{ path: "money.amount", message: "x" }] }));
    expect(invalid.res.statusCode).toBe(400);
    expect(invalid.rejected).toEqual(["INVALID_PAYLOAD"]);
    expect(invalid.logs[0]?.fields).toMatchObject({ status: 400, code: "INVALID_PAYLOAD", fields: ["money.amount"] });

    const conflict = run(new IdempotencyConflictError("conflito", { reason: "PAYLOAD_MISMATCH" }));
    expect(conflict.res.statusCode).toBe(409);
    expect(conflict.rejected).toEqual(["IDEMPOTENCY_CONFLICT"]);
  });

  test("falha transitória → 503 com Retry-After e correlationId no corpo", () => {
    const { res } = run(new TransientInfrastructureError("banco indisponível"));
    expect(res.statusCode).toBe(503);
    expect(res.headers["retry-after"]).toBe("1");
    expect(res.payload.error).toMatchObject({ code: "TRANSIENT_FAILURE", correlationId: "corr-1" });
  });
});
