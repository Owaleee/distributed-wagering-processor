/**
 * Teste de carga — `bun run test:load`
 *
 * Pré-requisito: a stack no ar (`docker compose up --build -d`), com as 3 instâncias em
 * localhost:3001–3003. Outros alvos: LOAD_TARGETS=http://host:porta,http://host:porta
 *
 * Metodologia (configurável por variáveis de ambiente):
 * - LOAD_WALLETS wallets (padrão 100) com saldo 100000.00, mais 1 "hot wallet".
 * - LOAD_CONCURRENCY clientes (padrão 64) enviando sem pausa durante LOAD_DURATION_S segundos
 *   (padrão 30), em rodízio entre as instâncias.
 * - Mistura: 10% replay de uma requisição já enviada (mesma key, mesmo payload), LOAD_HOT_RATIO
 *   (padrão 10%) de BETs na mesma "hot wallet" (disputa de lock) e o resto dividido entre BET, WIN e LOSS.
 * - Durante a carga, amostra outbox_lag_seconds em /metrics a cada segundo.
 * - No fim: espera a outbox drenar e roda a reconciliação de TODAS as wallets.
 *   Qualquer divergência faz o script sair com código 1.
 */

const targets = (process.env.LOAD_TARGETS ?? "http://localhost:3001,http://localhost:3002,http://localhost:3003")
  .split(",").map((t) => t.trim()).filter(Boolean);
const WALLETS = Number(process.env.LOAD_WALLETS ?? 100);
const CONCURRENCY = Number(process.env.LOAD_CONCURRENCY ?? 64);
const DURATION_S = Number(process.env.LOAD_DURATION_S ?? 30);
/** Fração das requisições que disputam a mesma wallet (0 desliga a hot wallet). */
const HOT_RATIO = Number(process.env.LOAD_HOT_RATIO ?? 0.1);

interface Wallet { id: string; playerId: string }
interface Sent { payload: Record<string, unknown>; key: string }
interface Sample { ms: number; status: number; kind: string }

let rr = 0;
const target = () => targets[rr++ % targets.length]!;

