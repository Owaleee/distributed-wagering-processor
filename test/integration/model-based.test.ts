import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type TestApp, type WagerPayload, api, startTestApp } from "../support/app";
import { type TestDatabase, createTestDatabase } from "../support/database";
import { expectLedgerConsistent, expectNoStructuralViolations } from "../support/invariants";

/**
 * Teste baseado em modelo: sequências aleatórias (com seed fixa, reproduzíveis) de operações
 * válidas, inválidas, duplicadas, conflitantes e fora de ordem, enviadas à API real. Cada resposta
 * é comparada com um ORÁCULO: as regras do README e das interpretações documentadas, reescritas aqui
 * de forma independente (sem importar nada do domínio). Uma divergência entre o oráculo e o sistema
 * é um bug de um dos dois, e o teste mostra a operação exata e o histórico até ela.
 *
 * Os workers ficam desligados: uma transação PENDING_REFERENCE continua pendente até o fim
 * (a resolução das pendências tem testes próprios), o que torna o resultado de cada passo determinístico.
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

// ------------------------------------------------------------------ PRNG reproduzível
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ------------------------------------------------------------------ oráculo
type Status = "PROCESSED" | "REJECTED" | "PENDING_REFERENCE";
interface ModelWallet { id: string; playerId: string; currency: string; cents: bigint }
interface ModelTx {
  id?: string;
  provider: string; ext: string; key: string; payloadJson: string;
  kind: string; cents: bigint; currency: string; walletId: string; playerId: string; round: string;
  refExt?: string; refTx?: ModelTx;
  status: Status; failureCode?: string;
  response: { httpStatus: number; status: Status; failureCode?: string; balance: string };
}
interface Expected {
  httpStatus: number;
  body?: { status: Status; failureCode?: string; balance: string; idempotentReplay: boolean };
  errorCode?: string;
}

const toCents = (amount: string) => BigInt(amount.replace(".", ""));
const fmt = (cents: bigint) => {
  const neg = cents < 0n;
  const abs = neg ? -cents : cents;
  return `${neg ? "-" : ""}${abs / 100n}.${(abs % 100n).toString().padStart(2, "0")}`;
};
const VALID_AMOUNT = /^(0|[1-9]\d*)\.\d{2}$/;
const REVERSALS = new Set(["REFUND", "ROLLBACK"]);
const ALLOWED_REF: Record<string, string[]> = { REFUND: ["BET"], ROLLBACK: ["BET", "WIN", "REFUND"], WIN: ["BET"] };
const HTTP: Record<Status, number> = { PROCESSED: 200, PENDING_REFERENCE: 202, REJECTED: 422 };

class Oracle {
  readonly txs = new Map<string, ModelTx>(); // provider|ext
  readonly keys = new Map<string, ModelTx>(); // provider|key
  constructor(readonly wallets: Map<string, ModelWallet>) {}

  private reversed(ref: ModelTx): boolean {
    return [...this.txs.values()].some((t) => REVERSALS.has(t.kind) && t.status === "PROCESSED" && t.refTx === ref);
  }
  private activeWin(bet: ModelTx): boolean {
    return [...this.txs.values()].some((t) => t.kind === "WIN" && t.status === "PROCESSED" && t.refTx === bet && !this.reversed(t));
  }

  /** O que o sistema deve responder a `payload` com `key`. Atualiza o estado do modelo. */
  submit(payload: WagerPayload, key: string): Expected {
    const p = payload;
    // 400: validação de forma e de domínio (antes de qualquer efeito).
    if (!VALID_AMOUNT.test(p.money.amount) || toCents(p.money.amount) === 0n) return { httpStatus: 400, errorCode: "INVALID_PAYLOAD" };
    if (!["BET", "WIN", "LOSS", "REFUND", "ROLLBACK"].includes(p.kind)) return { httpStatus: 400, errorCode: "INVALID_PAYLOAD" };
    if (p.providerId === "internal") return { httpStatus: 400, errorCode: "INVALID_PAYLOAD" };
    if (REVERSALS.has(p.kind) && !p.referenceExternalTransactionId) return { httpStatus: 400, errorCode: "INVALID_PAYLOAD" };
    if ((p.kind === "BET" || p.kind === "LOSS") && p.referenceExternalTransactionId !== undefined) return { httpStatus: 400, errorCode: "INVALID_PAYLOAD" };
    if (p.referenceExternalTransactionId === p.externalTransactionId) return { httpStatus: 400, errorCode: "INVALID_PAYLOAD" };
    const wallet = this.wallets.get(p.walletId);
    if (wallet === undefined) return { httpStatus: 404, errorCode: "WALLET_NOT_FOUND" };

    // Idempotência por provedor.
    const payloadJson = JSON.stringify(p);
    const byKey = this.keys.get(`${p.providerId}|${key}`);
    if (byKey !== undefined) {
      if (byKey.payloadJson !== payloadJson) return { httpStatus: 409, errorCode: "IDEMPOTENCY_CONFLICT" };
      return { httpStatus: byKey.response.httpStatus, body: { ...stripUndefined(byKey.response), idempotentReplay: true } };
    }
    if (this.txs.has(`${p.providerId}|${p.externalTransactionId}`)) return { httpStatus: 409, errorCode: "IDEMPOTENCY_CONFLICT" };

    const tx: ModelTx = {
      provider: p.providerId, ext: p.externalTransactionId, key, payloadJson, kind: p.kind,
      cents: toCents(p.money.amount), currency: p.money.currency, walletId: p.walletId, playerId: p.playerId,
      round: p.roundId, refExt: p.referenceExternalTransactionId, status: "PROCESSED", response: undefined as never,
    };
    const decide = (): { status: Status; code?: string; ref?: ModelTx; delta?: bigint } => {
      if (tx.currency !== wallet.currency) return { status: "REJECTED", code: "CURRENCY_MISMATCH" };
      if (tx.playerId !== wallet.playerId) return { status: "REJECTED", code: "PLAYER_WALLET_MISMATCH" };
      let ref: ModelTx | undefined;
      if (tx.refExt !== undefined) {
        ref = this.txs.get(`${tx.provider}|${tx.refExt}`);
        if (ref === undefined || ref.status === "PENDING_REFERENCE") return { status: "PENDING_REFERENCE" };
        if (ref.status !== "PROCESSED") return { status: "REJECTED", code: "REFERENCE_NOT_PROCESSED", ref };
        if (ref.playerId !== tx.playerId || ref.walletId !== tx.walletId || ref.currency !== tx.currency || ref.round !== tx.round) {
          return { status: "REJECTED", code: "REFERENCE_MISMATCH", ref };
        }
        if (!(ALLOWED_REF[tx.kind] ?? []).includes(ref.kind)) return { status: "REJECTED", code: "REFERENCE_INVALID_KIND", ref };
        if (REVERSALS.has(tx.kind) && ref.cents !== tx.cents) return { status: "REJECTED", code: "AMOUNT_MISMATCH", ref };
        if (this.reversed(ref)) return { status: "REJECTED", code: "ALREADY_REVERSED", ref };
        if (REVERSALS.has(tx.kind) && ref.kind === "BET" && this.activeWin(ref)) {
          return { status: "REJECTED", code: "REFERENCE_ALREADY_SETTLED", ref };
        }
      }
      if (tx.kind === "LOSS") return { status: "PROCESSED", ref };
      const credit = tx.kind === "WIN" || tx.kind === "REFUND" || (tx.kind === "ROLLBACK" && ref?.kind === "BET");
      if (!credit && wallet.cents < tx.cents) {
        return { status: "REJECTED", code: tx.kind === "BET" ? "INSUFFICIENT_FUNDS" : "REVERSAL_INSUFFICIENT_FUNDS", ref };
      }
      return { status: "PROCESSED", ref, delta: credit ? tx.cents : -tx.cents };
    };
    const d = decide();
    if (d.delta !== undefined) wallet.cents += d.delta;
    tx.status = d.status;
    tx.failureCode = d.code;
    tx.refTx = d.status === "PENDING_REFERENCE" ? undefined : d.ref;
    tx.response = { httpStatus: HTTP[d.status], status: d.status, failureCode: d.code, balance: fmt(wallet.cents) };
    this.txs.set(`${tx.provider}|${tx.ext}`, tx);
    this.keys.set(`${tx.provider}|${tx.key}`, tx);
    return { httpStatus: tx.response.httpStatus, body: { ...stripUndefined(tx.response), idempotentReplay: false } };
  }
}

