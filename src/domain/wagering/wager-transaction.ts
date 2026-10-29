import { LedgerDirection } from "../ledger/wallet-ledger-entry";
import { Money } from "../money/money";
import { InvalidTransactionStateError, InvalidWagerTransactionError } from "../shared/domain-error";
import { FailureCode } from "./failure-code";

export enum WagerTransactionKind {
  Opening = "OPENING", // interno: crédito de abertura da wallet
  Bet = "BET",
  Win = "WIN",
  Loss = "LOSS",
  Refund = "REFUND",
  Rollback = "ROLLBACK",
}

export enum WagerTransactionStatus {
  Pending = "PENDING", // aceita, ainda não aplicada
  PendingReference = "PENDING_REFERENCE", // aguardando a transação referenciada
  Processed = "PROCESSED", // aplicada (terminal)
  Rejected = "REJECTED", // violação de regra de negócio (terminal)
  Failed = "FAILED", // erro permanente de infraestrutura (terminal, auditável)
}

/** Kinds que um provedor pode submeter (OPENING é interno). */
export const EXTERNAL_KINDS: readonly WagerTransactionKind[] = [
  WagerTransactionKind.Bet,
  WagerTransactionKind.Win,
  WagerTransactionKind.Loss,
  WagerTransactionKind.Refund,
  WagerTransactionKind.Rollback,
];

const TERMINAL = new Set([
  WagerTransactionStatus.Processed,
  WagerTransactionStatus.Rejected,
  WagerTransactionStatus.Failed,
]);

/**
 * Transições válidas:
 *   PENDING           → PROCESSED | REJECTED | FAILED | PENDING_REFERENCE
 *   PENDING_REFERENCE → PROCESSED | REJECTED | FAILED
 *   PROCESSED, REJECTED, FAILED → (nenhuma: terminais)
 */
const ALLOWED: Record<WagerTransactionStatus, readonly WagerTransactionStatus[]> = {
  [WagerTransactionStatus.Pending]: [
    WagerTransactionStatus.Processed,
    WagerTransactionStatus.Rejected,
    WagerTransactionStatus.Failed,
    WagerTransactionStatus.PendingReference,
  ],
  [WagerTransactionStatus.PendingReference]: [
    WagerTransactionStatus.Processed,
    WagerTransactionStatus.Rejected,
    WagerTransactionStatus.Failed,
  ],
  [WagerTransactionStatus.Processed]: [],
  [WagerTransactionStatus.Rejected]: [],
  [WagerTransactionStatus.Failed]: [],
};

export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string | undefined;
  createdAt: Date;
  /** Só o caso de uso de abertura de wallet pode criar OPENING. */
  allowInternalKind?: boolean;
}

export interface WagerTransactionState extends Omit<CreateWagerTransactionProps, "allowInternalKind"> {
  status: WagerTransactionStatus;
  referenceTransactionId?: string | undefined;
  failureCode?: FailureCode | undefined;
  processedAt?: Date | undefined;
  /** Saldo da wallet observado quando a transação chegou ao estado atual (devolvido no replay). */
  observedBalance?: Money | undefined;
}

export class WagerTransaction {
  private constructor(
    public readonly id: string,
    public readonly providerId: string,
    public readonly externalTransactionId: string,
    public readonly idempotencyKey: string,
    public readonly payloadHash: string,
    public readonly walletId: string,
    public readonly playerId: string,
    public readonly roundId: string,
    public readonly gameId: string,
    public readonly kind: WagerTransactionKind,
    public readonly money: Money,
    /** id no provedor — não o id interno */
    public readonly referenceExternalTransactionId: string | undefined,
    public readonly createdAt: Date,
    private _status: WagerTransactionStatus,
    private _referenceTransactionId?: string,
    private _failureCode?: FailureCode,
    private _processedAt?: Date,
    private _observedBalance?: Money,
  ) {}

