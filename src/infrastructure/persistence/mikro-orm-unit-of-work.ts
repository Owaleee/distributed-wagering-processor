import { LockMode, type EntityManager, type MikroORM } from "@mikro-orm/postgresql";
import type { WalletLedgerEntry } from "../../domain/ledger/wallet-ledger-entry";
import { InboxMessage } from "../../domain/messaging/inbox-message";
import type { OutboxMessage } from "../../domain/messaging/outbox-message";
import type { WagerTransaction } from "../../domain/wagering/wager-transaction";
import type { Wallet } from "../../domain/wallet/wallet";
import type { LockedPending, RetrySchedule, TransactionalStore, UnitOfWork } from "../../application/ports";
import { translateDbError } from "./db-errors";
import { InboxRecord, LedgerEntryRecord, OutboxRecord, WagerTransactionRecord, WalletRecord } from "./entities";
import {
  ledgerEntryToRecordData,
  transactionStateData,
  transactionFromRecord,
  transactionToRecordData,
  walletFromRecord,
  walletToRecordData,
} from "./mappers";

export interface UnitOfWorkOptions {
  /** Quanto tempo esperar por um lock de linha antes de desistir (falha transitória → 503/retry). */
  lockTimeoutMs: number;
}

/**
 * Unit of Work sobre MikroORM: cada `run` abre um EntityManager próprio (fork) e uma transação
 * SQL (`em.transactional`). Entidades lidas ficam no Identity Map; as alterações são gravadas
 * no flush do commit. As FKs são `DEFERRABLE INITIALLY DEFERRED`, então a ordem dos INSERTs
 * gerada pelo flush não importa: tudo é validado no COMMIT.
 */
export class MikroOrmUnitOfWork implements UnitOfWork {
  constructor(
    private readonly orm: MikroORM,
    private readonly options: UnitOfWorkOptions,
  ) {}

  async run<T>(work: (store: TransactionalStore) => Promise<T>): Promise<T> {
    try {
      return await this.orm.em.fork().transactional(async (em) => {
        await em.execute(`set local lock_timeout = ${Math.trunc(this.options.lockTimeoutMs)}`);
        return work(new MikroOrmStore(em));
      });
    } catch (error) {
      throw translateDbError(error);
    }
  }
}

export class MikroOrmStore implements TransactionalStore {
  private readonly wallets = new Map<string, WalletRecord>();
  private readonly transactions = new Map<string, WagerTransactionRecord>();

  constructor(readonly em: EntityManager) {}

  async lockWallet(walletId: string): Promise<Wallet | undefined> {
    if (!UUID.test(walletId)) return undefined;
    const record = await this.em.findOne(WalletRecord, { id: walletId }, { lockMode: LockMode.PESSIMISTIC_WRITE, refresh: true });
    if (record === null) return undefined;
    this.wallets.set(record.id, record);
    return walletFromRecord(record);
  }

  async findWalletByPlayer(playerId: string, currency: string): Promise<Wallet | undefined> {
    const record = await this.em.findOne(WalletRecord, { playerId, currency });
    return record === null ? undefined : walletFromRecord(record);
  }

  async findTransactionByIdempotencyKey(providerId: string, key: string): Promise<WagerTransaction | undefined> {
    return this.track(await this.em.findOne(WagerTransactionRecord, { providerId, idempotencyKey: key }));
  }

  async findTransactionByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | undefined> {
    return this.track(await this.em.findOne(WagerTransactionRecord, { providerId, externalTransactionId }));
  }

  async lockDuePendingReferences(now: Date, limit: number): Promise<LockedPending[]> {
    const records = await this.em.find(
      WagerTransactionRecord,
      { status: "PENDING_REFERENCE", nextAttemptAt: { $lte: now } },
      { orderBy: { nextAttemptAt: "asc" }, limit, lockMode: LockMode.PESSIMISTIC_PARTIAL_WRITE },
    );
    return records.map((r) => this.locked(r));
  }

  async lockPendingReference(transactionId: string): Promise<LockedPending | undefined> {
    const record = await this.em.findOne(
      WagerTransactionRecord,
      { id: transactionId, status: "PENDING_REFERENCE" },
      { lockMode: LockMode.PESSIMISTIC_PARTIAL_WRITE, refresh: true },
    );
    return record === null ? undefined : this.locked(record);
  }

  /**
   * SQL direto: um único `UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED)`. Pelo ORM seriam
   * uma leitura com lock e N updates; aqui é um comando só, que pula as linhas que um worker já travou.
   */
  async wakePendingReferences(providerId: string, referenceExternalTransactionId: string, now: Date): Promise<number> {
    const rows = await this.em.execute<{ id: string }[]>(
      `update wager_transactions set next_attempt_at = ?, updated_at = ?
        where id in (
          select id from wager_transactions
           where status = 'PENDING_REFERENCE' and provider_id = ? and reference_external_transaction_id = ?
             and next_attempt_at > ?
           for update skip locked)
        returning id`,
      [now, now, providerId, referenceExternalTransactionId, now],
    );
    return rows.length;
  }

