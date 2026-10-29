import { describe, expect, test } from "bun:test";
import { Money } from "../../../src/domain/money/money";
import { CurrencyMismatchError, InvalidMoneyError } from "../../../src/domain/shared/domain-error";

const brl = (amount: string) => Money.from({ amount, currency: "BRL" });

describe("Money — entrada", () => {
  test.each(["0.00", "25.00", "0.01", "1000000.99", "999999999999999999.99"])("aceita %p", (amount) => {
    expect(brl(amount).toString()).toBe(amount);
  });

  test.each([
    ["vazio", ""],
    ["sem casas", "25"],
    ["1 casa", "25.5"],
    ["3 casas (não arredonda)", "25.005"],
    ["negativo", "-1.00"],
    ["sinal +", "+1.00"],
    ["notação científica", "1e3"],
    ["científica com casas", "1.00e2"],
    ["NaN", "NaN"],
    ["Infinity", "Infinity"],
    ["zero à esquerda", "01.00"],
    ["espaço", " 1.00"],
    ["vírgula", "1,00"],
    ["hex", "0x10"],
    ["19 dígitos inteiros", "1000000000000000000.00"],
  ])("rejeita %s (%p)", (_label, amount) => {
    expect(() => brl(amount)).toThrow(InvalidMoneyError);
  });

  test("rejeita amount que não é string (ex.: number)", () => {
    expect(() => Money.from({ amount: 25 as unknown as string, currency: "BRL" })).toThrow(InvalidMoneyError);
  });

  test.each(["brl", "BR", "BRLX", "", "R$"])("rejeita moeda %p", (currency) => {
    expect(() => Money.from({ amount: "1.00", currency })).toThrow(InvalidMoneyError);
  });
});

describe("Money — aritmética exata e imutável", () => {
  test("0.10 + 0.20 = 0.30 (sem erro de ponto flutuante)", () => {
    expect(brl("0.10").add(brl("0.20")).toString()).toBe("0.30");
  });

  test("subtract, negate e sinais", () => {
    const r = brl("20.00").subtract(brl("80.00"));
    expect(r.toString()).toBe("-60.00");
    expect(r.isNegative()).toBe(true);
    expect(r.negate().toString()).toBe("60.00");
    expect(Money.zero("BRL").isZero()).toBe(true);
    expect(brl("0.01").isPositive()).toBe(true);
  });

  test("operações devolvem nova instância e não alteram a original", () => {
    const a = brl("10.00");
    const b = a.add(brl("5.00"));
    expect(a.toString()).toBe("10.00");
    expect(b).not.toBe(a);
  });

  test("valores grandes continuam exatos", () => {
    const big = brl("999999999999999999.99");
    expect(big.subtract(brl("0.01")).toString()).toBe("999999999999999999.98");
  });

  test("comparação e igualdade", () => {
    expect(brl("1.00").isLessThan(brl("1.01"))).toBe(true);
    expect(brl("1.00").equals(brl("1.00"))).toBe(true);
    expect(brl("1.00").equals(Money.from({ amount: "1.00", currency: "USD" }))).toBe(false);
  });

  test("serialização mantém 2 casas", () => {
    expect(brl("7.50").toJSON()).toEqual({ amount: "7.50", currency: "BRL" });
    expect(JSON.stringify({ m: brl("0.05") })).toBe('{"m":{"amount":"0.05","currency":"BRL"}}');
  });

  test("fromStored reidrata valores negativos (diferença de reconciliação)", () => {
    expect(Money.fromStored({ amount: "-3.10", currency: "BRL" }).toString()).toBe("-3.10");
  });
});

describe("Money — conflito de moeda", () => {
  const usd = Money.from({ amount: "1.00", currency: "USD" });
  test.each([
    ["add", () => brl("1.00").add(usd)],
    ["subtract", () => brl("1.00").subtract(usd)],
    ["isLessThan", () => brl("1.00").isLessThan(usd)],
  ])("%s entre BRL e USD lança CurrencyMismatchError", (_op, fn) => {
    expect(fn).toThrow(CurrencyMismatchError);
  });
});

describe("Money — limite armazenável (NUMERIC(20,2))", () => {
  test("o maior valor cabe; somar 0.01 passa do limite", () => {
    const max = brl("999999999999999999.99");
    expect(max.exceedsStorageLimit()).toBe(false);
    expect(max.add(brl("0.01")).exceedsStorageLimit()).toBe(true);
  });
});
