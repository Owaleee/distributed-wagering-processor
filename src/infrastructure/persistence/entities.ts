import { type InferEntity, defineEntity, p } from "@mikro-orm/postgresql";

/**
 * Entidades de persistência (o formato das linhas no banco). São separadas das classes de
 * domínio: os mappers convertem de um para o outro, e o domínio não conhece o ORM.
 * Valores monetários trafegam como string (`NUMERIC` → "25.00"), nunca como number.
 */

export const WalletRecord = defineEntity({
  name: "WalletRecord",
  tableName: "wallets",
  properties: {
    id: p.uuid().primary(),
    playerId: p.uuid(),
    currency: p.string().length(3),
    balance: p.decimal("string"),
    version: p.integer(),
    createdAt: p.datetime(),
    updatedAt: p.datetime(),
  },
});
export type WalletRecord = InferEntity<typeof WalletRecord>;

export const WagerTransactionRecord = defineEntity({
  name: "WagerTransactionRecord",
  tableName: "wager_transactions",
  properties: {
    id: p.uuid().primary(),
    providerId: p.string(),
    externalTransactionId: p.string(),
    idempotencyKey: p.string(),
    payloadHash: p.string(),
    walletId: p.uuid(),
    playerId: p.uuid(),
    roundId: p.string(),
    gameId: p.string(),
    kind: p.string(),
    amount: p.decimal("string"),
    currency: p.string(),
    referenceExternalTransactionId: p.string().nullable(),
    referenceTransactionId: p.uuid().nullable(),
    status: p.string(),
    failureCode: p.string().nullable(),
    observedBalance: p.decimal("string").nullable(),
    observedCurrency: p.string().nullable(),
    processedAt: p.datetime().nullable(),
    attempts: p.integer(),
    nextAttemptAt: p.datetime().nullable(),
    createdAt: p.datetime(),
    updatedAt: p.datetime(),
  },
});
export type WagerTransactionRecord = InferEntity<typeof WagerTransactionRecord>;

export const LedgerEntryRecord = defineEntity({
  name: "LedgerEntryRecord",
  tableName: "wallet_ledger_entries",
  properties: {
    id: p.uuid().primary(),
    walletId: p.uuid(),
    transactionId: p.uuid(),
    direction: p.string(),
    amount: p.decimal("string"),
    currency: p.string(),
    balanceBefore: p.decimal("string"),
    balanceAfter: p.decimal("string"),
    walletVersion: p.integer(),
    createdAt: p.datetime(),
  },
});
export type LedgerEntryRecord = InferEntity<typeof LedgerEntryRecord>;

export const InboxRecord = defineEntity({
  name: "InboxRecord",
  tableName: "inbox_messages",
  properties: {
    consumerName: p.string().primary(),
    messageId: p.string().primary(),
    payloadHash: p.string(),
    receivedAt: p.datetime(),
    processedAt: p.datetime().nullable(),
  },
});
export type InboxRecord = InferEntity<typeof InboxRecord>;

export const OutboxRecord = defineEntity({
  name: "OutboxRecord",
  tableName: "outbox_messages",
  properties: {
    id: p.uuid().primary(),
    aggregateId: p.string(),
    eventType: p.string(),
    payload: p.json<Record<string, unknown>>(),
    occurredAt: p.datetime(),
    attempts: p.integer(),
    nextAttemptAt: p.datetime(),
    publishedAt: p.datetime().nullable(),
    lastError: p.string().nullable(),
  },
});
export type OutboxRecord = InferEntity<typeof OutboxRecord>;

export const ALL_ENTITIES = [WalletRecord, WagerTransactionRecord, LedgerEntryRecord, InboxRecord, OutboxRecord];
