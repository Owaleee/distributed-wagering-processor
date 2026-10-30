import { z } from "zod";
import { ValidationError } from "../../application/errors";
import { contractText } from "../text";

/**
 * Validação de formato dos contratos HTTP. Regras de dinheiro (escala, sinal, moeda) ficam no
 * `Money` do domínio, para valerem igualmente para HTTP e SQS.
 */
const id = contractText(128);
const uuid = z.uuid();
const money = z.object({ amount: z.string(), currency: z.string() }).strict();

export const createWalletSchema = z
  .object({ playerId: uuid, initialBalance: money })
  .strict();

export const wagerPayloadSchema = z
  .object({
    providerId: id,
    externalTransactionId: id,
    playerId: uuid,
    walletId: uuid,
    roundId: id,
    gameId: id,
    kind: z.enum(["BET", "WIN", "LOSS", "REFUND", "ROLLBACK"]),
    money,
    referenceExternalTransactionId: id.optional(),
  })
  .strict();

export const idempotencyKeySchema = contractText(256);

export const ledgerQuerySchema = z.object({
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export function parse<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new ValidationError(`${what} inválido`, {
      issues: result.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
  }
  return result.data;
}

/** Cursor opaco do ledger: base64url de {"s": "<seq>"}. Estável porque o ledger é append-only. */
export function encodeCursor(seq: bigint): string {
  return Buffer.from(JSON.stringify({ s: seq.toString() })).toString("base64url");
}

export function decodeCursor(cursor: string | undefined): bigint {
  if (cursor === undefined || cursor === "") return 0n;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { s?: unknown };
    if (typeof parsed.s === "string" && /^\d{1,19}$/.test(parsed.s)) return BigInt(parsed.s);
  } catch {
    // cai no erro abaixo
  }
  throw new ValidationError("cursor inválido", { field: "cursor" });
}