function stripUndefined(r: ModelTx["response"]) {
  return { status: r.status, balance: r.balance, ...(r.failureCode !== undefined ? { failureCode: r.failureCode } : {}) };
}

// ------------------------------------------------------------------ gerador
const AMOUNTS = ["0.50", "1.00", "5.00", "10.00", "25.00", "60.00", "150.00"];
const ROUNDS = ["r1", "r2", "r3", "r4"];

/** Tudo que apareceu nas respostas: o gerador precisa exercitar cada regra, senão o teste não prova nada. */
const coverage = new Map<string, number>();
const seen = (what: string) => coverage.set(what, (coverage.get(what) ?? 0) + 1);

async function runScenario(seed: number, steps: number) {
  const rand = mulberry32(seed);
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
  const chance = (p: number) => rand() < p;

  const playerA = crypto.randomUUID();
  const playerB = crypto.randomUUID();
  const created = [
    (await client.createWallet("100.00", "BRL", playerA)).body,
    (await client.createWallet("50.00", "BRL", playerB)).body,
    (await client.createWallet("30.00", "USD", playerA)).body,
  ] as { id: string; playerId: string; balance: { amount: string; currency: string } }[];
  const wallets = new Map(created.map((w) => [w.id, { id: w.id, playerId: w.playerId, currency: w.balance.currency, cents: toCents(w.balance.amount) }]));
  const oracle = new Oracle(wallets);
  const sent: { payload: WagerPayload; key: string }[] = [];
  const history: string[] = [];
  const round = new Map(created.map((w) => [w.id, pick(ROUNDS)])); // rodada "atual" de cada wallet
  let n = 0;

  for (let step = 0; step < steps; step++) {
    let payload: WagerPayload;
    let key: string;
    const previous = sent.length > 0 ? pick(sent) : undefined;
    const roll = rand();
    if (previous !== undefined && roll < 0.08) {
      ({ payload, key } = previous); // reenvio idêntico → replay
      seen("acao:replay");
    } else if (previous !== undefined && roll < 0.11) {
      payload = { ...previous.payload, money: { ...previous.payload.money, amount: pick(AMOUNTS) } };
      key = previous.key; // mesma chave, payload (provavelmente) diferente → 409
      seen("acao:mesma-chave-outro-payload");
    } else if (previous !== undefined && roll < 0.13) {
      payload = previous.payload;
      key = `other-key-${n++}`; // mesmo externalTransactionId com outra chave → 409
      seen("acao:mesmo-ext-outra-chave");
    } else if (previous !== undefined && roll < 0.16) {
      // A MESMA chave em outro provedor é outra operação (idempotência por provedor).
      const other = previous.payload.providerId === "p-a" ? "p-b" : "p-a";
      payload = { ...previous.payload, providerId: other, externalTransactionId: `s${seed}-x${n++}` };
      delete (payload as { referenceExternalTransactionId?: string }).referenceExternalTransactionId;
      if (REVERSALS.has(payload.kind)) payload = { ...payload, kind: "BET" };
      key = previous.key;
      seen("acao:mesma-chave-outro-provedor");
    } else {
      const wallet = pick(created);
      if (chance(0.12)) round.set(wallet.id, pick(ROUNDS)); // começa outra rodada
      const currentRound = round.get(wallet.id)!;
      const kind = pick(["BET", "BET", "BET", "WIN", "WIN", "LOSS", "REFUND", "ROLLBACK", "ROLLBACK", "ROLLBACK"] as const);
      const ext = `s${seed}-${n++}`;
      let reference: string | undefined;
      let amount = pick(AMOUNTS);
      let roundId = currentRound;
      if (REVERSALS.has(kind) || (kind === "WIN" && chance(0.6))) {
        // Na maior parte das vezes, uma referência coerente (mesma wallet, rodada e provedor),
        // para chegar às regras finas (já revertida, já liquidada, saldo da reversão…).
        const compatible = sent.filter((s) => s.payload.providerId === "p-a" && s.payload.walletId === wallet.id
          && s.payload.playerId === wallet.playerId && s.payload.money.currency === wallet.balance.currency);
        const r = rand();
        if (compatible.length > 0 && r < 0.75) {
          const target = pick(compatible.slice(-12)).payload;
          reference = target.externalTransactionId;
          roundId = target.roundId;
          if (REVERSALS.has(kind) && chance(0.85)) amount = target.money.amount;
        } else if (sent.length > 0 && r < 0.9) {
          reference = pick(sent).payload.externalTransactionId; // qualquer uma: escopo/tipo errados
        } else {
          reference = `missing-${n++}`; // referência que nunca chega → PENDING_REFERENCE
        }
      }
      payload = {
        providerId: chance(0.95) ? "p-a" : "p-b",
        externalTransactionId: ext,
        playerId: chance(0.96) ? wallet.playerId : pick([playerA, playerB]),
        walletId: wallet.id,
        roundId,
        gameId: "fortune-chimp",
        kind: chance(0.01) ? "OPENING" : kind,
        money: { amount: chance(0.02) ? "1.5" : amount, currency: chance(0.03) ? "EUR" : wallet.balance.currency },
        ...(reference !== undefined ? { referenceExternalTransactionId: reference } : {}),
      };
      key = `k-${ext}`;
    }

    const expected = oracle.submit(payload, key);
    const res = await client.submit(payload, key);
    const line = `#${step} ${payload.providerId} ${payload.kind} ${payload.money.amount} ${payload.money.currency} w=${payload.walletId.slice(0, 8)} ` +
      `round=${payload.roundId} ext=${payload.externalTransactionId} ref=${payload.referenceExternalTransactionId ?? "-"} key=${key} → ${res.status} ` +
      `${res.body?.status ?? res.body?.error?.code} ${res.body?.failureCode ?? ""} ${res.body?.balance?.amount ?? ""}`;
    history.push(line);
    const actual = expected.body !== undefined
      ? { httpStatus: res.status, body: { status: res.body.status, balance: res.body.balance?.amount, idempotentReplay: res.body.idempotentReplay,
          ...(res.body.failureCode !== undefined ? { failureCode: res.body.failureCode } : {}) } }
      : { httpStatus: res.status, errorCode: res.body?.error?.code };
    if (JSON.stringify(normalize(actual)) !== JSON.stringify(normalize(expected))) {
      throw new Error(`divergência com o oráculo (seed ${seed}, passo ${step})\nesperado: ${JSON.stringify(expected)}\nrecebido: ${JSON.stringify(actual)}\n` +
        `últimos passos:\n${history.slice(-15).join("\n")}`);
    }
    seen(`http:${res.status}`);
    if (expected.body !== undefined) {
      seen(`status:${expected.body.status}${expected.body.idempotentReplay ? ":replay" : ""}`);
      if (expected.body.failureCode !== undefined) seen(`code:${expected.body.failureCode}`);
    }
    if (res.status < 400 || res.status === 422) sent.push({ payload, key });
  }

  // Estado final: saldos e o status de cada transação gravada batem com o modelo.
  for (const w of wallets.values()) {
    expect({ wallet: w.id, balance: (await client.get(`/wallets/${w.id}`)).body.balance.amount }).toEqual({ wallet: w.id, balance: fmt(w.cents) });
  }
  const rows = await db.sql`select provider_id, external_transaction_id, status, failure_code from wager_transactions
                             where wallet_id in ${db.sql([...wallets.keys()])} and kind <> 'OPENING'`;
  expect(rows.length).toBe(oracle.txs.size);
  for (const r of rows as { provider_id: string; external_transaction_id: string; status: string; failure_code: string | null }[]) {
    const m = oracle.txs.get(`${r.provider_id}|${r.external_transaction_id}`);
    expect({ ext: r.external_transaction_id, status: r.status, code: r.failure_code })
      .toEqual({ ext: r.external_transaction_id, status: m?.status ?? "?", code: m?.failureCode ?? null });
  }
  return { steps, transactions: oracle.txs.size };
}

