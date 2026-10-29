import { WagerTransactionProcessed, WalletBalanceChanged } from "../../domain/messaging/integration-event";
import { OutboxMessage } from "../../domain/messaging/outbox-message";
import { Money, type MoneyProps } from "../../domain/money/money";
import { DomainError } from "../../domain/shared/domain-error";
import { computePayloadHash } from "../../domain/wagering/payload-hash";
import { INTERNAL_PROVIDER_ID, WagerTransaction, WagerTransactionKind } from "../../domain/wagering/wager-transaction";
import { Wallet } from "../../domain/wallet/wallet";
import { UniqueConflictError, ValidationError, WalletAlreadyExistsError } from "../errors";
import type { Clock, IdGenerator, UnitOfWork } from "../ports";
import type { TraceContext } from "../wagering/process-wager-transaction";

export interface CreateWalletCommand {
  playerId: string;
  initialBalance: MoneyProps;
}

export interface WalletView {
  id: string;
  playerId: string;
  balance: MoneyProps;
  version: number;
}

/** Identidade da transação interna de abertura: o providerId é reservado e nunca colide com provedores. */
const INTERNAL_PROVIDER = INTERNAL_PROVIDER_ID;

export class CreateWallet {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  /**
   * Cria a wallet. Saldo inicial > 0 gera, na MESMA transação SQL, a transação interna OPENING,
   * o lançamento CREDIT correspondente e os eventos na outbox.
   * Wallet duplicada para o mesmo player + moeda → conflito (verificado aqui e garantido pelo UNIQUE do banco).
   */
  async execute(command: CreateWalletCommand, trace: TraceContext): Promise<WalletView> {
    let initialBalance: Money;
    try {
      initialBalance = Money.from(command.initialBalance);
    } catch (error) {
      if (error instanceof DomainError) throw new ValidationError(error.message, { field: "initialBalance" });
      throw error;
    }

    try {
      return await this.create(command, initialBalance, trace);
    } catch (error) {
      // Duas criações simultâneas para o mesmo player: a segunda esbarra no UNIQUE do banco.
      if (error instanceof UniqueConflictError) {
        throw new WalletAlreadyExistsError("já existe wallet para este player nesta moeda", {
          playerId: command.playerId,
          currency: initialBalance.currency,
        });
      }
      throw error;
    }
  }

  private create(command: CreateWalletCommand, initialBalance: Money, trace: TraceContext): Promise<WalletView> {
    return this.uow.run(async (store) => {
      const existing = await store.findWalletByPlayer(command.playerId, initialBalance.currency);
      if (existing !== undefined) {
        throw new WalletAlreadyExistsError("já existe wallet para este player nesta moeda", {
          playerId: command.playerId,
          currency: initialBalance.currency,
        });
      }
      const now = this.clock.now();
      const walletId = this.ids.next();
      const openingTransactionId = this.ids.next();
      const { wallet, openingEntry } = Wallet.open({
        id: walletId,
        playerId: command.playerId,
        initialBalance,
        openingTransactionId,
        openingEntryId: this.ids.next(),
        now,
      });
      store.insertWallet(wallet);

      if (openingEntry !== undefined) {
        const fields = {
          providerId: INTERNAL_PROVIDER,
          externalTransactionId: `opening:${walletId}`,
          playerId: command.playerId,
          walletId,
          roundId: "opening",
          gameId: "opening",
          kind: WagerTransactionKind.Opening,
          money: initialBalance.toJSON(),
        };
        const opening = WagerTransaction.create({
          ...fields,
          id: openingTransactionId,
          idempotencyKey: `${INTERNAL_PROVIDER}:opening:${walletId}`,
          payloadHash: computePayloadHash(fields),
          money: initialBalance,
          createdAt: now,
          allowInternalKind: true,
        });
        opening.markProcessed(undefined, now, wallet.balance);
        store.insertTransaction(opening);
        store.insertLedgerEntry(openingEntry);

        const ctx = () => ({ eventId: this.ids.next(), correlationId: trace.correlationId, causationId: trace.causationId, occurredAt: now });
        store.enqueue(OutboxMessage.enqueue(WagerTransactionProcessed.from(opening, wallet, ctx())));
        store.enqueue(OutboxMessage.enqueue(WalletBalanceChanged.from(wallet, openingEntry, ctx())));
      }
      return toWalletView(wallet);
    });
  }
}

export function toWalletView(wallet: Wallet): WalletView {
  return { id: wallet.id, playerId: wallet.playerId, balance: wallet.balance.toJSON(), version: wallet.version };
}
