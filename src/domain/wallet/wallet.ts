import { LedgerDirection, WalletLedgerEntry } from "../ledger/wallet-ledger-entry";
import { Money } from "../money/money";
import { CurrencyMismatchError, InsufficientFundsError, InvalidMoneyError } from "../shared/domain-error";

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface OpenWalletProps {
  id: string;
  playerId: string;
  initialBalance: Money;
  /** Ids da transação OPENING e do lançamento, usados só se o saldo inicial for > 0. */
  openingTransactionId: string;
  openingEntryId: string;
  now: Date;
}

export interface MovementProps {
  transactionId: string;
  entryId: string;
  money: Money;
  now: Date;
}

/**
 * Aggregate root da carteira.
 *
 * Toda alteração de saldo passa por `debit`/`credit`, que devolvem o lançamento de ledger
 * correspondente: saldo e ledger nunca mudam um sem o outro.
 * `version` começa em 1 e só incrementa quando o saldo muda.
 */
export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  /**
   * Abre uma carteira. Com saldo inicial > 0, devolve também o lançamento CREDIT da
   * transação interna OPENING (0 → saldo inicial), que faz parte da criação: a versão fica em 1.
   */
  static open(props: OpenWalletProps): { wallet: Wallet; openingEntry: WalletLedgerEntry | undefined } {
    if (props.initialBalance.isNegative()) {
      throw new InvalidMoneyError("saldo inicial não pode ser negativo");
    }
    const wallet = new Wallet(
      props.id, props.playerId, props.initialBalance.currency,
      props.initialBalance, 1, props.now, props.now,
    );
    const openingEntry = props.initialBalance.isPositive()
      ? WalletLedgerEntry.create({
          id: props.openingEntryId,
          walletId: props.id,
          transactionId: props.openingTransactionId,
          direction: LedgerDirection.Credit,
          money: props.initialBalance,
          balanceBefore: Money.zero(props.initialBalance.currency),
          balanceAfter: props.initialBalance,
          walletVersion: 1,
          createdAt: props.now,
        })
      : undefined;
    return { wallet, openingEntry };
  }

  /** Reconstrução a partir da persistência — não revalida transições. */
  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id, state.playerId, state.currency, state.balance,
      state.version, state.createdAt, state.updatedAt,
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  /** O crédito cabe no saldo sem estourar o limite armazenável? */
  canCredit(money: Money): boolean {
    this.assertSameCurrency(money);
    return !this._balance.add(money).exceedsStorageLimit();
  }

  canDebit(money: Money): boolean {
    this.assertSameCurrency(money);
    return !this._balance.isLessThan(money);
  }

  debit(props: MovementProps): WalletLedgerEntry {
    if (!this.canDebit(props.money)) {
      throw new InsufficientFundsError(this._balance.toString(), props.money.toString());
    }
    return this.apply(LedgerDirection.Debit, props);
  }

  credit(props: MovementProps): WalletLedgerEntry {
    this.assertSameCurrency(props.money);
    return this.apply(LedgerDirection.Credit, props);
  }

  /** Aplica um movimento na direção indicada (usado por reversões, cuja direção depende da referência). */
  move(direction: LedgerDirection, props: MovementProps): WalletLedgerEntry {
    return direction === LedgerDirection.Debit ? this.debit(props) : this.credit(props);
  }

  private apply(direction: LedgerDirection, props: MovementProps): WalletLedgerEntry {
    const before = this._balance;
    const after = direction === LedgerDirection.Debit ? before.subtract(props.money) : before.add(props.money);
    if (after.exceedsStorageLimit()) {
      throw new InvalidMoneyError("o saldo resultante excede o limite armazenável (18 dígitos inteiros)");
    }
    const entry = WalletLedgerEntry.create({
      id: props.entryId,
      walletId: this.id,
      transactionId: props.transactionId,
      direction,
      money: props.money,
      balanceBefore: before,
      balanceAfter: after,
      walletVersion: this._version + 1,
      createdAt: props.now,
    });
    // Só altera o estado depois que o lançamento foi validado.
    this._balance = after;
    this._version += 1;
    this._updatedAt = props.now;
    return entry;
  }

  private assertSameCurrency(money: Money): void {
    if (money.currency !== this.currency) {
      throw new CurrencyMismatchError(this.currency, money.currency);
    }
  }
}
