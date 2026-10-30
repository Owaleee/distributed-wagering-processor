import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type TestApp, api, startTestApp, wagerPayload } from "../support/app";
import { type TestDatabase, createTestDatabase } from "../support/database";
import { expectLedgerConsistent, expectNoStructuralViolations } from "../support/invariants";

/**
 * Concorrência com paralelismo real: requisições HTTP simultâneas contra a aplicação real,
 * cada uma na sua conexão e transação PostgreSQL. Nada é serializado no teste.
 */
let db: TestDatabase;
let app: TestApp;
let client: ReturnType<typeof api>;

beforeAll(async () => {
  db = await createTestDatabase();
  app = await startTestApp(db.url);
  client = api(app.baseUrl);
});
afterAll(async () => {
  await expectLedgerConsistent(db.sql);
  await expectNoStructuralViolations(db.sql);
  await app?.close();
  await db?.drop();
});

async function newWallet(amount: string) {
  const res = await client.createWallet(amount);
  expect(res.status).toBe(201);
  return res.body as { id: string; playerId: string };
}

async function debitCount(walletId: string): Promise<number> {
  const [row] = await db.sql`select count(*)::int as n from wallet_ledger_entries where wallet_id = ${walletId} and direction = 'DEBIT'`;
  return row.n;
}

describe("cenário obrigatório (seção 8)", () => {
  test("saldo 100.00, duas BETs de 80.00 simultâneas → 1 PROCESSED, 1 REJECTED, saldo 20.00, 1 débito", async () => {
    const wallet = await newWallet("100.00");
    const [a, b] = await Promise.all([
      client.submit(wagerPayload(wallet, "BET", "80.00")),
      client.submit(wagerPayload(wallet, "BET", "80.00")),
    ]);
    const statuses = [a.body.status, b.body.status].sort();
    expect(statuses).toEqual(["PROCESSED", "REJECTED"]);
    const rejected = [a, b].find((r) => r.body.status === "REJECTED");
    expect(rejected?.status).toBe(422);
    expect(rejected?.body.failureCode).toBe("INSUFFICIENT_FUNDS");
    expect((await client.get(`/wallets/${wallet.id}`)).body.balance.amount).toBe("20.00");
    expect(await debitCount(wallet.id)).toBe(1);

    // nenhum retry duplica o débito
    const processed = [a, b].find((r) => r.body.status === "PROCESSED");
    expect(processed).toBeDefined();
    await expectLedgerConsistent(db.sql, wallet.id);
  });

  test("retries das duas apostas, também em paralelo, não duplicam nada", async () => {
    const wallet = await newWallet("100.00");
    const bets = [wagerPayload(wallet, "BET", "80.00"), wagerPayload(wallet, "BET", "80.00")];
    const rounds = await Promise.all(Array.from({ length: 10 }, (_, i) => client.submit(bets[i % 2]!)));
    const unique = new Set(rounds.map((r) => r.body.transactionId));
    expect(unique.size).toBe(2);
    expect(await debitCount(wallet.id)).toBe(1);
    expect((await client.get(`/wallets/${wallet.id}`)).body.balance.amount).toBe("20.00");
    await expectLedgerConsistent(db.sql, wallet.id);
  });
});

describe("idempotência sob concorrência", () => {
  test("a mesma aposta enviada 50 vezes em paralelo → um único débito", async () => {
    const wallet = await newWallet("1000.00");
    const bet = wagerPayload(wallet, "BET", "25.00");
    const results = await Promise.all(Array.from({ length: 50 }, () => client.submit(bet)));

    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(new Set(results.map((r) => r.body.transactionId)).size).toBe(1);
    expect(results.filter((r) => r.body.idempotentReplay === false)).toHaveLength(1);
    expect(results.every((r) => r.body.balance.amount === "975.00")).toBe(true);
    expect(await debitCount(wallet.id)).toBe(1);
    expect((await client.get(`/wallets/${wallet.id}`)).body).toMatchObject({ balance: { amount: "975.00" }, version: 2 });
    await expectLedgerConsistent(db.sql, wallet.id);
  });

  test("a mesma key com payloads diferentes em paralelo → um vence, os outros recebem 409", async () => {
    const wallet = await newWallet("1000.00");
    const base = wagerPayload(wallet, "BET", "10.00");
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        client.submit({ ...base, money: { amount: `${10 + i}.00`, currency: "BRL" } }, "same-key"),
      ),
    );
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(9);
    expect(await debitCount(wallet.id)).toBe(1);
    await expectLedgerConsistent(db.sql, wallet.id);
  });
});

describe("hot wallet e wallets em paralelo", () => {
  test("100 apostas distintas disputando a mesma wallet: nunca fica negativo e o ledger fecha", async () => {
    const wallet = await newWallet("500.00");
    const results = await Promise.all(Array.from({ length: 100 }, () => client.submit(wagerPayload(wallet, "BET", "7.00"))));
    const processed = results.filter((r) => r.body.status === "PROCESSED").length;
    const rejected = results.filter((r) => r.body.status === "REJECTED").length;
    expect(processed).toBe(71); // floor(500 / 7)
    expect(rejected).toBe(29);
    expect((await client.get(`/wallets/${wallet.id}`)).body.balance.amount).toBe("3.00");
    expect(await debitCount(wallet.id)).toBe(71);
    await expectLedgerConsistent(db.sql, wallet.id);
  });

  test("wallets distintas processadas em paralelo, sem interferência", async () => {
    const wallets = await Promise.all(Array.from({ length: 10 }, () => newWallet("100.00")));
    const ops = wallets.flatMap((w) => [
      client.submit(wagerPayload(w, "BET", "30.00")),
      client.submit(wagerPayload(w, "BET", "30.00")),
      client.submit(wagerPayload(w, "WIN", "15.00")),
      client.submit(wagerPayload(w, "LOSS", "30.00")),
    ]);
    const results = await Promise.all(ops);
    expect(results.every((r) => r.status === 200)).toBe(true);
    for (const w of wallets) {
      expect((await client.get(`/wallets/${w.id}`)).body.balance.amount).toBe("55.00");
    }
    await expectLedgerConsistent(db.sql);
  });

  test("criação simultânea da mesma wallet → uma 201, as outras 409", async () => {
    const playerId = crypto.randomUUID();
    const results = await Promise.all(Array.from({ length: 8 }, () => client.createWallet("10.00", "BRL", playerId)));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(7);
    await expectLedgerConsistent(db.sql);
  });

  test("reversões concorrentes da mesma BET → exatamente uma aplicada", async () => {
    const wallet = await newWallet("100.00");
    const bet = wagerPayload(wallet, "BET", "50.00");
    await client.submit(bet);
    const reversals = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        client.submit(wagerPayload(wallet, i % 2 === 0 ? "REFUND" : "ROLLBACK", "50.00", { referenceExternalTransactionId: bet.externalTransactionId })),
      ),
    );
    expect(reversals.filter((r) => r.body.status === "PROCESSED")).toHaveLength(1);
    expect(reversals.filter((r) => r.body.failureCode === "ALREADY_REVERSED")).toHaveLength(5);
    expect((await client.get(`/wallets/${wallet.id}`)).body.balance.amount).toBe("100.00");
    await expectLedgerConsistent(db.sql, wallet.id);
  });
});
