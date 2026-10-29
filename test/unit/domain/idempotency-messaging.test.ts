import { describe, expect, test } from "bun:test";
import { LedgerDirection } from "../../../src/domain/ledger/wallet-ledger-entry";
import {
  WagerTransactionProcessed,
  WalletBalanceChanged,
} from "../../../src/domain/messaging/integration-event";
import { InboxMessage } from "../../../src/domain/messaging/inbox-message";
import { OutboxMessage } from "../../../src/domain/messaging/outbox-message";
import { canonicalJson, computePayloadHash } from "../../../src/domain/wagering/payload-hash";
import { WagerTransactionKind as K } from "../../../src/domain/wagering/wager-transaction";
import { NOW, brl, nextId, openWallet, wager } from "./fixtures";

const payload = {
  providerId: "provider-a",
  externalTransactionId: "transaction-123",
  playerId: "p",
  walletId: "w",
  roundId: "round-987",
  gameId: "fortune-chimp",
  kind: "BET",
  money: { amount: "25.00", currency: "BRL" },
};

describe("payloadHash e idempotência", () => {
  test("JSON canônico ordena chaves em todos os níveis", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
  });

  test("mesmos campos em ordem diferente → mesmo hash", () => {
    const reordered = { money: { currency: "BRL", amount: "25.00" }, kind: "BET", gameId: "fortune-chimp", roundId: "round-987", walletId: "w", playerId: "p", externalTransactionId: "transaction-123", providerId: "provider-a" };
    expect(computePayloadHash(reordered)).toBe(computePayloadHash(payload));
  });

  test("campos fora do contrato de negócio não entram no hash", () => {
    const withTransport = { ...payload, idempotencyKey: "x", messageId: "m-1" } as typeof payload;
    expect(computePayloadHash(withTransport)).toBe(computePayloadHash(payload));
  });

  test.each([
    ["amount", { money: { amount: "25.01", currency: "BRL" } }],
    ["moeda", { money: { amount: "25.00", currency: "USD" } }],
    ["kind", { kind: "WIN" }],
    ["walletId", { walletId: "w2" }],
    ["referência", { referenceExternalTransactionId: "ref-1" }],
  ])("mudar %s muda o hash", (_field, change) => {
    expect(computePayloadHash({ ...payload, ...change })).not.toBe(computePayloadHash(payload));
  });

  test("mesma idempotency key com payload divergente não é replay", () => {
    const original = wager(K.Bet, "25.00", { externalTransactionId: "t-1" });
    const divergentHash = computePayloadHash({ ...payload, externalTransactionId: "t-1", money: { amount: "99.00", currency: "BRL" } });
    expect(original.matchesPayload(original.payloadHash)).toBe(true);
    expect(original.matchesPayload(divergentHash)).toBe(false);
  });
});

describe("Inbox", () => {
  test("marca processada uma única vez", () => {
    const msg = InboxMessage.receive({ messageId: "m", consumerName: "wager-consumer", payloadHash: "h", receivedAt: NOW });
    expect(msg.isProcessed()).toBe(false);
    msg.markProcessed(NOW);
    const later = new Date(NOW.getTime() + 1000);
    msg.markProcessed(later);
    expect(msg.processedAt).toEqual(NOW);
  });
});

describe("Eventos e outbox", () => {
  const ctx = () => ({ eventId: nextId("evt"), correlationId: "corr-1", causationId: "msg-1", occurredAt: NOW });

  test("WalletBalanceChanged carrega MoneyProps (strings), eventType e version no tipo", () => {
    const wallet = openWallet("100.00");
    const entry = wallet.debit({ transactionId: "t", entryId: "e", money: brl("25.00"), now: NOW });
    const json = WalletBalanceChanged.from(wallet, entry, ctx()).toJSON();
    expect(json.eventType).toBe("WalletBalanceChanged");
    expect(json.version).toBe(1);
    expect(json.occurredAt).toBe(NOW.toISOString());
    expect(json.data).toEqual({
      walletId: wallet.id,
      transactionId: "t",
      direction: LedgerDirection.Debit,
      money: { amount: "25.00", currency: "BRL" },
      balanceBefore: { amount: "100.00", currency: "BRL" },
      balanceAfter: { amount: "75.00", currency: "BRL" },
      walletVersion: 2,
    });
  });

  test("payload da outbox é JSON estável e o id é o eventId", () => {
    const wallet = openWallet("100.00");
    const tx = wager(K.Loss, "5.00");
    tx.markProcessed(undefined, NOW, wallet.balance);
    const event = WagerTransactionProcessed.from(tx, wallet, ctx());
    const outbox = OutboxMessage.enqueue(event);
    expect(outbox.id).toBe(event.eventId);
    expect(outbox.eventType).toBe("WagerTransactionProcessed");
    expect(JSON.parse(JSON.stringify(outbox.payload))).toEqual(outbox.payload);
    expect((outbox.payload.data as { money: unknown }).money).toEqual({ amount: "5.00", currency: "BRL" });
  });

  test("backoff exponencial com teto e publicação idempotente", () => {
    const wallet = openWallet("1.00");
    const tx = wager(K.Loss, "1.00");
    tx.markProcessed(undefined, NOW, wallet.balance);
    const outbox = OutboxMessage.enqueue(WagerTransactionProcessed.from(tx, wallet, ctx()));
    expect(outbox.isDue(NOW)).toBe(true);
    const delays: number[] = [];
    for (let i = 0; i < 12; i++) {
      outbox.scheduleRetry(NOW);
      delays.push((outbox.nextAttemptAt?.getTime() ?? 0) - NOW.getTime());
    }
    expect(delays.slice(0, 4)).toEqual([1000, 2000, 4000, 8000]);
    expect(Math.max(...delays)).toBe(300_000);
    expect(outbox.isDue(NOW)).toBe(false);
    outbox.markPublished(NOW);
    expect(outbox.isPending()).toBe(false);
  });
});
