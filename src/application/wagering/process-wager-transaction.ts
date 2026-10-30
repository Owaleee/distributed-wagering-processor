import type { WalletLedgerEntry } from "../../domain/ledger/wallet-ledger-entry";
import {
  type EventContext,
  type IntegrationEvent,
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from "../../domain/messaging/integration-event";
import { OutboxMessage } from "../../domain/messaging/outbox-message";
import { Money, type MoneyProps } from "../../domain/money/money";
import { DomainError } from "../../domain/shared/domain-error";
import { FailureCode } from "../../domain/wagering/failure-code";
import { computePayloadHash } from "../../domain/wagering/payload-hash";
import { applyWagerDecision, decideWager, type WagerContext, type WagerDecision } from "../../domain/wagering/wager-rules";
import {
  EXTERNAL_KINDS,
  INTERNAL_PROVIDER_ID,
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../../domain/wagering/wager-transaction";
import type { Wallet } from "../../domain/wallet/wallet";
import { IdempotencyConflictError, UniqueConflictError, ValidationError, WalletNotFoundError } from "../errors";
import type { Metrics } from "../observability";
import type { Clock, IdGenerator, RetrySchedule, TransactionalStore, UnitOfWork } from "../ports";

export interface SubmitWagerCommand {
  idempotencyKey: string;
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: MoneyProps;
  referenceExternalTransactionId?: string | undefined;
}

export interface TraceContext {
  correlationId: string;
  /** Id da mensagem/requisição que causou esta operação. */
  causationId?: string | undefined;
}

export interface WagerResult {
  transactionId: string;
  status: WagerTransactionStatus;
  balance: MoneyProps;
  idempotentReplay: boolean;
  failureCode?: FailureCode;
}

export interface ProcessWagerOptions {
  /**
   * Quando uma transação PENDING_REFERENCE é reavaliada pela primeira vez (ms após a chegada).
   * Vem de PENDING_REFERENCE_BASE_DELAY_MS: o worker aplica o backoff a partir daqui.
   */
  pendingFirstDelayMs: number;
}

/**
 * Caso de uso central: aplicar uma operação de aposta a uma wallet.
 * É o mesmo para a entrada HTTP e para a fila SQS.
 *
 * Concorrência: a wallet é lida com `SELECT … FOR UPDATE`. Operações da mesma wallet
 * ficam em fila no banco; wallets diferentes seguem em paralelo. Como o lock vem antes
 * da verificação de idempotência, duas cópias da mesma operação nunca são avaliadas ao mesmo tempo.
 */
export class ProcessWagerTransaction {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly options: ProcessWagerOptions,
    private readonly metrics?: Metrics,
  ) {}

  /**
   * Executa numa transação própria (entrada HTTP).
   * Se outra transação gravou primeiro a mesma chave única (corrida entre wallets diferentes com a
   * mesma Idempotency-Key, por exemplo), tudo é desfeito e a operação é relida: vira replay ou conflito.
   */
  async execute(command: SubmitWagerCommand, trace: TraceContext): Promise<WagerResult> {
    for (let attempt = 1; ; attempt++) {
      try {
        const result = await this.uow.run((store) => this.executeIn(store, command, trace));
        if (!result.idempotentReplay) await this.wakeDependents(result, command.providerId, command.externalTransactionId);
        return result;
      } catch (error) {
        if (!(error instanceof UniqueConflictError)) throw error;
        this.metrics?.lockConflict("unique_conflict");
        if (attempt >= 3) {
          throw new IdempotencyConflictError("operação concorrente com a mesma identidade");
        }
      }
    }
  }

  /** Executa dentro de uma transação já aberta pelo chamador (ex.: consumidor SQS + inbox). */
  async executeIn(store: TransactionalStore, command: SubmitWagerCommand, trace: TraceContext): Promise<WagerResult> {
    if (command.providerId === INTERNAL_PROVIDER_ID) {
      throw new ValidationError(`providerId "${INTERNAL_PROVIDER_ID}" é reservado para transações internas`, {
        field: "providerId",
      });
    }
    const money = parseMoney(command.money);
    const kind = parseKind(command.kind);
    const payloadHash = computePayloadHash({ ...command, money: money.toJSON() });

    const wallet = await store.lockWallet(command.walletId);
    if (wallet === undefined) throw new WalletNotFoundError(command.walletId);

    const replay = await this.findReplay(store, command, payloadHash);
    if (replay !== undefined) return replay;

    const now = this.clock.now();
    const transaction = createTransaction({ ...command, kind, money, payloadHash, id: this.ids.next(), now });

    const reference = transaction.hasReference()
      ? await store.findTransactionByExternalId(transaction.providerId, transaction.referenceExternalTransactionId ?? "")
      : undefined;
    const ctx = await this.contextFor(store, transaction, wallet, reference);
    const decision = decideWager(ctx);
    const entry = applyWagerDecision(ctx, decision, { ledgerEntryId: this.ids.next(), now });

    const schedule: RetrySchedule | undefined =
      decision.outcome === "pending"
        ? { attempts: 0, nextAttemptAt: new Date(now.getTime() + this.options.pendingFirstDelayMs) }
        : undefined;
    store.insertTransaction(transaction, schedule);
    if (entry !== undefined) {
      store.insertLedgerEntry(entry);
      store.updateWallet(wallet);
    }
    for (const event of this.eventsFor(decision, transaction, wallet, entry, trace, now)) {
      store.enqueue(OutboxMessage.enqueue(event));
    }
    return toResult(transaction, false);
  }

  /**
   * Depois do COMMIT de uma transação que chegou a um estado final, acorda as pendências que
   * esperavam por ela (ex.: o ROLLBACK que chegou antes da BET), para o worker reavaliá-las já,
   * sem esperar o backoff. Vale para PROCESSED e também para REJECTED/FAILED: uma dependente de
   * uma referência rejeitada deve ser rejeitada logo (REFERENCE_NOT_PROCESSED), não no fim da janela.
   * Roda numa transação própria e sem o lock da wallet (evita deadlock com o worker).
   * É só otimização: se falhar, o worker as encontra no horário agendado.
   */
  async wakeDependents(result: Pick<WagerResult, "status">, providerId: string, externalTransactionId: string): Promise<number> {
    if (!TERMINAL_STATUSES.has(result.status)) return 0;
    try {
      return await this.uow.run((store) => store.wakePendingReferences(providerId, externalTransactionId, this.clock.now()));
    } catch {
      return 0;
    }
  }

  /**
   * Reavalia uma transação PENDING_REFERENCE (chamado pelo worker), com as mesmas regras e o mesmo
   * lock de wallet da entrada original. Devolve o novo status.
   * Esgotada a janela de espera: referência ausente → REFERENCE_NOT_FOUND; referência presente mas
   * ainda pendente → REFERENCE_STILL_PENDING (o problema está nela, não na falta dela).
   */
  async retryPending(
    store: TransactionalStore,
    transaction: WagerTransaction,
    options: { exhausted: boolean; nextSchedule: RetrySchedule; trace: TraceContext },
  ): Promise<WagerTransactionStatus> {
    const wallet = await store.lockWallet(transaction.walletId);
    if (wallet === undefined) throw new WalletNotFoundError(transaction.walletId);
    const now = this.clock.now();

    const reference = await store.findTransactionByExternalId(
      transaction.providerId,
      transaction.referenceExternalTransactionId ?? "",
    );
    const ctx = await this.contextFor(store, transaction, wallet, reference);
    let decision = decideWager(ctx);

    if (decision.outcome === "pending") {
      if (!options.exhausted) {
        store.updateTransaction(transaction, now, options.nextSchedule);
        return transaction.status;
      }
      const code = reference === undefined ? FailureCode.ReferenceNotFound : FailureCode.ReferenceStillPending;
      decision = { outcome: "reject", code, reference: undefined };
    }
    const entry = applyWagerDecision(ctx, decision, { ledgerEntryId: this.ids.next(), now });
    store.updateTransaction(transaction, now, options.nextSchedule);
    if (entry !== undefined) {
      store.insertLedgerEntry(entry);
      store.updateWallet(wallet);
    }
    for (const event of this.eventsFor(decision, transaction, wallet, entry, options.trace, now)) {
      store.enqueue(OutboxMessage.enqueue(event));
    }
    return transaction.status;
  }

  /**
   * Procura uma transação já registrada com a mesma identidade.
   * - mesma (providerId, Idempotency-Key) e mesmo payload → replay: devolve o resultado gravado;
   * - mesma chave e payload diferente → 409;
   * - mesmo (providerId, externalTransactionId) com outra chave → 409.
   * O 409 não expõe ids internos: o provedor já sabe qual chave e qual externalTransactionId enviou.
   */
  private async findReplay(
    store: TransactionalStore,
    command: SubmitWagerCommand,
    payloadHash: string,
  ): Promise<WagerResult | undefined> {
    const byKey = await store.findTransactionByIdempotencyKey(command.providerId, command.idempotencyKey);
    if (byKey !== undefined) {
      if (!byKey.matchesPayload(payloadHash)) {
        throw new IdempotencyConflictError("Idempotency-Key já usada por este provedor com um payload diferente", {
          reason: "PAYLOAD_MISMATCH",
        });
      }
      return toResult(byKey, true);
    }
    const byExternal = await store.findTransactionByExternalId(command.providerId, command.externalTransactionId);
    if (byExternal !== undefined) {
      throw new IdempotencyConflictError("externalTransactionId já registrado por este provedor com outra Idempotency-Key", {
        reason: "EXTERNAL_ID_REUSED",
      });
    }
    return undefined;
  }

  /**
   * Monta o contexto das regras com os fatos sobre a referência que só o banco sabe.
   * Lido depois do lock da wallet: as transações da mesma wallet não mudam no meio da decisão.
   */
  private async contextFor(
    store: TransactionalStore,
    transaction: WagerTransaction,
    wallet: Wallet,
    reference: WagerTransaction | undefined,
  ): Promise<WagerContext> {
    if (reference === undefined) return { transaction, wallet, reference, referenceAlreadyReversed: false };
    return {
      transaction,
      wallet,
      reference,
      // Vale para qualquer kind que referencia (REFUND, ROLLBACK e WIN): ver `decideWager`.
      referenceAlreadyReversed: await store.hasProcessedReversal(reference.id),
      referenceHasActiveWin:
        transaction.requiresReference() && reference.kind === WagerTransactionKind.Bet
          ? await store.hasActiveWin(reference.id)
          : false,
    };
  }

  private eventsFor(
    decision: WagerDecision,
    tx: WagerTransaction,
    wallet: Wallet,
    entry: WalletLedgerEntry | undefined,
    trace: TraceContext,
    now: Date,
  ): IntegrationEvent<unknown>[] {
    const ctx = (): EventContext => ({
      eventId: this.ids.next(),
      correlationId: trace.correlationId,
      causationId: trace.causationId,
      occurredAt: now,
    });
    switch (decision.outcome) {
      case "apply":
        return [
          WagerTransactionProcessed.from(tx, wallet, ctx()),
          ...(entry !== undefined ? [WalletBalanceChanged.from(wallet, entry, ctx())] : []),
        ];
      case "record":
        return [WagerTransactionProcessed.from(tx, wallet, ctx())];
      case "reject":
        return [WagerTransactionRejected.from(tx, decision.code, ctx())];
      case "pending":
        return [WagerTransactionPendingReference.from(tx, ctx())];
    }
  }
}

const TERMINAL_STATUSES = new Set<WagerTransactionStatus>([
  WagerTransactionStatus.Processed,
  WagerTransactionStatus.Rejected,
  WagerTransactionStatus.Failed,
]);

export function toResult(tx: WagerTransaction, idempotentReplay: boolean): WagerResult {
  return {
    transactionId: tx.id,
    status: tx.status,
    balance: (tx.observedBalance ?? Money.zero(tx.money.currency)).toJSON(),
    idempotentReplay,
    ...(tx.failureCode !== undefined ? { failureCode: tx.failureCode } : {}),
  };
}

function parseMoney(props: MoneyProps): Money {
  try {
    return Money.from(props);
  } catch (error) {
    if (error instanceof DomainError) throw new ValidationError(error.message, { field: "money" });
    throw error;
  }
}

function parseKind(kind: string): WagerTransactionKind {
  const found = EXTERNAL_KINDS.find((k) => k === kind);
  if (found === undefined) {
    throw new ValidationError(`kind inválido "${kind}": use ${EXTERNAL_KINDS.join(", ")}`, { field: "kind" });
  }
  return found;
}

function createTransaction(
  p: Omit<SubmitWagerCommand, "kind" | "money"> & { kind: WagerTransactionKind; money: Money; payloadHash: string; id: string; now: Date },
): WagerTransaction {
  try {
    return WagerTransaction.create({
      id: p.id,
      providerId: p.providerId,
      externalTransactionId: p.externalTransactionId,
      idempotencyKey: p.idempotencyKey,
      payloadHash: p.payloadHash,
      walletId: p.walletId,
      playerId: p.playerId,
      roundId: p.roundId,
      gameId: p.gameId,
      kind: p.kind,
      money: p.money,
      referenceExternalTransactionId: p.referenceExternalTransactionId,
      createdAt: p.now,
    });
  } catch (error) {
    if (error instanceof DomainError) throw new ValidationError(error.message);
    throw error;
  }
}
