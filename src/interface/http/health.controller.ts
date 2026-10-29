import { Controller, Get, HttpCode, Inject, Res } from "@nestjs/common";
import type { Response } from "express";
import type { PromMetrics } from "../../infrastructure/observability/prom-metrics";
import { PROM_METRICS, READINESS_CHECKS, type ReadinessCheck } from "./tokens";

/** Health checks (abertos, sem autenticação) e métricas Prometheus. */
@Controller()
export class HealthController {
  constructor(
    @Inject(READINESS_CHECKS) private readonly checks: ReadinessCheck[],
    @Inject(PROM_METRICS) private readonly metrics: PromMetrics,
  ) {}

  /** Processo vivo: não toca dependências (um banco fora do ar não deve reiniciar o processo). */
  @Get("health/live")
  live(): { status: "ok" } {
    return { status: "ok" };
  }

  /** Pronto para receber tráfego: PostgreSQL e SQS alcançáveis. */
  @Get("health/ready")
  @HttpCode(200)
  async ready(@Res({ passthrough: true }) res: Response) {
    const results = await Promise.all(
      this.checks.map(async (c) => {
        try {
          await withTimeout(c.check(), 2_000);
          return [c.name, "up"] as const;
        } catch {
          return [c.name, "down"] as const;
        }
      }),
    );
    const ok = results.every(([, s]) => s === "up");
    if (!ok) res.status(503);
    return { status: ok ? "ok" : "unavailable", checks: Object.fromEntries(results) };
  }

  @Get("metrics")
  async prometheus(@Res() res: Response): Promise<void> {
    res.setHeader("Content-Type", this.metrics.registry.contentType);
    res.send(await this.metrics.registry.metrics());
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error("timeout")), ms))]);
}
