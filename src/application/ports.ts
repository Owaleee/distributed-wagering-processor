import type { WalletLedgerEntry } from "../domain/ledger/wallet-ledger-entry";
import type { InboxMessage } from "../domain/messaging/inbox-message";
import type { OutboxMessage } from "../domain/messaging/outbox-message";
import type { WagerTransaction } from "../domain/wagering/wager-transaction";
import type { Wallet } from "../domain/wallet/wallet";

export const CLOCK = Symbol("CLOCK");
export const ID_GENERATOR = Symbol("ID_GENERATOR");
export const UNIT_OF_WORK = Symbol("UNIT_OF_WORK");

export interface Clock {
  now(): Date;
}

export interface IdGenerator {
  /** UUID v7: ordenável no tempo, bom para índices. */
  next(): string;
}

/** Agenda de reprocessamento de uma transação PENDING_REFERENCE. */
export interface RetrySchedule {
  /** Tentativas de encontrar a referência já feitas. */
  attempts: number;
  nextAttemptAt: Date;
  /** Falhas de infraestrutura ao reavaliar (contagem separada; ver D19). */
  processingFailures?: number;
}

/** Uma pendência travada pelo worker, com seus contadores. */
export interface LockedPending {
  transaction: WagerTransaction;
  attempts: number;
  processingFailures: number;
}

/**
 * Operações de persistência disponíveis dentro de UMA transação SQL.
 * Tudo que é gravado por meio dela é confirmado junto no commit, ou nada é.
 */
export interface TransactionalStore {
  /** Lê a wallet com `SELECT … FOR UPDATE`: outras transações da mesma wallet esperam o commit. */
  lockWallet(walletId: string): Promise<Wallet | undefined>;
  findWalletByPlayer(playerId: string, currency: string): Promise<Wallet | undefined>;
  /** A Idempotency-Key é única por provedor: a chave de um provedor nunca encontra a de outro. */
  findTransactionByIdempotencyKey(providerId: string, key: string): Promise<WagerTransaction | undefined>;
  findTransactionByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | undefined>;
  /** Já existe reversão PROCESSED apontando para esta transação? */
  hasProcessedReversal(referenceTransactionId: string): Promise<boolean>;
  /** Existe um WIN PROCESSED apontando para esta BET que não tenha sido revertido? */
  hasActiveWin(betTransactionId: string): Promise<boolean>;
  /**
   * Trava (FOR UPDATE SKIP LOCKED) transações PENDING_REFERENCE vencidas. Linhas já travadas por
   * outro worker são puladas: cada pendência é reavaliada por um worker de cada vez.
   */
  lockDuePendingReferences(now: Date, limit: number): Promise<LockedPending[]>;
  /** Trava (SKIP LOCKED) uma pendência específica, se ela ainda estiver PENDING_REFERENCE. */
  lockPendingReference(transactionId: string): Promise<LockedPending | undefined>;
  /**
   * Antecipa para `now` o reprocessamento das pendências que esperam por (providerId, externalTransactionId).
   * Pula linhas já travadas por um worker (elas já estão sendo reavaliadas). Devolve quantas acordou.
   */
  wakePendingReferences(providerId: string, referenceExternalTransactionId: string, now: Date): Promise<number>;

  insertWallet(wallet: Wallet): void;
  updateWallet(wallet: Wallet): void;
  insertTransaction(transaction: WagerTransaction, schedule?: RetrySchedule): void;
  /** Grava o novo estado de uma transação lida nesta mesma transação SQL. `now` vem do Clock. */
  updateTransaction(transaction: WagerTransaction, now: Date, schedule?: RetrySchedule): void;
  insertLedgerEntry(entry: WalletLedgerEntry): void;
  enqueue(message: OutboxMessage): void;

  /**
   * Grava a mensagem recebida na inbox, na mesma transação do efeito financeiro.
   * Devolve `false` se (consumerName, messageId) já existia (redelivery): o efeito não deve ser reaplicado.
   */
  registerInbox(message: InboxMessage): Promise<boolean>;
  findInbox(consumerName: string, messageId: string): Promise<InboxMessage | undefined>;
}

export interface UnitOfWork {
  /**
   * Executa `work` numa transação SQL. As escritas são confirmadas no fim; se `work` lançar
   * erro, nada é gravado. Erros de infraestrutura chegam já classificados (ver db-errors).
   */
  run<T>(work: (store: TransactionalStore) => Promise<T>): Promise<T>;
}
