import { Money } from "../money/money";
import { CurrencyMismatchError, UnbalancedLedgerEntryError } from "../shared/domain-error";

export enum LedgerDirection {
  Debit = "DEBIT",
  Credit = "CREDIT",
}

export interface CreateLedgerEntryProps {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  /** Versão da wallet depois deste lançamento: encadeia os lançamentos (1 por versão). */
  walletVersion: number;
  createdAt: Date;
}

export type LedgerEntryState = CreateLedgerEntryProps;

/**
 * Lançamento do ledger. Imutável por estrutura: só campos `readonly` e nenhum método de transição.
 * No banco, um trigger impede UPDATE e DELETE nesta tabela.
 */
export class WalletLedgerEntry {
  private constructor(
    public readonly id: string,
    public readonly walletId: string,
    public readonly transactionId: string,
    public readonly direction: LedgerDirection,
    public readonly money: Money,
    public readonly balanceBefore: Money,
    public readonly balanceAfter: Money,
    public readonly walletVersion: number,
    public readonly createdAt: Date,
  ) {}

  /** Cria um lançamento novo, validando moeda, sinal e a aritmética antes ± valor = depois. */
  static create(props: CreateLedgerEntryProps): WalletLedgerEntry {
    const entry = WalletLedgerEntry.build(props);
    for (const m of [entry.balanceBefore, entry.balanceAfter]) {
      if (m.currency !== entry.money.currency) throw new CurrencyMismatchError(entry.money.currency, m.currency);
    }
    if (!entry.money.isPositive()) {
      throw new UnbalancedLedgerEntryError("o valor do lançamento deve ser positivo");
    }
    if (entry.balanceBefore.isNegative() || entry.balanceAfter.isNegative()) {
      throw new UnbalancedLedgerEntryError("saldos do lançamento não podem ser negativos");
    }
    if (!entry.isBalanced()) {
      throw new UnbalancedLedgerEntryError(
        `lançamento não fecha: ${entry.balanceBefore.toString()} ${entry.direction} ${entry.money.toString()} ≠ ${entry.balanceAfter.toString()}`,
      );
    }
    if (!Number.isInteger(entry.walletVersion) || entry.walletVersion < 1) {
      throw new UnbalancedLedgerEntryError("walletVersion deve ser um inteiro ≥ 1");
    }
    return entry;
  }

  /** Reconstrói a partir do banco, sem revalidar. */
  static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
    return WalletLedgerEntry.build(state);
  }

  /** O valor assinado que este lançamento aplica ao saldo (+ crédito, − débito). */
  signedAmount(): Money {
    return this.direction === LedgerDirection.Credit ? this.money : this.money.negate();
  }

  isBalanced(): boolean {
    return this.balanceBefore.add(this.signedAmount()).equals(this.balanceAfter);
  }

  private static build(p: CreateLedgerEntryProps): WalletLedgerEntry {
    return new WalletLedgerEntry(
      p.id, p.walletId, p.transactionId, p.direction, p.money,
      p.balanceBefore, p.balanceAfter, p.walletVersion, p.createdAt,
    );
  }
}
