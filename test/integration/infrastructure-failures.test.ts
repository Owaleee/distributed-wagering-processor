import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { MikroORM } from "@mikro-orm/postgresql";
import { type TestApp, api, startTestApp, wagerPayload } from "../support/app";
import { type TestDatabase, createTestDatabase } from "../support/database";
import { expectLedgerConsistent, expectNoStructuralViolations } from "../support/invariants";
import { type TcpProxy, startTcpProxy } from "../support/tcp-proxy";

/**
 * Falhas de infraestrutura viram 503 + Retry-After (reenviar com a mesma Idempotency-Key é seguro),
 * nunca 500 nem efeito parcial.
 */
let db: TestDatabase;

beforeAll(async () => {
  db = await createTestDatabase();
});
afterAll(async () => {
  await expectLedgerConsistent(db.sql);
  await expectNoStructuralViolations(db.sql);
  await db?.drop();
});

/** Como um cliente real: reenvia enquanto a resposta for 503 (falha transitória). */
async function untilNotTransient<T extends { status: number }>(call: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    const res = await call();
    if (res.status !== 503 || attempt >= 10) return res;
    await Bun.sleep(100);
  }
}

/** Trava a wallet numa conexão à parte (como uma transação lenta) até `release()`. */
async function holdWalletLock(walletId: string) {
  const conn = await db.sql.reserve();
  await conn`begin`;
  await conn`select id from wallets where id = ${walletId} for update`;
  return {
    release: async () => {
      await conn`rollback`;
      conn.release();
    },
  };
}

describe("lock demorado", () => {
  let app: TestApp;
  beforeAll(async () => {
    app = await startTestApp(db.url, { lockTimeoutMs: 300 });
  });
  afterAll(() => app?.close());

  test("lock_timeout → 503 com Retry-After; reenviar depois aplica uma única vez", async () => {
    const client = api(app.baseUrl);
    const wallet = (await client.createWallet("100.00")).body;
    const bet = wagerPayload(wallet, "BET", "10.00");

    const lock = await holdWalletLock(wallet.id);
    const blocked = await client.submit(bet);
    await lock.release();

    expect(blocked.status).toBe(503);
    expect(blocked.headers.get("retry-after")).toBe("1");
    expect(blocked.body.error.code).toBe("TRANSIENT_FAILURE");
    expect((await client.get(`/wallets/${wallet.id}`)).body.balance.amount).toBe("100.00");

    const retried = await client.submit(bet);
    expect(retried.status).toBe(200);
    expect(retried.body.balance.amount).toBe("90.00");
    const metrics = await fetch(`${app.baseUrl}/metrics`).then((r) => r.text());
    expect(metrics).toMatch(/wager_lock_conflicts_total\{kind="lock_timeout"\} [1-9]/);
  });
});

describe("pool sem conexão livre", () => {
  let app: TestApp;
  beforeAll(async () => {
    // Lock longo segura as 20 conexões do pool; quem chega depois espera no máximo 300 ms por uma.
    app = await startTestApp(db.url, { lockTimeoutMs: 4_000, dbConnectTimeoutMs: 300 });
  });
  afterAll(() => app?.close());

  test("quem não consegue conexão recebe 503 rápido em vez de esperar para sempre", async () => {
    const client = api(app.baseUrl);
    const wallet = (await client.createWallet("100.00")).body;
    const lock = await holdWalletLock(wallet.id);

    const responses = Promise.all(
      Array.from({ length: 30 }, () => client.submit(wagerPayload(wallet, "BET", "1.00"))),
    );
    await Bun.sleep(1_500);
    await lock.release();
    const statuses = (await responses).map((r) => r.status);

    const unavailable = statuses.filter((s) => s === 503).length;
    const applied = statuses.filter((s) => s === 200).length;
    expect(unavailable).toBeGreaterThan(0);
    expect(unavailable + applied).toBe(30); // nenhum 500
    const balance = (await client.get(`/wallets/${wallet.id}`)).body.balance.amount;
    expect(balance).toBe((100 - applied).toFixed(2)); // só as aplicadas debitaram
  });
});

describe("PostgreSQL fora do ar", () => {
  let app: TestApp;
  let proxy: TcpProxy;
  beforeAll(async () => {
    // A aplicação fala com o banco através de um proxy TCP que o teste pode derrubar.
    const target = new URL(db.url);
    proxy = startTcpProxy({ hostname: target.hostname, port: Number(target.port || 5432) });
    const viaProxy = new URL(db.url);
    viaProxy.port = String(proxy.port);
    app = await startTestApp(viaProxy.toString(), { dbConnectTimeoutMs: 1_000 });
  });
  afterAll(async () => {
    await app?.close();
    proxy?.close();
  });

  test("POST e GET → 503, ready → 503 com postgres down; volta sozinho quando o banco volta", async () => {
    const client = api(app.baseUrl);
    const wallet = (await client.createWallet("100.00")).body;
    const bet = wagerPayload(wallet, "BET", "10.00");
    await Promise.all(Array.from({ length: 4 }, () => client.get(`/wallets/${wallet.id}`))); // várias conexões no pool

    proxy.stop();
    const post = await client.submit(bet);
    const get = await client.get(`/wallets/${wallet.id}`);
    const ready = await client.get("/health/ready");
    const live = await client.get("/health/live");

    expect(post.status).toBe(503);
    expect(post.body.error.code).toBe("TRANSIENT_FAILURE");
    expect(get.status).toBe(503);
    expect(ready.status).toBe(503);
    expect(ready.body.checks).toMatchObject({ postgres: "down", sqs_wager_queue: "up" });
    expect(live.status).toBe(200); // o processo está vivo: não deve ser reiniciado

    proxy.start();
    const retried = await untilNotTransient(() => client.submit(bet));
    expect(retried.status).toBe(200);
    expect(retried.body.balance.amount).toBe("90.00");
    expect((await untilNotTransient(() => client.get("/health/ready"))).status).toBe(200);
  });

  test("a queda não vaza conexões do pool (regressão: kysely 0.29.6 não devolvia a conexão se o BEGIN falhasse)", async () => {
    const client = api(app.baseUrl);
    const pool = (await app.app.get(MikroORM).em.getConnection().getNativeClient()) as unknown as {
      totalCount: number;
      idleCount: number;
    };
    // A conexão reaproveitada do teste anterior pode estar morta: o primeiro uso responde 503.
    const created = await untilNotTransient(() => client.createWallet("100.00"));
    expect(created.status).toBe(201);
    const wallet = created.body;
    // Várias conexões ociosas abertas, todas "mortas" sem aviso quando o banco cai.
    await Promise.all(Array.from({ length: 5 }, () => client.get(`/wallets/${wallet.id}`)));

    proxy.stop();
    const failed = await Promise.all(Array.from({ length: 5 }, () => client.submit(wagerPayload(wallet, "BET", "1.00"))));
    expect(failed.map((r) => r.status)).toEqual([503, 503, 503, 503, 503]);
    proxy.start();

    expect((await untilNotTransient(() => client.submit(wagerPayload(wallet, "BET", "1.00")))).status).toBe(200);
    // Toda conexão emprestada voltou ao pool: nenhuma ficou presa numa transação que nunca começou.
    expect(pool.totalCount).toBe(pool.idleCount);
  });
});
