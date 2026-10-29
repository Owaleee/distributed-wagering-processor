import type { LedgerDirection, WalletLedgerEntry } from "../ledger/wallet-ledger-entry";
import type { MoneyProps } from "../money/money";
import type { FailureCode } from "../wagering/failure-code";
import type { WagerTransaction } from "../wagering/wager-transaction";
import type { Wallet } from "../wallet/wallet";

export interface IntegrationEventProps<T> {
  eventId: string;
  aggregateId: string;
  correlationId: string;
  causationId?: string | undefined;
  occurredAt: Date;
  data: T;
}

/** Contexto de quem gerou o evento: id do evento e encadeamento para rastreio. */
export interface EventContext {
  eventId: string;
  correlationId: string;
  causationId?: string | undefined;
  occurredAt: Date;
}

export interface IntegrationEventJson<T> {
  eventId: string;
  eventType: string;
  aggregateId: string;
  correlationId: string;
  causationId?: string;
  occurredAt: string;
  version: number;
  data: T;
}

/** Envelope de evento de integração. `eventType` e `version` ficam no tipo concreto. */
export abstract class IntegrationEvent<T> {
  abstract readonly eventType: string;
  abstract readonly version: number;

  readonly eventId: string;
  readonly aggregateId: string;
  readonly correlationId: string;
  readonly causationId?: string | undefined;
  readonly occurredAt: Date;
  readonly data: Readonly<T>;

  protected constructor(props: IntegrationEventProps<T>) {
    this.eventId = props.eventId;
    this.aggregateId = props.aggregateId;
    this.correlationId = props.correlationId;
    this.causationId = props.causationId;
    this.occurredAt = props.occurredAt;
    this.data = Object.freeze({ ...props.data });
  }

  /** Envelope serializado gravado no payload da outbox. */
  toJSON(): IntegrationEventJson<T> {
    return {
      eventId: this.eventId,
      eventType: this.eventType,
      aggregateId: this.aggregateId,
      correlationId: this.correlationId,
      ...(this.causationId !== undefined ? { causationId: this.causationId } : {}),
      occurredAt: this.occurredAt.toISOString(),
      version: this.version,
      data: this.data as T,
    };
  }
}

// ---------------------------------------------------------------- eventos concretos

interface TransactionSummary {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: MoneyProps;
  referenceTransactionId?: string;
}

function summarize(tx: WagerTransaction): TransactionSummary {
  return {
    transactionId: tx.id,
    providerId: tx.providerId,
    externalTransactionId: tx.externalTransactionId,
    walletId: tx.walletId,
    playerId: tx.playerId,
    roundId: tx.roundId,
    gameId: tx.gameId,
    kind: tx.kind,
    money: tx.money.toJSON(),
    ...(tx.referenceTransactionId !== undefined ? { referenceTransactionId: tx.referenceTransactionId } : {}),
  };
}

function props<T>(aggregateId: string, ctx: EventContext, data: T): IntegrationEventProps<T> {
  return { ...ctx, aggregateId, data };
}

export interface WagerTransactionProcessedData extends TransactionSummary {
  status: "PROCESSED";
  balance: MoneyProps;
}

/** Qualquer transação aplicada, inclusive LOSS. */
export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  readonly eventType = "WagerTransactionProcessed";
  readonly version = 1;

  static from(tx: WagerTransaction, wallet: Wallet, ctx: EventContext): WagerTransactionProcessed {
    return new WagerTransactionProcessed(
      props(tx.id, ctx, { ...summarize(tx), status: "PROCESSED", balance: wallet.balance.toJSON() }),
    );
  }
}

export interface WagerTransactionRejectedData extends TransactionSummary {
  status: "REJECTED";
  failureCode: FailureCode;
}

/** Transação rejeitada por regra de negócio. */
export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = "WagerTransactionRejected";
  readonly version = 1;

  static from(tx: WagerTransaction, failureCode: FailureCode, ctx: EventContext): WagerTransactionRejected {
    return new WagerTransactionRejected(props(tx.id, ctx, { ...summarize(tx), status: "REJECTED", failureCode }));
  }
}

export interface WagerTransactionFailedData extends TransactionSummary {
  status: "FAILED";
  failureCode: FailureCode;
}

/** Falha permanente de infraestrutura com a transação já registrada (auditável). Evento extra, além dos mínimos. */
export class WagerTransactionFailed extends IntegrationEvent<WagerTransactionFailedData> {
  readonly eventType = "WagerTransactionFailed";
  readonly version = 1;

  static from(tx: WagerTransaction, failureCode: FailureCode, ctx: EventContext): WagerTransactionFailed {
    return new WagerTransactionFailed(props(tx.id, ctx, { ...summarize(tx), status: "FAILED", failureCode }));
  }
}

export interface WagerTransactionPendingReferenceData extends TransactionSummary {
  status: "PENDING_REFERENCE";
  referenceExternalTransactionId: string;
}

/** Referência ainda não encontrada; a transação será reprocessada. */
export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  readonly eventType = "WagerTransactionPendingReference";
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionPendingReference {
    return new WagerTransactionPendingReference(
      props(tx.id, ctx, {
        ...summarize(tx),
        status: "PENDING_REFERENCE",
        referenceExternalTransactionId: tx.referenceExternalTransactionId ?? "",
      }),
    );
  }
}

export interface WalletBalanceChangedData {
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
}

/** Somente quando o saldo muda. */
export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  readonly eventType = "WalletBalanceChanged";
  readonly version = 1;

  static from(wallet: Wallet, entry: WalletLedgerEntry, ctx: EventContext): WalletBalanceChanged {
    return new WalletBalanceChanged(
      props(wallet.id, ctx, {
        walletId: wallet.id,
        transactionId: entry.transactionId,
        direction: entry.direction,
        money: entry.money.toJSON(),
        balanceBefore: entry.balanceBefore.toJSON(),
        balanceAfter: entry.balanceAfter.toJSON(),
        walletVersion: entry.walletVersion,
      }),
    );
  }
}
