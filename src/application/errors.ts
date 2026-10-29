/**
 * Erros da camada de aplicação. Cada um tem um `code` estável; a borda (HTTP/SQS) decide
 * o status ou a ação (ack, retry, DLQ) a partir da categoria.
 */
export type ErrorCategory = "invalid" | "not_found" | "conflict" | "transient";

export abstract class ApplicationError extends Error {
  abstract readonly code: string;
  abstract readonly category: ErrorCategory;
  constructor(message: string, readonly details?: Record<string, unknown>) {
    super(message);
    this.name = new.target.name;
  }
}

export class ValidationError extends ApplicationError {
  readonly code = "INVALID_PAYLOAD";
  readonly category = "invalid";
}

export class WalletNotFoundError extends ApplicationError {
  readonly code = "WALLET_NOT_FOUND";
  readonly category = "not_found";
  constructor(walletId: string) {
    super(`wallet ${walletId} não encontrada`, { walletId });
  }
}

export class TransactionNotFoundError extends ApplicationError {
  readonly code = "TRANSACTION_NOT_FOUND";
  readonly category = "not_found";
}

/** Mesma idempotency key (ou mesmo providerId + externalTransactionId) com payload diferente. */
export class IdempotencyConflictError extends ApplicationError {
  readonly code = "IDEMPOTENCY_CONFLICT";
  readonly category = "conflict";
}

export class WalletAlreadyExistsError extends ApplicationError {
  readonly code = "WALLET_ALREADY_EXISTS";
  readonly category = "conflict";
}

/** Falha temporária (banco indisponível, lock demorado). Reenviar com a mesma key é seguro. */
export class TransientInfrastructureError extends ApplicationError {
  readonly code = "TRANSIENT_FAILURE";
  readonly category = "transient";
}

/**
 * Outra transação concorrente gravou primeiro um valor único (idempotency key, wallet do player…).
 * Interno: o caso de uso repete a leitura e transforma isso em replay ou conflito.
 */
export class UniqueConflictError extends ApplicationError {
  readonly code = "UNIQUE_CONFLICT";
  readonly category = "transient";
  constructor(readonly constraint: string | undefined) {
    super(`violação de unicidade concorrente (${constraint ?? "desconhecida"})`, { constraint });
  }
}
