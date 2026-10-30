import { describe, expect, test } from "bun:test";
import { LedgerDirection } from "../../../src/domain/ledger/wallet-ledger-entry";
import { Money } from "../../../src/domain/money/money";
import { InvalidTransactionStateError, InvalidWagerTransactionError } from "../../../src/domain/shared/domain-error";
import { FailureCode } from "../../../src/domain/wagering/failure-code";
import {
  type WagerContext,
  applyWagerDecision,
  decideWager,
} from "../../../src/domain/wagering/wager-rules";
import {
  type WagerTransaction,
  WagerTransactionKind as K,
  WagerTransactionStatus as S,
} from "../../../src/domain/wagering/wager-transaction";
import type { Wallet } from "../../../src/domain/wallet/wallet";
import { NOW, brl, nextId, openWallet, wager } from "./fixtures";

/** Decide e aplica, como o caso de uso fará dentro da transação SQL. */
function run(wallet: Wallet, tx: WagerTransaction, reference?: WagerTransaction, referenceAlreadyReversed = false) {
  const ctx: WagerContext = { transaction: tx, wallet, reference, referenceAlreadyReversed };
  const decision = decideWager(ctx);
  const entry = applyWagerDecision(ctx, decision, { ledgerEntryId: nextId("entry"), now: NOW });
  return { decision, entry };
}

/** Uma BET já processada, para servir de referência. */
function processedBet(wallet: Wallet, amount = "25.00", overrides = {}) {
  const bet = wager(K.Bet, amount, overrides);
  run(wallet, bet);
  return bet;
}

describe("WagerTransaction — criação", () => {
  test("nasce em PENDING", () => {
    expect(wager(K.Bet, "1.00").status).toBe(S.Pending);
  });

  test("providerId \"internal\" é reservado: nenhuma entrada externa pode usá-lo", () => {
    expect(() => wager(K.Bet, "1.00", { providerId: "internal" })).toThrow(InvalidWagerTransactionError);
    expect(() => wager(K.Bet, "1.00", { providerId: "Internal" })).not.toThrow();
  });

  test("OPENING não pode ser submetido externamente", () => {
    expect(() => wager(K.Opening, "1.00")).toThrow(InvalidWagerTransactionError);
  });

  test.each([K.Refund, K.Rollback])("%s exige referência", (kind) => {
    expect(() => wager(kind, "1.00")).toThrow(InvalidWagerTransactionError);
  });

  test.each([K.Bet, K.Loss])("%s não aceita referência", (kind) => {
    expect(() => wager(kind, "1.00", { referenceExternalTransactionId: "x" })).toThrow(InvalidWagerTransactionError);
  });

  test("valor zero é inválido", () => {
    expect(() => wager(K.Bet, "0.00")).toThrow(InvalidWagerTransactionError);
  });
});

describe("WagerTransaction — estados terminais", () => {
  test.each([
    ["PROCESSED", (t: WagerTransaction) => t.markProcessed(undefined, NOW, brl("0.00"))],
    ["REJECTED", (t: WagerTransaction) => t.reject(FailureCode.InsufficientFunds, NOW, brl("0.00"))],
    ["FAILED", (t: WagerTransaction) => t.fail(FailureCode.ProcessingFailed, NOW)],
  ])("%s é terminal: qualquer nova transição lança erro", (_name, finish) => {
    const tx = wager(K.Bet, "1.00");
    finish(tx);
    expect(tx.isTerminal()).toBe(true);
    expect(() => tx.markProcessed(undefined, NOW, brl("0.00"))).toThrow(InvalidTransactionStateError);
    expect(() => tx.reject(FailureCode.InsufficientFunds, NOW, brl("0.00"))).toThrow(InvalidTransactionStateError);
    expect(() => tx.markPendingReference(brl("0.00"))).toThrow(InvalidTransactionStateError);
    expect(() => tx.fail(FailureCode.ProcessingFailed, NOW)).toThrow(InvalidTransactionStateError);
  });

  test("PENDING_REFERENCE pode ir para PROCESSED, mas não voltar para PENDING_REFERENCE", () => {
    const tx = wager(K.Refund, "1.00", { referenceExternalTransactionId: "bet-x" });
    tx.markPendingReference(brl("0.00"));
    expect(() => tx.markPendingReference(brl("0.00"))).toThrow(InvalidTransactionStateError);
    tx.markProcessed("ref", NOW, brl("1.00"));
    expect(tx.status).toBe(S.Processed);
  });
});

