import { CurrencyMismatchError, InvalidMoneyError } from "../shared/domain-error";

/** Formato de contrato (API, fila, eventos): valor como string decimal com 2 casas. */
export interface MoneyProps {
  amount: string;
  currency: string;
}

/** Valor não negativo com exatamente 2 casas decimais. Sem sinal, sem expoente, sem espaços. */
const INPUT_AMOUNT = /^(0|[1-9]\d*)\.(\d{2})$/;
/** Mesmo formato, admitindo sinal negativo (uso interno: reidratação de diferenças). */
const SIGNED_AMOUNT = /^(-?)(0|[1-9]\d*)\.(\d{2})$/;
const CURRENCY = /^[A-Z]{3}$/;
/** NUMERIC(20,2) no banco: até 18 dígitos inteiros. */
const MAX_INTEGER_DIGITS = 18;
const SCALE = 100n;
/** Maior valor em centavos que cabe em NUMERIC(20,2): 999999999999999999.99. */
const STORAGE_LIMIT_CENTS = 10n ** 20n;

/**
 * Valor monetário imutável.
 *
 * Internamente o valor é guardado em centavos como `bigint` (inteiro de precisão arbitrária),
 * então nenhuma operação passa por ponto flutuante. Como o desafio fixa a escala em 2 casas
 * e não há multiplicação nem divisão, nunca é preciso arredondar: entradas com mais de
 * 2 casas são rejeitadas em vez de arredondadas.
 */
export class Money {
  private constructor(
    private readonly cents: bigint,
    public readonly currency: string,
  ) {}

  /** Cria a partir de um contrato de entrada. Rejeita valores negativos. */
  static from(props: MoneyProps): Money {
    const currency = Money.parseCurrency(props.currency);
    if (typeof props.amount !== "string") {
      throw new InvalidMoneyError("amount deve ser uma string decimal");
    }
    const match = INPUT_AMOUNT.exec(props.amount);
    if (match === null) {
      throw new InvalidMoneyError(
        `amount inválido "${props.amount}": use uma string decimal não negativa com exatamente 2 casas (ex.: "25.00")`,
      );
    }
    return new Money(Money.toCents(match[1] ?? "", match[2] ?? ""), currency);
  }

  /**
   * Reconstrói um valor já validado (ex.: lido do banco), admitindo sinal negativo.
   * Não use para entradas externas.
   */
  static fromStored(props: MoneyProps): Money {
    const currency = Money.parseCurrency(props.currency);
    const match = SIGNED_AMOUNT.exec(props.amount);
    if (match === null) {
      throw new InvalidMoneyError(`valor armazenado inválido "${props.amount}"`);
    }
    const cents = Money.toCents(match[2] ?? "", match[3] ?? "");
    return new Money(match[1] === "-" ? -cents : cents, currency);
  }

  static zero(currency: string): Money {
    return new Money(0n, Money.parseCurrency(currency));
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.cents + other.cents, this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.cents - other.cents, this.currency);
  }

  negate(): Money {
    return new Money(-this.cents, this.currency);
  }

  isZero(): boolean {
    return this.cents === 0n;
  }

  isPositive(): boolean {
    return this.cents > 0n;
  }

  isNegative(): boolean {
    return this.cents < 0n;
  }

  /** O valor não cabe na coluna NUMERIC(20,2) do banco (18 dígitos inteiros). */
  exceedsStorageLimit(): boolean {
    const abs = this.cents < 0n ? -this.cents : this.cents;
    return abs >= STORAGE_LIMIT_CENTS;
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.cents < other.cents;
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.cents === other.cents;
  }

  toJSON(): MoneyProps {
    return { amount: this.toString(), currency: this.currency };
  }

  /** Valor com 2 casas, sem moeda: "25.00", "-5.00". */
  toString(): string {
    const negative = this.cents < 0n;
    const abs = negative ? -this.cents : this.cents;
    const integer = abs / SCALE;
    const fraction = (abs % SCALE).toString().padStart(2, "0");
    return `${negative ? "-" : ""}${integer.toString()}.${fraction}`;
  }

  private assertSameCurrency(other: Money): void {
    if (other.currency !== this.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }

  private static parseCurrency(currency: unknown): string {
    if (typeof currency !== "string" || !CURRENCY.test(currency)) {
      throw new InvalidMoneyError(`currency inválida "${String(currency)}": use um código ISO-4217 de 3 letras maiúsculas`);
    }
    return currency;
  }

  private static toCents(integer: string, fraction: string): bigint {
    if (integer.length > MAX_INTEGER_DIGITS) {
      throw new InvalidMoneyError(`amount excede ${MAX_INTEGER_DIGITS} dígitos inteiros`);
    }
    return BigInt(integer) * SCALE + BigInt(fraction);
  }
}