  async hasProcessedReversal(referenceTransactionId: string): Promise<boolean> {
    const count = await this.em.count(WagerTransactionRecord, {
      referenceTransactionId,
      kind: { $in: ["REFUND", "ROLLBACK"] },
      status: "PROCESSED",
    });
    return count > 0;
  }

  /** SQL direto: o "não revertido" é um NOT EXISTS sobre a própria tabela, que o ORM não expressa num filtro simples. */
  async hasActiveWin(betTransactionId: string): Promise<boolean> {
    const rows = await this.em.execute<{ found: number }[]>(
      `select 1 as found from wager_transactions w
        where w.reference_transaction_id = ? and w.kind = 'WIN' and w.status = 'PROCESSED'
          and not exists (
            select 1 from wager_transactions r
             where r.reference_transaction_id = w.id and r.kind in ('REFUND', 'ROLLBACK') and r.status = 'PROCESSED')
        limit 1`,
      [betTransactionId],
    );
    return rows.length > 0;
  }

  insertWallet(wallet: Wallet): void {
    this.em.persist(this.em.create(WalletRecord, walletToRecordData(wallet)));
  }

  updateWallet(wallet: Wallet): void {
    const record = this.wallets.get(wallet.id);
    if (record === undefined) throw new Error(`wallet ${wallet.id} não foi lida com lock nesta transação`);
    this.em.assign(record, { balance: wallet.balance.toString(), version: wallet.version, updatedAt: wallet.updatedAt });
  }

  insertTransaction(transaction: WagerTransaction, schedule?: RetrySchedule): void {
    const now = transaction.processedAt ?? transaction.createdAt;
    const record = this.em.create(WagerTransactionRecord, {
      ...transactionToRecordData(transaction, now),
      attempts: schedule?.attempts ?? 0,
      processingFailures: schedule?.processingFailures ?? 0,
      nextAttemptAt: schedule?.nextAttemptAt ?? null,
    });
    this.em.persist(record);
    this.transactions.set(record.id, record);
  }

  updateTransaction(transaction: WagerTransaction, now: Date, schedule?: RetrySchedule): void {
    const record = this.transactions.get(transaction.id);
    if (record === undefined) throw new Error(`transação ${transaction.id} não foi lida nesta transação`);
    this.em.assign(record, {
      ...transactionStateData(transaction),
      attempts: schedule?.attempts ?? record.attempts,
      processingFailures: schedule?.processingFailures ?? record.processingFailures,
      nextAttemptAt: transaction.isTerminal() ? null : (schedule?.nextAttemptAt ?? record.nextAttemptAt),
      updatedAt: now,
    });
  }

  insertLedgerEntry(entry: WalletLedgerEntry): void {
    this.em.persist(this.em.create(LedgerEntryRecord, ledgerEntryToRecordData(entry)));
  }

  enqueue(message: OutboxMessage): void {
    this.em.persist(
      this.em.create(OutboxRecord, {
        id: message.id,
        aggregateId: message.aggregateId,
        eventType: message.eventType,
        payload: { ...message.payload },
        occurredAt: message.occurredAt,
        attempts: message.attempts,
        nextAttemptAt: message.nextAttemptAt ?? message.occurredAt,
        publishedAt: null,
        lastError: null,
      }),
    );
  }

  /**
   * `INSERT … ON CONFLICT DO NOTHING` em SQL direto: se outra instância estiver gravando a mesma
   * mensagem, esta espera o commit dela e então não insere nada — sem exceção de unicidade
   * abortando a transação. O ORM não expressa "insira se não existir" num único comando.
   */
  async registerInbox(message: InboxMessage): Promise<boolean> {
    const rows = await this.em.execute<{ message_id: string }[]>(
      `insert into inbox_messages (consumer_name, message_id, payload_hash, received_at, processed_at)
       values (?, ?, ?, ?, ?) on conflict (consumer_name, message_id) do nothing returning message_id`,
      [message.consumerName, message.messageId, message.payloadHash, message.receivedAt, message.processedAt ?? null],
    );
    return rows.length === 1;
  }

  async findInbox(consumerName: string, messageId: string): Promise<InboxMessage | undefined> {
    const record = await this.em.findOne(InboxRecord, { consumerName, messageId });
    if (record === null) return undefined;
    return InboxMessage.rehydrate({
      consumerName: record.consumerName,
      messageId: record.messageId,
      payloadHash: record.payloadHash,
      receivedAt: record.receivedAt,
      processedAt: record.processedAt ?? undefined,
    });
  }

  private locked(record: WagerTransactionRecord): LockedPending {
    return {
      transaction: this.track(record) as WagerTransaction,
      attempts: record.attempts,
      processingFailures: record.processingFailures,
    };
  }

  private track(record: WagerTransactionRecord | null): WagerTransaction | undefined {
    if (record === null) return undefined;
    this.transactions.set(record.id, record);
    return transactionFromRecord(record);
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