describe("Regras — BET", () => {
  test("debita e gera 1 lançamento DEBIT", () => {
    const wallet = openWallet("100.00");
    const bet = wager(K.Bet, "25.00");
    const { entry } = run(wallet, bet);
    expect(bet.status).toBe(S.Processed);
    expect(entry?.direction).toBe(LedgerDirection.Debit);
    expect(wallet.balance.toString()).toBe("75.00");
    expect(bet.observedBalance?.toString()).toBe("75.00");
  });

  test("saldo insuficiente → REJECTED/INSUFFICIENT_FUNDS, sem lançamento e sem mudar saldo", () => {
    const wallet = openWallet("100.00");
    run(wallet, wager(K.Bet, "80.00"));
    const second = wager(K.Bet, "80.00");
    const { entry } = run(wallet, second);
    expect(second.status).toBe(S.Rejected);
    expect(second.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(entry).toBeUndefined();
    expect(wallet.balance.toString()).toBe("20.00");
    expect(wallet.version).toBe(2);
  });
});

describe("Regras — WIN e LOSS", () => {
  test("WIN credita", () => {
    const wallet = openWallet("10.00");
    const win = wager(K.Win, "50.00");
    const { entry } = run(wallet, win);
    expect(entry?.direction).toBe(LedgerDirection.Credit);
    expect(wallet.balance.toString()).toBe("60.00");
  });

  test("WIN pode referenciar a BET da mesma rodada", () => {
    const wallet = openWallet("100.00");
    const bet = processedBet(wallet, "10.00");
    const win = wager(K.Win, "30.00", { referenceExternalTransactionId: bet.externalTransactionId });
    run(wallet, win, bet);
    expect(win.status).toBe(S.Processed);
    expect(win.referenceTransactionId).toBe(bet.id);
  });

  test("LOSS fica PROCESSED sem mover saldo nem gerar lançamento", () => {
    const wallet = openWallet("100.00");
    const loss = wager(K.Loss, "25.00");
    const { entry } = run(wallet, loss);
    expect(loss.status).toBe(S.Processed);
    expect(entry).toBeUndefined();
    expect(wallet.balance.toString()).toBe("100.00");
    expect(wallet.version).toBe(1);
  });
});

describe("Regras — REFUND", () => {
  test("credita o valor de uma BET PROCESSED", () => {
    const wallet = openWallet("100.00");
    const bet = processedBet(wallet, "25.00");
    const refund = wager(K.Refund, "25.00", { referenceExternalTransactionId: bet.externalTransactionId });
    const { entry } = run(wallet, refund, bet);
    expect(refund.status).toBe(S.Processed);
    expect(entry?.direction).toBe(LedgerDirection.Credit);
    expect(wallet.balance.toString()).toBe("100.00");
  });

  test("só referencia BET", () => {
    const wallet = openWallet("100.00");
    const win = wager(K.Win, "5.00");
    run(wallet, win);
    const refund = wager(K.Refund, "5.00", { referenceExternalTransactionId: win.externalTransactionId });
    run(wallet, refund, win);
    expect(refund.failureCode).toBe(FailureCode.ReferenceInvalidKind);
  });

  test("valor diferente da referência → AMOUNT_MISMATCH", () => {
    const wallet = openWallet("100.00");
    const bet = processedBet(wallet, "25.00");
    const refund = wager(K.Refund, "10.00", { referenceExternalTransactionId: bet.externalTransactionId });
    run(wallet, refund, bet);
    expect(refund.failureCode).toBe(FailureCode.AmountMismatch);
  });

  test("não reverte duas vezes → ALREADY_REVERSED", () => {
    const wallet = openWallet("100.00");
    const bet = processedBet(wallet, "25.00");
    const again = wager(K.Refund, "25.00", { referenceExternalTransactionId: bet.externalTransactionId });
    run(wallet, again, bet, true);
    expect(again.failureCode).toBe(FailureCode.AlreadyReversed);
    expect(wallet.balance.toString()).toBe("75.00");
  });

  test("referência ausente → PENDING_REFERENCE, sem mexer no saldo", () => {
    const wallet = openWallet("100.00");
    const refund = wager(K.Refund, "25.00", { referenceExternalTransactionId: "bet-ainda-nao-chegou" });
    const { decision, entry } = run(wallet, refund, undefined);
    expect(decision.outcome).toBe("pending");
    expect(refund.status).toBe(S.PendingReference);
    expect(entry).toBeUndefined();
    expect(wallet.balance.toString()).toBe("100.00");
  });

  test("referência de outra rodada → REFERENCE_MISMATCH", () => {
    const wallet = openWallet("100.00");
    const bet = processedBet(wallet, "25.00", { roundId: "round-A" });
    const refund = wager(K.Refund, "25.00", { referenceExternalTransactionId: bet.externalTransactionId, roundId: "round-B" });
    run(wallet, refund, bet);
    expect(refund.failureCode).toBe(FailureCode.ReferenceMismatch);
  });

  test("referência REJECTED → REFERENCE_NOT_PROCESSED", () => {
    const wallet = openWallet("10.00");
    const bet = wager(K.Bet, "25.00");
    run(wallet, bet); // rejeitada por saldo
    const refund = wager(K.Refund, "25.00", { referenceExternalTransactionId: bet.externalTransactionId });
    run(wallet, refund, bet);
    expect(refund.failureCode).toBe(FailureCode.ReferenceNotProcessed);
  });

  test("referência ainda PENDING_REFERENCE → continua aguardando", () => {
    const wallet = openWallet("100.00");
    const pendingRef = wager(K.Refund, "5.00", { referenceExternalTransactionId: "ghost" });
    run(wallet, pendingRef, undefined);
    const rollback = wager(K.Rollback, "5.00", { referenceExternalTransactionId: pendingRef.externalTransactionId });
    expect(run(wallet, rollback, pendingRef).decision.outcome).toBe("pending");
  });
});

describe("Regras — ROLLBACK", () => {
  test("ROLLBACK de BET credita", () => {
    const wallet = openWallet("100.00");
    const bet = processedBet(wallet, "40.00");
    const rb = wager(K.Rollback, "40.00", { referenceExternalTransactionId: bet.externalTransactionId });
    const { entry } = run(wallet, rb, bet);
    expect(entry?.direction).toBe(LedgerDirection.Credit);
    expect(wallet.balance.toString()).toBe("100.00");
  });

  test("ROLLBACK de WIN debita", () => {
    const wallet = openWallet("0.00");
    const win = wager(K.Win, "30.00");
    run(wallet, win);
    const rb = wager(K.Rollback, "30.00", { referenceExternalTransactionId: win.externalTransactionId });
    const { entry } = run(wallet, rb, win);
    expect(entry?.direction).toBe(LedgerDirection.Debit);
    expect(wallet.balance.toString()).toBe("0.00");
  });

  test("ROLLBACK de WIN sem saldo → REVERSAL_INSUFFICIENT_FUNDS (código distinto de BET sem saldo)", () => {
    const wallet = openWallet("0.00");
    const win = wager(K.Win, "30.00");
    run(wallet, win);
    run(wallet, wager(K.Bet, "20.00")); // jogador gastou parte do prêmio
    const rb = wager(K.Rollback, "30.00", { referenceExternalTransactionId: win.externalTransactionId });
    const { entry } = run(wallet, rb, win);
    expect(rb.status).toBe(S.Rejected);
    expect(rb.failureCode).toBe(FailureCode.ReversalInsufficientFunds);
    expect(rb.failureCode).not.toBe(FailureCode.InsufficientFunds);
    expect(entry).toBeUndefined();
    expect(wallet.balance.toString()).toBe("10.00");
  });

  test("ROLLBACK de REFUND debita de novo", () => {
    const wallet = openWallet("100.00");
    const bet = processedBet(wallet, "25.00");
    const refund = wager(K.Refund, "25.00", { referenceExternalTransactionId: bet.externalTransactionId });
    run(wallet, refund, bet);
    const rb = wager(K.Rollback, "25.00", { referenceExternalTransactionId: refund.externalTransactionId });
    const { entry } = run(wallet, rb, refund);
    expect(entry?.direction).toBe(LedgerDirection.Debit);
    expect(wallet.balance.toString()).toBe("75.00");
  });

  test("ROLLBACK não referencia LOSS", () => {
    const wallet = openWallet("100.00");
    const loss = wager(K.Loss, "5.00");
    run(wallet, loss);
    const rb = wager(K.Rollback, "5.00", { referenceExternalTransactionId: loss.externalTransactionId });
    run(wallet, rb, loss);
    expect(rb.failureCode).toBe(FailureCode.ReferenceInvalidKind);
  });
});

describe("Regras — validações gerais", () => {
  test("moeda da operação diferente da wallet → CURRENCY_MISMATCH", () => {
    const wallet = openWallet("100.00");
    const bet = wager(K.Bet, "1.00", { money: Money.from({ amount: "1.00", currency: "USD" }) });
    run(wallet, bet);
    expect(bet.failureCode).toBe(FailureCode.CurrencyMismatch);
    expect(wallet.balance.toString()).toBe("100.00");
  });

  test("player diferente do dono da wallet → PLAYER_WALLET_MISMATCH", () => {
    const wallet = openWallet("100.00");
    const bet = wager(K.Bet, "1.00", { playerId: "outro-player" });
    run(wallet, bet);
    expect(bet.failureCode).toBe(FailureCode.PlayerWalletMismatch);
  });
});

describe("Regras — limites e referências revertidas", () => {
  test("WIN que estouraria o saldo armazenável → BALANCE_LIMIT_EXCEEDED, sem mudar nada", () => {
    const wallet = openWallet("999999999999999999.99");
    const win = wager(K.Win, "0.01");
    const { entry } = run(wallet, win);
    expect(win.failureCode).toBe(FailureCode.BalanceLimitExceeded);
    expect(entry).toBeUndefined();
    expect(wallet.balance.toString()).toBe("999999999999999999.99");
  });

  test("WIN referenciando uma BET já revertida → ALREADY_REVERSED", () => {
    const wallet = openWallet("100.00");
    const bet = processedBet(wallet, "10.00");
    const refund = wager(K.Refund, "10.00", { referenceExternalTransactionId: bet.externalTransactionId });
    run(wallet, refund, bet);
    const win = wager(K.Win, "50.00", { referenceExternalTransactionId: bet.externalTransactionId });
    run(wallet, win, bet, true);
    expect(win.failureCode).toBe(FailureCode.AlreadyReversed);
    expect(wallet.balance.toString()).toBe("100.00");
  });

  test.each([K.Refund, K.Rollback])("%s de uma BET com WIN pago → REFERENCE_ALREADY_SETTLED, sem crédito", (kind) => {
    const wallet = openWallet("100.00");
    const bet = processedBet(wallet, "10.00");
    const reversal = wager(kind, "10.00", { referenceExternalTransactionId: bet.externalTransactionId });
    const ctx: WagerContext = { transaction: reversal, wallet, reference: bet, referenceAlreadyReversed: false, referenceHasActiveWin: true };
    const decision = decideWager(ctx);
    applyWagerDecision(ctx, decision, { ledgerEntryId: nextId("entry"), now: NOW });
    expect(reversal.status).toBe(S.Rejected);
    expect(reversal.failureCode).toBe(FailureCode.ReferenceAlreadySettled);
    expect(wallet.balance.toString()).toBe("90.00");
  });

  test("a regra vale só para BET: ROLLBACK do próprio WIN segue permitido", () => {
    const wallet = openWallet("100.00");
    const win = wager(K.Win, "50.00");
    run(wallet, win);
    const rollback = wager(K.Rollback, "50.00", { referenceExternalTransactionId: win.externalTransactionId });
    const ctx: WagerContext = { transaction: rollback, wallet, reference: win, referenceAlreadyReversed: false, referenceHasActiveWin: true };
    applyWagerDecision(ctx, decideWager(ctx), { ledgerEntryId: nextId("entry"), now: NOW });
    expect(rollback.status).toBe(S.Processed);
    expect(wallet.balance.toString()).toBe("100.00");
  });
});
