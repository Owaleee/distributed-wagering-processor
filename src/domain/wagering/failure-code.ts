/**
 * Taxonomia de falhas. Códigos estáveis e legíveis por máquina, para o provedor decidir
 * se reenvia, corrige o payload ou desiste. Ver a tabela em ARCHITECTURE.md.
 */
export enum FailureCode {
  // ---- Rejeições de negócio (REJECTED, terminal). Reenviar o mesmo payload não muda o resultado.
  /** BET maior que o saldo disponível. */
  InsufficientFunds = "INSUFFICIENT_FUNDS",
  /** Reversão (REFUND/ROLLBACK) que deixaria o saldo negativo. Operacionalmente distinto de uma BET sem saldo. */
  ReversalInsufficientFunds = "REVERSAL_INSUFFICIENT_FUNDS",
  /** Moeda da operação diferente da moeda da wallet. */
  CurrencyMismatch = "CURRENCY_MISMATCH",
  /** playerId da operação não é o dono da wallet. */
  PlayerWalletMismatch = "PLAYER_WALLET_MISMATCH",
  /** A referência não apareceu dentro da janela de espera. */
  ReferenceNotFound = "REFERENCE_NOT_FOUND",
  /** A referência existe, mas ela mesma continuou pendente até o fim da janela de espera. */
  ReferenceStillPending = "REFERENCE_STILL_PENDING",
  /** Tipo de referência não permitido (REFUND só referencia BET; ROLLBACK: BET, WIN ou REFUND). */
  ReferenceInvalidKind = "REFERENCE_INVALID_KIND",
  /** A referência existe, mas terminou REJECTED ou FAILED: não há o que reverter. */
  ReferenceNotProcessed = "REFERENCE_NOT_PROCESSED",
  /** A referência pertence a outro player, wallet, moeda ou rodada. */
  ReferenceMismatch = "REFERENCE_MISMATCH",
  /** Valor da reversão diferente do valor da referência (reversão parcial fora de escopo). */
  AmountMismatch = "AMOUNT_MISMATCH",
  /** A referência já foi revertida (vale para REFUND, ROLLBACK e para um WIN que aponte para uma BET revertida). */
  AlreadyReversed = "ALREADY_REVERSED",
  /** O crédito faria o saldo passar do maior valor armazenável. */
  BalanceLimitExceeded = "BALANCE_LIMIT_EXCEEDED",

  // ---- Falha permanente de infraestrutura (FAILED, terminal, auditável).
  /** O processamento falhou de forma permanente depois de esgotar as tentativas. */
  ProcessingFailed = "PROCESSING_FAILED",
}