  /** Nasce em PENDING. Valida a exigência de referência por kind. */
  static create(props: CreateWagerTransactionProps): WagerTransaction {
    if (props.kind === WagerTransactionKind.Opening && props.allowInternalKind !== true) {
      throw new InvalidWagerTransactionError("OPENING é interno e não pode ser submetido");
    }
    if (!props.money.isPositive()) {
      throw new InvalidWagerTransactionError("o valor da transação deve ser maior que zero");
    }
    const reference = props.referenceExternalTransactionId;
    const requiresReference =
      props.kind === WagerTransactionKind.Refund || props.kind === WagerTransactionKind.Rollback;
    if (requiresReference && (reference === undefined || reference === "")) {
      throw new InvalidWagerTransactionError(`${props.kind} exige referenceExternalTransactionId`);
    }
    if (!requiresReference && props.kind !== WagerTransactionKind.Win && reference !== undefined) {
      throw new InvalidWagerTransactionError(`${props.kind} não aceita referenceExternalTransactionId`);
    }
    if (reference !== undefined && reference === props.externalTransactionId) {
      throw new InvalidWagerTransactionError("uma transação não pode referenciar a si mesma");
    }
    return new WagerTransaction(
      props.id, props.providerId, props.externalTransactionId, props.idempotencyKey,
      props.payloadHash, props.walletId, props.playerId, props.roundId, props.gameId,
      props.kind, props.money, reference, props.createdAt, WagerTransactionStatus.Pending,
    );
  }

  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(
      state.id, state.providerId, state.externalTransactionId, state.idempotencyKey,
      state.payloadHash, state.walletId, state.playerId, state.roundId, state.gameId,
      state.kind, state.money, state.referenceExternalTransactionId, state.createdAt,
      state.status, state.referenceTransactionId, state.failureCode, state.processedAt,
      state.observedBalance,
    );
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }
  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }
  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }
  get processedAt(): Date | undefined {
    return this._processedAt;
  }
  get observedBalance(): Money | undefined {
    return this._observedBalance;
  }

  // ---- transições

  markProcessed(referenceTransactionId: string | undefined, at: Date, observedBalance: Money): void {
    this.transitionTo(WagerTransactionStatus.Processed);
    this._referenceTransactionId = referenceTransactionId;
    this._processedAt = at;
    this._observedBalance = observedBalance;
  }

  markPendingReference(observedBalance: Money): void {
    this.transitionTo(WagerTransactionStatus.PendingReference);
    this._observedBalance = observedBalance;
  }

  reject(code: FailureCode, at: Date, observedBalance: Money, referenceTransactionId?: string): void {
    this.transitionTo(WagerTransactionStatus.Rejected);
    this._failureCode = code;
    this._processedAt = at;
    this._observedBalance = observedBalance;
    this._referenceTransactionId = referenceTransactionId;
  }

  fail(code: FailureCode, at: Date): void {
    this.transitionTo(WagerTransactionStatus.Failed);
    this._failureCode = code;
    this._processedAt = at;
  }

  // ---- consultas de domínio

  isTerminal(): boolean {
    return TERMINAL.has(this._status);
  }

  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  requiresReference(): boolean {
    return this.kind === WagerTransactionKind.Refund || this.kind === WagerTransactionKind.Rollback;
  }

  hasReference(): boolean {
    return this.referenceExternalTransactionId !== undefined;
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  /**
   * Direção do lançamento que esta transação gera.
   * ROLLBACK inverte a direção da referência (BET debitou → ROLLBACK credita; WIN/REFUND creditaram → debita).
   */
  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.kind) {
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Opening:
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
        return LedgerDirection.Credit;
      case WagerTransactionKind.Rollback: {
        if (reference === undefined) {
          throw new InvalidWagerTransactionError("ROLLBACK precisa da referência para definir a direção");
        }
        return reference.ledgerDirectionFor() === LedgerDirection.Debit ? LedgerDirection.Credit : LedgerDirection.Debit;
      }
      case WagerTransactionKind.Loss:
        throw new InvalidWagerTransactionError("LOSS não gera lançamento");
    }
  }

  private transitionTo(next: WagerTransactionStatus): void {
    if (!ALLOWED[this._status].includes(next)) {
      throw new InvalidTransactionStateError(this._status, next);
    }
    this._status = next;
  }
}