function normalize(e: { httpStatus: number; body?: object; errorCode?: string }) {
  return e.body !== undefined ? { httpStatus: e.httpStatus, body: sortKeys(e.body) } : { httpStatus: e.httpStatus, errorCode: e.errorCode };
}
function sortKeys(o: object) {
  return Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));
}

describe("sistema × oráculo independente", () => {
  for (const seed of [1, 7, 42, 1234, 2026, 31337]) {
    test(`seed ${seed}: 300 operações, cada resposta igual à do oráculo`, async () => {
      const summary = await runScenario(seed, 300);
      expect(summary.transactions).toBeGreaterThan(100);
    }, 120_000);
  }

  test("as sequências exercitaram todas as regras (senão o teste não provaria nada)", () => {
    const required = [
      "status:PROCESSED", "status:REJECTED", "status:PENDING_REFERENCE", "status:PROCESSED:replay", "status:REJECTED:replay",
      "http:400", "http:409",
      "code:INSUFFICIENT_FUNDS", "code:REVERSAL_INSUFFICIENT_FUNDS", "code:CURRENCY_MISMATCH", "code:PLAYER_WALLET_MISMATCH",
      "code:REFERENCE_NOT_PROCESSED", "code:REFERENCE_MISMATCH", "code:REFERENCE_INVALID_KIND", "code:AMOUNT_MISMATCH",
      "code:ALREADY_REVERSED", "code:REFERENCE_ALREADY_SETTLED",
      "acao:mesma-chave-outro-provedor",
    ];
    const missing = required.filter((r) => !coverage.has(r));
    expect({ missing, coverage: Object.fromEntries([...coverage].sort()) }).toMatchObject({ missing: [] });
  });
});
