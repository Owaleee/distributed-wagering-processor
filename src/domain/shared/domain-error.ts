/**
 * Erro de domínio: uma regra de negócio ou invariante foi violada.
 * O `code` é estável e legível por máquina; a camada HTTP/SQS o traduz para status e ações.
 */
export abstract class DomainError extends Error {
  abstract readonly code: string;

  protected constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** Entrada monetária inválida (formato, escala, sinal, moeda). */
export class InvalidMoneyError extends DomainError {
  readonly code = "INVALID_MONEY";
  constructor(message: string) {
    super(message);
  }
}

/** Operação entre moedas diferentes. */
export class CurrencyMismatchError extends DomainError {
  readonly code = "CURRENCY_MISMATCH";
  constructor(expected: string, received: string) {
    super(`Moeda incompatível: esperado ${expected}, recebido ${received}`);
  }
}

/** Débito maior que o saldo disponível. */
export class InsufficientFundsError extends DomainError {
  readonly code = "INSUFFICIENT_FUNDS";
  constructor(balance: string, requested: string) {
    super(`Saldo insuficiente: saldo ${balance}, solicitado ${requested}`);
  }
}

/** Lançamento de ledger cuja aritmética não fecha (antes ± valor ≠ depois). */
export class UnbalancedLedgerEntryError extends DomainError {
  readonly code = "UNBALANCED_LEDGER_ENTRY";
  constructor(message: string) {
    super(message);
  }
}

/** Dados de criação de uma transação inválidos (ex.: REFUND sem referência, OPENING externo). */
export class InvalidWagerTransactionError extends DomainError {
  readonly code = "INVALID_WAGER_TRANSACTION";
  constructor(message: string) {
    super(message);
  }
}

/**
 * Tentativa de transicionar uma transação já em estado terminal.
 * É erro de programação, não caminho de negócio.
 */
export class InvalidTransactionStateError extends DomainError {
  readonly code = "INVALID_TRANSACTION_STATE";
  constructor(from: string, to: string) {
    super(`Transição inválida: ${from} → ${to}`);
  }
}
