import { ConnectionException } from "@mikro-orm/core";
import { TransientInfrastructureError, UniqueConflictError } from "../../application/errors";

const TRANSIENT_SQLSTATES = new Set([
  "55P03", // lock_not_available (lock_timeout estourou)
  "40P01", // deadlock_detected
  "40001", // serialization_failure
  "57P01", "57P02", "57P03", // servidor encerrando / indisponível
  "53300", // too_many_connections
]);
const TRANSIENT_NETWORK =
  /ECONNREFUSED|ECONNRESET|ETIMEDOUT|EPIPE|Connection terminated|connection.*(closed|ended)|getaddrinfo|socket hang up|timeout exceeded when trying to connect/i;

interface PgLikeError {
  code?: string;
  sqlState?: string;
  constraint?: string;
  message?: string;
}

/**
 * Traduz erros do driver para a linguagem da aplicação:
 * - unicidade concorrente → UniqueConflictError (o caso de uso relê e vira replay/conflito);
 * - lock timeout, deadlock, conexão, pool sem conexão livre → TransientInfrastructureError (seguro reenviar);
 * - o resto sobe como está (bug ou violação de invariante: deve falhar alto).
 */
export function translateDbError(error: unknown): unknown {
  if (!(error instanceof Error)) return error;
  const e = error as Error & PgLikeError;
  const state = e.sqlState ?? e.code;
  // 08P01 (protocol_violation) é da classe de conexão, mas é causado pelo que foi enviado
  // (ex.: byte nulo num parâmetro): reenviar não resolve. Sobe como erro inesperado (500), para aparecer.
  if (state === "08P01") return error;
  if (state === "23505") {
    return new UniqueConflictError(e.constraint ?? /constraint "([^"]+)"/.exec(e.message)?.[1]);
  }
  if ((state !== undefined && (TRANSIENT_SQLSTATES.has(state) || state.startsWith("08"))) ||
      error instanceof ConnectionException || TRANSIENT_NETWORK.test(e.message)) {
    return new TransientInfrastructureError("banco de dados temporariamente indisponível ou ocupado", { sqlState: state });
  }
  return error;
}
