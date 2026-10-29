import { createHash } from "node:crypto";
import type { MoneyProps } from "../money/money";

/** Subconjunto de campos de negócio que entram no hash. Header e metadados de transporte não entram. */
export interface WagerPayloadFields {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: MoneyProps;
  referenceExternalTransactionId?: string | undefined;
}

/**
 * JSON canônico: chaves ordenadas em todos os níveis, sem espaços, campos `undefined` omitidos.
 * Dois payloads com os mesmos valores geram a mesma string, independentemente da ordem das chaves.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

/** payloadHash = SHA-256 (hex) do JSON canônico dos campos de negócio. */
export function computePayloadHash(fields: WagerPayloadFields): string {
  const subset: WagerPayloadFields = {
    providerId: fields.providerId,
    externalTransactionId: fields.externalTransactionId,
    playerId: fields.playerId,
    walletId: fields.walletId,
    roundId: fields.roundId,
    gameId: fields.gameId,
    kind: fields.kind,
    money: { amount: fields.money.amount, currency: fields.money.currency },
    referenceExternalTransactionId: fields.referenceExternalTransactionId,
  };
  return createHash("sha256").update(canonicalJson(subset)).digest("hex");
}
