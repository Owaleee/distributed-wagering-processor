import { Body, Controller, Get, Headers, Inject, Param, Post, Req, Res, UseGuards } from "@nestjs/common";
import type { Request, Response } from "express";
import { TransactionNotFoundError } from "../../application/errors";
import { LOGGER, type Logger, METRICS, type Metrics } from "../../application/observability";
import type { ProcessWagerTransaction, WagerResult } from "../../application/wagering/process-wager-transaction";
import { WagerTransactionStatus } from "../../domain/wagering/wager-transaction";
import type { ReadModel, TransactionView } from "../../infrastructure/persistence/read-model";
import { ProviderAuthGuard } from "./provider-auth.guard";
import { idempotencyKeySchema, parse, wagerPayloadSchema } from "./schemas";
import { PROCESS_WAGER, READ_MODEL } from "./tokens";

type Req = Request & { correlationId?: string };

/**
 * Status HTTP por estado da transação. Um replay responde com o estado ATUAL da transação
 * registrada: uma PENDING_REFERENCE (202) que já foi resolvida volta como 200 ou 422.
 *
 * FAILED não é rejeição de negócio: o processamento falhou do nosso lado e a transação foi
 * encerrada sem efeito no saldo. Responde 500 com o corpo da transação, e reenviar com a mesma
 * chave devolve o mesmo resultado (não reprocessa).
 */
const STATUS_BY_RESULT: Record<WagerTransactionStatus, number> = {
  [WagerTransactionStatus.Pending]: 202,
  [WagerTransactionStatus.Processed]: 200,
  [WagerTransactionStatus.PendingReference]: 202,
  [WagerTransactionStatus.Rejected]: 422,
  [WagerTransactionStatus.Failed]: 500,
};

@Controller()
@UseGuards(ProviderAuthGuard)
export class WageringController {
  constructor(
    @Inject(PROCESS_WAGER) private readonly processWager: ProcessWagerTransaction,
    @Inject(READ_MODEL) private readonly readModel: ReadModel,
    @Inject(LOGGER) private readonly logger: Logger,
    @Inject(METRICS) private readonly metrics: Metrics,
  ) {}

  @Post("wagering/transactions")
  async submit(
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Body() body: unknown,
    @Req() req: Req,
    @Res({ passthrough: true }) res: Response,
  ): Promise<WagerResult> {
    const key = parse(idempotencyKeySchema, idempotencyKey, "header Idempotency-Key (obrigatório)");
    const payload = parse(wagerPayloadSchema, body, "corpo da requisição");
    const correlationId = req.correlationId ?? crypto.randomUUID();
    const started = performance.now();

    const result = await this.processWager.execute({ ...payload, idempotencyKey: key }, { correlationId });

    this.metrics.processingLatency((performance.now() - started) / 1000, "http");
    if (result.idempotentReplay) this.metrics.duplicateDetected("idempotency_replay");
    else this.metrics.transactionProcessed(result.status, "http");
    this.logger.info("transação recebida via HTTP", {
      correlationId,
      transactionId: result.transactionId,
      walletId: payload.walletId,
      providerId: payload.providerId,
      kind: payload.kind,
      status: result.status,
      failureCode: result.failureCode,
      idempotentReplay: result.idempotentReplay,
    });
    res.status(STATUS_BY_RESULT[result.status]);
    return result;
  }

  @Get("wagering/transactions/:transactionId")
  async byId(@Param("transactionId") transactionId: string): Promise<TransactionView> {
    const tx = await this.readModel.transactionById(transactionId);
    if (tx === undefined) throw new TransactionNotFoundError(`transação ${transactionId} não encontrada`, { transactionId });
    return tx;
  }

  @Get("providers/:providerId/wagering/transactions/:externalTransactionId")
  async byExternalId(
    @Param("providerId") providerId: string,
    @Param("externalTransactionId") externalTransactionId: string,
  ): Promise<TransactionView> {
    const tx = await this.readModel.transactionByExternalId(providerId, externalTransactionId);
    if (tx === undefined) {
      throw new TransactionNotFoundError("transação não encontrada", { providerId, externalTransactionId });
    }
    return tx;
  }
}
