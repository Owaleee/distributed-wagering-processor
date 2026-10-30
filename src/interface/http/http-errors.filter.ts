import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException, Inject } from "@nestjs/common";
import type { Request, Response } from "express";
import { ApplicationError } from "../../application/errors";
import { LOGGER, type Logger, METRICS, type Metrics } from "../../application/observability";

/**
 * Um único mapeamento de erro → status para toda a API, para o provedor saber se pode reenviar:
 *   400 payload inválido · 404 inexistente · 409 conflito (idempotência, wallet duplicada)
 *   503 falha transitória (reenviar com a mesma Idempotency-Key é seguro) · 500 inesperado
 * Rejeição de negócio NÃO é erro: o controller responde 422 com a transação REJECTED.
 *
 * Um `DomainError` que chega até aqui é erro de programação: os casos de uso já convertem
 * entradas inválidas em `ValidationError`. Por isso ele vira 500 e é logado como erro, em vez
 * de se disfarçar de "payload inválido".
 */
@Catch()
export class HttpErrorsFilter implements ExceptionFilter {
  constructor(
    @Inject(LOGGER) private readonly logger: Logger,
    @Inject(METRICS) private readonly metrics: Metrics,
  ) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const res = http.getResponse<Response>();
    const req = http.getRequest<Request & { correlationId?: string }>();
    // Erros do parser do corpo (JSON inválido, corpo grande demais) acontecem antes do middleware de
    // correlação: o id é criado aqui, para que TODO erro tenha correlationId no corpo e no header.
    const correlationId = req.correlationId ?? correlationFrom(req);
    if (!res.headersSent) res.setHeader("x-correlation-id", correlationId);
    const route = `${req.method} ${req.route?.path ?? req.path}`;

    if (exception instanceof ApplicationError) {
      const status = { invalid: 400, not_found: 404, conflict: 409, transient: 503 }[exception.category];
      res.status(status);
      if (status === 503) {
        res.setHeader("Retry-After", "1");
        if (exception.details?.sqlState === "55P03") this.metrics.lockConflict("lock_timeout");
        this.logger.warn("falha transitória", { correlationId, route, code: exception.code, sqlState: exception.details?.sqlState });
      } else {
        this.metrics.requestRejected(exception.code);
        // Só o código e os campos com problema: o log nunca recebe o payload nem os valores enviados.
        this.logger.info("requisição recusada", { correlationId, route, status, code: exception.code, fields: fieldsOf(exception) });
      }
      res.json(body(exception.code, exception.message, exception.details, correlationId));
      return;
    }
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const code = HTTP_CODES[status] ?? "HTTP_ERROR";
      if (status < 500) this.metrics.requestRejected(code);
      res.status(status).json(body(code, exception.message, undefined, correlationId));
      return;
    }
    this.logger.error("erro inesperado", {
      correlationId,
      route,
      error: exception instanceof Error ? `${exception.name}: ${exception.message}` : String(exception),
      stack: exception instanceof Error ? exception.stack : undefined,
    });
    res.status(500).json(body("INTERNAL_ERROR", "erro interno", undefined, correlationId));
  }
}

const HTTP_CODES: Record<number, string> = {
  400: "INVALID_PAYLOAD",
  404: "ROUTE_NOT_FOUND",
  405: "METHOD_NOT_ALLOWED",
  413: "PAYLOAD_TOO_LARGE",
  415: "UNSUPPORTED_MEDIA_TYPE",
};

function correlationFrom(req: Request): string {
  const incoming = req.header("x-correlation-id");
  return incoming !== undefined && /^[\w.:-]{1,128}$/.test(incoming) ? incoming : crypto.randomUUID();
}

function fieldsOf(error: ApplicationError): string[] | undefined {
  const issues = error.details?.issues;
  if (Array.isArray(issues)) return issues.map((i: { path?: string }) => i.path ?? "");
  const field = error.details?.field;
  return typeof field === "string" ? [field] : undefined;
}

function body(code: string, message: string, details: unknown, correlationId: string | undefined) {
  return { error: { code, message, ...(details !== undefined ? { details } : {}), ...(correlationId ? { correlationId } : {}) } };
}
