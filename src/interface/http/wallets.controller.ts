import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, Req, UseGuards } from "@nestjs/common";
import type { Request } from "express";
import { WalletNotFoundError } from "../../application/errors";
import type { CreateWallet, WalletView } from "../../application/wallets/create-wallet";
import type { ReconcileWallet, ReconciliationReport } from "../../application/wallets/reconcile-wallet";
import type { ReadModel } from "../../infrastructure/persistence/read-model";
import { ProviderAuthGuard } from "./provider-auth.guard";
import { createWalletSchema, decodeCursor, encodeCursor, ledgerQuerySchema, parse } from "./schemas";
import { CREATE_WALLET, READ_MODEL, RECONCILE_WALLET } from "./tokens";

type Req = Request & { correlationId?: string };

@Controller("wallets")
@UseGuards(ProviderAuthGuard)
export class WalletsController {
  constructor(
    @Inject(CREATE_WALLET) private readonly createWallet: CreateWallet,
    @Inject(RECONCILE_WALLET) private readonly reconcileWallet: ReconcileWallet,
    @Inject(READ_MODEL) private readonly readModel: ReadModel,
  ) {}

  @Post()
  @HttpCode(201)
  create(@Body() body: unknown, @Req() req: Req): Promise<WalletView> {
    const command = parse(createWalletSchema, body, "corpo da requisição");
    return this.createWallet.execute(command, { correlationId: req.correlationId ?? crypto.randomUUID() });
  }

  @Get(":walletId")
  async get(@Param("walletId") walletId: string): Promise<WalletView> {
    const wallet = await this.readModel.wallet(walletId);
    if (wallet === undefined) throw new WalletNotFoundError(walletId);
    return wallet;
  }

  @Get(":walletId/ledger")
  async ledger(@Param("walletId") walletId: string, @Query() query: unknown) {
    const { cursor, limit } = parse(ledgerQuerySchema, query, "query");
    const afterSeq = decodeCursor(cursor);
    if ((await this.readModel.wallet(walletId)) === undefined) throw new WalletNotFoundError(walletId);
    const page = await this.readModel.ledgerPage(walletId, afterSeq, limit);
    return {
      walletId,
      items: page.entries,
      nextCursor: page.hasMore && page.lastSeq !== undefined ? encodeCursor(page.lastSeq) : null,
    };
  }

  @Post(":walletId/reconciliation")
  @HttpCode(200)
  reconcile(@Param("walletId") walletId: string, @Req() req: Req): Promise<ReconciliationReport> {
    return this.reconcileWallet.execute(walletId, req.correlationId ?? crypto.randomUUID());
  }
}
