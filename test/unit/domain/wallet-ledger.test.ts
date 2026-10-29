import { describe, expect, test } from "bun:test";
import { LedgerDirection, WalletLedgerEntry } from "../../../src/domain/ledger/wallet-ledger-entry";
import { Money } from "../../../src/domain/money/money";
import {
  CurrencyMismatchError,
  InsufficientFundsError,
  UnbalancedLedgerEntryError,
} from "../../../src/domain/shared/domain-error";
import { Wallet } from "../../../src/domain/wallet/wallet";
import { NOW, brl, nextId, openWallet } from "./fixtures";

const move = (money: Money) => ({ transactionId: nextId("tx"), entryId: nextId("entry"), money, now: NOW });

describe("Wallet — abertura", () => {
  test("saldo inicial > 0 gera lançamento CREDIT 0 → saldo, versão 1", () => {
    const { wallet, openingEntry } = Wallet.open({
      id: "w", playerId: "p", initialBalance: brl("1000.00"),
      openingTransactionId: "tx-open", openingEntryId: "e-open", now: NOW,
    });
    expect(wallet.version).toBe(1);
    expect(wallet.balance.toString()).toBe("1000.00");
    expect(openingEntry?.direction).toBe(LedgerDirection.Credit);
    expect(openingEntry?.balanceBefore.toString()).toBe("0.00");
    expect(openingEntry?.balanceAfter.toString()).toBe("1000.00");
    expect(openingEntry?.walletVersion).toBe(1);
  });

  test("saldo inicial zero não gera lançamento e a versão é 1", () => {
    const { wallet, openingEntry } = Wallet.open({
      id: "w", playerId: "p", initialBalance: brl("0.00"),
      openingTransactionId: "tx", openingEntryId: "e", now: NOW,
    });
    expect(openingEntry).toBeUndefined();
    expect(wallet.version).toBe(1);
  });
});

describe("Wallet — movimentos", () => {
  test("débito: saldo e versão mudam juntos e o lançamento fecha", () => {
    const wallet = openWallet("100.00");
    const entry = wallet.debit(move(brl("80.00")));
    expect(wallet.balance.toString()).toBe("20.00");
    expect(wallet.version).toBe(2);
    expect(entry.balanceBefore.toString()).toBe("100.00");
    expect(entry.balanceAfter.toString()).toBe("20.00");
    expect(entry.walletVersion).toBe(2);
    expect(entry.isBalanced()).toBe(true);
  });

  test("débito maior que o saldo lança erro e não altera nada", () => {
    const wallet = openWallet("100.00");
    wallet.debit(move(brl("80.00")));
    expect(() => wallet.debit(move(brl("80.00")))).toThrow(InsufficientFundsError);
    expect(wallet.balance.toString()).toBe("20.00");
    expect(wallet.version).toBe(2);
  });

  test("débito exato zera o saldo (nunca negativo)", () => {
    const wallet = openWallet("10.00");
    wallet.debit(move(brl("10.00")));
    expect(wallet.balance.isZero()).toBe(true);
  });

  test("crédito incrementa saldo e versão", () => {
    const wallet = openWallet("0.00");
    wallet.credit(move(brl("5.50")));
    expect(wallet.balance.toString()).toBe("5.50");
    expect(wallet.version).toBe(2);
  });

  test("moeda diferente da wallet é rejeitada sem alterar estado", () => {
    const wallet = openWallet("100.00");
    const usd = Money.from({ amount: "1.00", currency: "USD" });
    expect(() => wallet.debit(move(usd))).toThrow(CurrencyMismatchError);
    expect(() => wallet.credit(move(usd))).toThrow(CurrencyMismatchError);
    expect(wallet.balance.toString()).toBe("100.00");
    expect(wallet.version).toBe(1);
  });

  test("saldo reconstruído pelos lançamentos é igual ao saldo materializado", () => {
    const { wallet, openingEntry } = Wallet.open({
      id: "w", playerId: "p", initialBalance: brl("50.00"),
      openingTransactionId: "t0", openingEntryId: "e0", now: NOW,
    });
    const entries = [openingEntry!, wallet.debit(move(brl("20.00"))), wallet.credit(move(brl("7.25"))), wallet.debit(move(brl("0.25")))];
    const rebuilt = entries.reduce((acc, e) => acc.add(e.signedAmount()), Money.zero("BRL"));
    expect(rebuilt.equals(wallet.balance)).toBe(true);
    expect(entries.map((e) => e.walletVersion)).toEqual([1, 2, 3, 4]);
  });

  test("rehydrate reconstrói o estado sem revalidar", () => {
    const w = Wallet.rehydrate({
      id: "w", playerId: "p", currency: "BRL", balance: brl("3.00"), version: 7, createdAt: NOW, updatedAt: NOW,
    });
    expect(w.version).toBe(7);
    expect(w.balance.toString()).toBe("3.00");
  });
});

describe("WalletLedgerEntry — imutável e validado na factory", () => {
  const base = {
    id: "e", walletId: "w", transactionId: "t", direction: LedgerDirection.Credit,
    money: brl("10.00"), balanceBefore: brl("5.00"), balanceAfter: brl("15.00"), walletVersion: 2, createdAt: NOW,
  };

  test("aceita lançamento que fecha", () => {
    expect(WalletLedgerEntry.create(base).isBalanced()).toBe(true);
  });

  test("rejeita aritmética que não fecha", () => {
    expect(() => WalletLedgerEntry.create({ ...base, balanceAfter: brl("16.00") })).toThrow(UnbalancedLedgerEntryError);
  });

  test("rejeita valor zero e saldo negativo", () => {
    expect(() => WalletLedgerEntry.create({ ...base, money: brl("0.00"), balanceAfter: brl("5.00") })).toThrow(UnbalancedLedgerEntryError);
    expect(() =>
      WalletLedgerEntry.create({ ...base, direction: LedgerDirection.Debit, balanceAfter: Money.fromStored({ amount: "-5.00", currency: "BRL" }) }),
    ).toThrow(UnbalancedLedgerEntryError);
  });

  test("rejeita moedas misturadas", () => {
    expect(() =>
      WalletLedgerEntry.create({ ...base, balanceAfter: Money.from({ amount: "15.00", currency: "USD" }) }),
    ).toThrow(CurrencyMismatchError);
  });

  test("não expõe métodos de mutação", () => {
    const entry = WalletLedgerEntry.create(base);
    const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(entry));
    expect(methods.sort()).toEqual(["constructor", "isBalanced", "signedAmount"]);
  });
});
