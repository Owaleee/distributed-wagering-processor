import { Injectable, type NestMiddleware } from "@nestjs/common";
import type { NextFunction, Request, Response } from "express";

/** Propaga (ou cria) o correlationId da requisição: vai para os logs, eventos e o header da resposta. */
@Injectable()
export class CorrelationMiddleware implements NestMiddleware {
  use(req: Request & { correlationId?: string }, res: Response, next: NextFunction): void {
    const incoming = req.header("x-correlation-id");
    const correlationId = incoming !== undefined && /^[\w.:-]{1,128}$/.test(incoming) ? incoming : crypto.randomUUID();
    req.correlationId = correlationId;
    res.setHeader("x-correlation-id", correlationId);
    next();
  }
}
