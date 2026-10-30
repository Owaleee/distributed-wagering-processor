import { z } from "zod";

/**
 * Texto de contrato (ids de provedor, chaves, rodadas…), compartilhado pela entrada HTTP e pela fila.
 * Recusa o byte nulo: o PostgreSQL não guarda U+0000 em texto, e o driver responde com um erro de
 * protocolo (08P01) que, sem esta validação, pareceria falha de conexão (503) em vez de entrada inválida (400).
 */
export const contractText = (max: number) =>
  z.string().min(1).max(max).refine((value) => !value.includes("\u0000"), { message: "não pode conter o caractere nulo (U+0000)" });

export function hasNulByte(...values: string[]): boolean {
  return values.some((v) => v.includes("\u0000"));
}
