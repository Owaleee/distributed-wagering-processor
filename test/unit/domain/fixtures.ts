import { Money } from "../../../src/domain/money/money";
import { computePayloadHash } from "../../../src/domain/wagering/payload-hash";
import {
  type CreateWagerTransactionProps,
  WagerTransaction,
  WagerTransactionKind,
} from "../../../src/domain/wagering/wager-transaction";
import { Wallet } from "../../../src/domain/wallet/wallet";

export const NOW = new Date("2026-10-29T12:00:00.000Z");
export const PLAYER = "player-1";
export const WALLET = "wallet-1";

export const brl = (amount: string) => Money.from({ amount, currency: "BRL" });

let seq = 0;
export const nextId = (prefix: string) => `${prefix}-${++seq}`;

export function openWallet(amount = "100.00", currency = "BRL"): Wallet {
  return Wallet.open({
    id: WALLET,
    playerId: PLAYER,
    initialBalance: Money.from({ amount, currency }),
    openingTransactionId: nextId("tx"),
    openingEntryId: nextId("entry"),
    now: NOW,
  }).wallet;
}

export function wager(
  kind: WagerTransactionKind,
  amount: string,
  overrides: Partial<CreateWagerTransactionProps> = {},
): WagerTransaction {
  const externalTransactionId = overrides.externalTransactionId ?? nextId("ext");
  const base = {
    providerId: "provider-a",
    externalTransactionId,
    playerId: PLAYER,
    walletId: WALLET,
    roundId: "round-1",
    gameId: "fortune-chimp",
    kind,
    money: brl(amount),
    ...overrides,
  };
  return WagerTransaction.create({
    id: nextId("tx"),
    idempotencyKey: `${base.providerId}:${externalTransactionId}`,
    payloadHash: computePayloadHash({ ...base, money: base.money.toJSON() }),
    createdAt: NOW,
    ...base,
  });
}
