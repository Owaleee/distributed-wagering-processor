import { LedgerDirection, WalletLedgerEntry } from "../../domain/ledger/wallet-ledger-entry";
import { Money } from "../../domain/money/money";
import type { FailureCode } from "../../domain/wagering/failure-code";
import {
  WagerTransaction,
  type WagerTransactionKind,
  type WagerTransactionStatus,
} from "../../domain/wagering/wager-transaction";
import { Wallet } from "../../domain/wallet/wallet";
import type { LedgerEntryRecord, WagerTransactionRecord, WalletRecord } from "./entities";

/** Converte entre linhas do banco e objetos de domínio. A reidratação usa `rehydrate` (não revalida). */

const money = (amount: string, currency: string) => Money.fromStored({ amount, currency });

export function walletFromRecord(r: WalletRecord): Wallet {
  return Wallet.rehydrate({
    id: r.id,
    playerId: r.playerId,
    currency: r.currency,
    balance: money(r.balance, r.currency),
    version: r.version,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  });
}

export function walletToRecordData(w: Wallet): WalletRecord {
  return {
    id: w.id,
    playerId: w.playerId,
    currency: w.currency,
    balance: w.balance.toString(),
    version: w.version,
    createdAt: w.createdAt,
    updatedAt: w.updatedAt,
  };
}

export function transactionFromRecord(r: WagerTransactionRecord): WagerTransaction {
  return WagerTransaction.rehydrate({
    id: r.id,
    providerId: r.providerId,
    externalTransactionId: r.externalTransactionId,
    idempotencyKey: r.idempotencyKey,
    payloadHash: r.payloadHash,
    walletId: r.walletId,
    playerId: r.playerId,
    roundId: r.roundId,
    gameId: r.gameId,
    kind: r.kind as WagerTransactionKind,
    money: money(r.amount, r.currency),
    referenceExternalTransactionId: r.referenceExternalTransactionId ?? undefined,
    createdAt: r.createdAt,
    status: r.status as WagerTransactionStatus,
    referenceTransactionId: r.referenceTransactionId ?? undefined,
    failureCode: (r.failureCode ?? undefined) as FailureCode | undefined,
    processedAt: r.processedAt ?? undefined,
    observedBalance:
      r.observedBalance !== null && r.observedBalance !== undefined && r.observedCurrency !== null && r.observedCurrency !== undefined
        ? money(r.observedBalance, r.observedCurrency)
        : undefined,
  });
}

/** Campos mutáveis de uma transação (os de negócio são imutáveis; o banco também garante). */
export function transactionStateData(t: WagerTransaction) {
  return {
    status: t.status,
    referenceTransactionId: t.referenceTransactionId ?? null,
    failureCode: t.failureCode ?? null,
    observedBalance: t.observedBalance?.toString() ?? null,
    observedCurrency: t.observedBalance?.currency ?? null,
    processedAt: t.processedAt ?? null,
  };
}

export function transactionToRecordData(t: WagerTransaction, now: Date): WagerTransactionRecord {
  return {
    id: t.id,
    providerId: t.providerId,
    externalTransactionId: t.externalTransactionId,
    idempotencyKey: t.idempotencyKey,
    payloadHash: t.payloadHash,
    walletId: t.walletId,
    playerId: t.playerId,
    roundId: t.roundId,
    gameId: t.gameId,
    kind: t.kind,
    amount: t.money.toString(),
    currency: t.money.currency,
    referenceExternalTransactionId: t.referenceExternalTransactionId ?? null,
    ...transactionStateData(t),
    attempts: 0,
    processingFailures: 0,
    nextAttemptAt: null,
    createdAt: t.createdAt,
    updatedAt: now,
  };
}

export function ledgerEntryToRecordData(e: WalletLedgerEntry): LedgerEntryRecord {
  return {
    id: e.id,
    walletId: e.walletId,
    transactionId: e.transactionId,
    direction: e.direction,
    amount: e.money.toString(),
    currency: e.money.currency,
    balanceBefore: e.balanceBefore.toString(),
    balanceAfter: e.balanceAfter.toString(),
    walletVersion: e.walletVersion,
    createdAt: e.createdAt,
  };
}

export function ledgerEntryFromRecord(r: LedgerEntryRecord): WalletLedgerEntry {
  return WalletLedgerEntry.rehydrate({
    id: r.id,
    walletId: r.walletId,
    transactionId: r.transactionId,
    direction: r.direction as LedgerDirection,
    money: money(r.amount, r.currency),
    balanceBefore: money(r.balanceBefore, r.currency),
    balanceAfter: money(r.balanceAfter, r.currency),
    walletVersion: r.walletVersion,
    createdAt: r.createdAt,
  });
}
