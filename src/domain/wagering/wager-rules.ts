import { LedgerDirection, type WalletLedgerEntry } from "../ledger/wallet-ledger-entry";
import type { Wallet } from "../wallet/wallet";
import { FailureCode } from "./failure-code";
import { WagerTransaction, WagerTransactionKind, WagerTransactionStatus } from "./wager-transaction";

/** O que fazer com uma transação, dado o estado atual da wallet e da referência. */
export type WagerDecision =
  | { readonly outcome: "apply"; readonly direction: LedgerDirection; readonly reference: WagerTransaction | undefined }
  | { readonly outcome: "record"; readonly reference: WagerTransaction | undefined }
  | { readonly outcome: "reject"; readonly code: FailureCode; readonly reference: WagerTransaction | undefined }
  | { readonly outcome: "pending" };

export interface WagerContext {
  readonly transaction: WagerTransaction;
  readonly wallet: Wallet;
  /** Transação referenciada, resolvida por (providerId, referenceExternalTransactionId). */
  readonly reference: WagerTransaction | undefined;
  /** A referência já foi revertida por um REFUND/ROLLBACK PROCESSED (vale para qualquer kind que referencie). */
  readonly referenceAlreadyReversed: boolean;
  /** A referência (uma BET) já tem um WIN PROCESSED, ainda não revertido, apontando para ela. */
  readonly referenceHasActiveWin?: boolean;
}

const ALLOWED_REFERENCE_KINDS: Partial<Record<WagerTransactionKind, readonly WagerTransactionKind[]>> = {
  [WagerTransactionKind.Refund]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Rollback]: [WagerTransactionKind.Bet, WagerTransactionKind.Win, WagerTransactionKind.Refund],
  [WagerTransactionKind.Win]: [WagerTransactionKind.Bet],
};

/**
 * Regras de negócio da seção 7 do desafio, como função pura: não altera nada, só decide.
 * A ordem das verificações define qual `failureCode` vence quando há mais de um problema.
 */
export function decideWager(ctx: WagerContext): WagerDecision {
  const { transaction: tx, wallet, reference } = ctx;

  if (tx.money.currency !== wallet.currency) {
    return { outcome: "reject", code: FailureCode.CurrencyMismatch, reference: undefined };
  }
  if (tx.playerId !== wallet.playerId) {
    return { outcome: "reject", code: FailureCode.PlayerWalletMismatch, reference: undefined };
  }

  if (tx.hasReference()) {
    if (reference === undefined) return { outcome: "pending" };

    // A referência existe mas ainda está aguardando outra: espera também.
    if (reference.status === WagerTransactionStatus.Pending || reference.status === WagerTransactionStatus.PendingReference) {
      return { outcome: "pending" };
    }
    if (reference.status !== WagerTransactionStatus.Processed) {
      return { outcome: "reject", code: FailureCode.ReferenceNotProcessed, reference };
    }
    const sameScope =
      reference.providerId === tx.providerId &&
      reference.playerId === tx.playerId &&
      reference.walletId === tx.walletId &&
      reference.money.currency === tx.money.currency &&
      reference.roundId === tx.roundId;
    if (!sameScope) {
      return { outcome: "reject", code: FailureCode.ReferenceMismatch, reference };
    }
    if (!(ALLOWED_REFERENCE_KINDS[tx.kind] ?? []).includes(reference.kind)) {
      return { outcome: "reject", code: FailureCode.ReferenceInvalidKind, reference };
    }
    if (tx.requiresReference() && !tx.money.equals(reference.money)) {
      return { outcome: "reject", code: FailureCode.AmountMismatch, reference };
    }
    // Reverter de novo, ou pagar um WIN de uma BET que já foi desfeita, criaria crédito indevido.
    if (ctx.referenceAlreadyReversed) {
      return { outcome: "reject", code: FailureCode.AlreadyReversed, reference };
    }
    // O caminho inverso: devolver uma BET cujo prêmio já foi pago deixaria o jogador com a aposta e o prêmio.
    if (tx.requiresReference() && reference.kind === WagerTransactionKind.Bet && ctx.referenceHasActiveWin === true) {
      return { outcome: "reject", code: FailureCode.ReferenceAlreadySettled, reference };
    }
  }

  if (!tx.affectsBalance()) {
    return { outcome: "record", reference };
  }

  const direction = tx.ledgerDirectionFor(reference);
  if (direction === LedgerDirection.Credit && !wallet.canCredit(tx.money)) {
    return { outcome: "reject", code: FailureCode.BalanceLimitExceeded, reference };
  }
  if (direction === LedgerDirection.Debit && !wallet.canDebit(tx.money)) {
    const code = tx.kind === WagerTransactionKind.Bet ? FailureCode.InsufficientFunds : FailureCode.ReversalInsufficientFunds;
    return { outcome: "reject", code, reference };
  }
  return { outcome: "apply", direction, reference };
}

export interface ApplyWagerProps {
  readonly ledgerEntryId: string;
  readonly now: Date;
}

/**
 * Executa a decisão: altera a wallet (se for o caso) e leva a transação ao novo estado.
 * Devolve o lançamento de ledger quando o saldo muda.
 */
export function applyWagerDecision(
  ctx: WagerContext,
  decision: WagerDecision,
  props: ApplyWagerProps,
): WalletLedgerEntry | undefined {
  const { transaction: tx, wallet } = ctx;
  switch (decision.outcome) {
    case "apply": {
      const entry = wallet.move(decision.direction, {
        transactionId: tx.id,
        entryId: props.ledgerEntryId,
        money: tx.money,
        now: props.now,
      });
      tx.markProcessed(decision.reference?.id, props.now, wallet.balance);
      return entry;
    }
    case "record":
      tx.markProcessed(decision.reference?.id, props.now, wallet.balance);
      return undefined;
    case "reject":
      tx.reject(decision.code, props.now, wallet.balance, decision.reference?.id);
      return undefined;
    case "pending":
      tx.markPendingReference(wallet.balance);
      return undefined;
  }
}