async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${target()}${path}`, {
    method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined };
}

async function createWallet(amount: string): Promise<Wallet> {
  const playerId = crypto.randomUUID();
  const res = await post("/wallets", { playerId, initialBalance: { amount, currency: "BRL" } });
  if (res.status !== 201) throw new Error(`falha ao criar wallet: ${res.status} ${JSON.stringify(res.body)}`);
  return { id: res.body.id, playerId };
}

function payload(w: Wallet, kind: string, amount: string): Sent {
  const externalTransactionId = `load-${crypto.randomUUID()}`;
  return {
    key: `load:${externalTransactionId}`,
    payload: {
      providerId: "load", externalTransactionId, playerId: w.playerId, walletId: w.id,
      roundId: `r-${Math.floor(Math.random() * 1000)}`, gameId: "load-game", kind,
      money: { amount, currency: "BRL" },
    },
  };
}

async function outboxLag(): Promise<number> {
  const values = await Promise.all(targets.map(async (t) => {
    try {
      const text = await (await fetch(`${t}/metrics`)).text();
      const m = /^outbox_lag_seconds\s+([\d.eE+-]+)/m.exec(text);
      return m ? Number(m[1]) : 0;
    } catch { return 0; }
  }));
  return Math.max(...values);
}

async function metricSum(name: string): Promise<number> {
  let total = 0;
  for (const t of targets) {
    const text = await (await fetch(`${t}/metrics`)).text();
    for (const line of text.split("\n")) if (line.startsWith(name)) total += Number(line.split(" ").at(-1));
  }
  return total;
}

const pct = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0;

// ------------------------------------------------------------------ preparação
console.log(`alvos: ${targets.join(", ")} · wallets: ${WALLETS} · concorrência: ${CONCURRENCY} · duração: ${DURATION_S}s · hot: ${HOT_RATIO}`);
const wallets: Wallet[] = [];
for (let i = 0; i < WALLETS; i += 20) {
  wallets.push(...(await Promise.all(Array.from({ length: Math.min(20, WALLETS - i) }, () => createWallet("100000.00")))));
}
const hot = await createWallet("100000.00");
const lockConflictsBefore = await metricSum("wager_lock_conflicts_total");

// ------------------------------------------------------------------ carga
const samples: Sample[] = [];
const sent: Sent[] = [];
const lagSamples: number[] = [];
let networkErrors = 0;
/** Mensagens dos erros de rede (sem resposta HTTP), para o relatório. */
const networkErrorMessages = new Map<string, number>();
const deadline = Date.now() + DURATION_S * 1000;

const lagSampler = (async () => {
  while (Date.now() < deadline) {
    lagSamples.push(await outboxLag());
    await new Promise((r) => setTimeout(r, 1000));
  }
})();

async function client(): Promise<void> {
  while (Date.now() < deadline) {
    const roll = Math.random();
    const w = wallets[Math.floor(Math.random() * wallets.length)]!;
    let op: Sent;
    let kind: string;
    if (roll < 0.1 && sent.length > 0) {
      op = sent[Math.floor(Math.random() * sent.length)]!; kind = "REPLAY";
    } else if (roll < 0.1 + HOT_RATIO) {
      op = payload(hot, "BET", "1.00"); kind = "HOT_BET";
    } else if (roll < 0.8) {
      op = payload(w, "BET", "1.25"); kind = "BET";
    } else if (roll < 0.95) {
      op = payload(w, "WIN", "2.50"); kind = "WIN";
    } else {
      op = payload(w, "LOSS", "1.25"); kind = "LOSS";
    }
    const started = performance.now();
    try {
      const res = await post("/wagering/transactions", op.payload, { "Idempotency-Key": op.key });
      samples.push({ ms: performance.now() - started, status: res.status, kind });
      if (kind !== "REPLAY" && res.status < 500) sent.push(op);
    } catch (error) {
      networkErrors += 1;
      const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      networkErrorMessages.set(message, (networkErrorMessages.get(message) ?? 0) + 1);
    }
  }
}

const startedAt = performance.now();
await Promise.all(Array.from({ length: CONCURRENCY }, client));
const elapsedS = (performance.now() - startedAt) / 1000;
await lagSampler;

// ------------------------------------------------------------------ verificação final
const drainStart = performance.now();
while ((await outboxLag()) > 0 && performance.now() - drainStart < 60_000) await new Promise((r) => setTimeout(r, 500));
const drainS = (performance.now() - drainStart) / 1000;

let divergent = 0;
for (const w of [...wallets, hot]) {
  const rec = await post(`/wallets/${w.id}/reconciliation`, undefined);
  if (rec.body?.consistent !== true) divergent += 1;
}
const lockConflicts = (await metricSum("wager_lock_conflicts_total")) - lockConflictsBefore;

// ------------------------------------------------------------------ relatório
const latencies = samples.map((s) => s.ms).sort((a, b) => a - b);
const byStatus = new Map<number, number>();
for (const s of samples) byStatus.set(s.status, (byStatus.get(s.status) ?? 0) + 1);
const errors5xx = samples.filter((s) => s.status >= 500).length + networkErrors;
const hotLat = samples.filter((s) => s.kind === "HOT_BET").map((s) => s.ms).sort((a, b) => a - b);

const report = {
  requests: samples.length,
  throughputRps: Number((samples.length / elapsedS).toFixed(1)),
  latencyMs: { p50: +pct(latencies, 50).toFixed(1), p95: +pct(latencies, 95).toFixed(1), p99: +pct(latencies, 99).toFixed(1), max: +(latencies.at(-1) ?? 0).toFixed(1) },
  hotWalletLatencyMs: { p50: +pct(hotLat, 50).toFixed(1), p95: +pct(hotLat, 95).toFixed(1), p99: +pct(hotLat, 99).toFixed(1) },
  statusCodes: Object.fromEntries([...byStatus.entries()].sort()),
  errorRate: `${((errors5xx / Math.max(1, samples.length + networkErrors)) * 100).toFixed(2)}%`,
  networkErrors,
  ...(networkErrors > 0 ? { networkErrorMessages: Object.fromEntries(networkErrorMessages) } : {}),
  replays: samples.filter((s) => s.kind === "REPLAY").length,
  lockConflicts,
  outboxLagSeconds: { max: +Math.max(0, ...lagSamples).toFixed(2), avg: +(lagSamples.reduce((a, b) => a + b, 0) / Math.max(1, lagSamples.length)).toFixed(2) },
  outboxDrainAfterLoadSeconds: +drainS.toFixed(1),
  walletsReconciled: wallets.length + 1,
  walletsDivergent: divergent,
};
console.log(JSON.stringify(report, null, 2));
if (divergent > 0) {
  console.error(`FALHA: ${divergent} wallet(s) com saldo divergente do ledger`);
  process.exit(1);
}
console.log("OK: todas as wallets reconciliadas (saldo == ledger)");

export {};
