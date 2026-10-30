import { describe, expect, test } from "bun:test";
import { TransientInfrastructureError, UniqueConflictError } from "../../src/application/errors";
import { translateDbError } from "../../src/infrastructure/persistence/db-errors";

const pgError = (code: string, message = "x", extra: Record<string, unknown> = {}) =>
  Object.assign(new Error(message), { code, ...extra });

describe("classificação de erros do banco", () => {
  test.each([
    ["55P03", "lock_timeout"], ["40P01", "deadlock"], ["40001", "serialização"], ["57P01", "servidor encerrando"],
    ["53300", "conexões demais"], ["08006", "conexão caiu"],
  ])("%s (%s) → transitório (503, seguro reenviar)", (code) => {
    expect(translateDbError(pgError(code))).toBeInstanceOf(TransientInfrastructureError);
  });

  test("pool sem conexão livre → transitório", () => {
    expect(translateDbError(new Error("timeout exceeded when trying to connect"))).toBeInstanceOf(TransientInfrastructureError);
  });

  test("unicidade concorrente → releitura (replay ou 409), com o nome da constraint", () => {
    const e = translateDbError(pgError("23505", "dup", { constraint: "wager_transactions_provider_idempotency_key" }));
    expect(e).toBeInstanceOf(UniqueConflictError);
    expect((e as UniqueConflictError).constraint).toBe("wager_transactions_provider_idempotency_key");
  });

  test("08P01 (protocol_violation, ex.: byte nulo) NÃO é transitório: reenviar não resolve", () => {
    const original = pgError("08P01", "invalid message format");
    expect(translateDbError(original)).toBe(original);
  });

  test.each([["23514", "check"], ["23001", "trigger de proteção"], ["42P01", "tabela inexistente"]])(
    "%s (%s) sobe como está (erro inesperado, 500)", (code) => {
      const original = pgError(code);
      expect(translateDbError(original)).toBe(original);
    },
  );
});
