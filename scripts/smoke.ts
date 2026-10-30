/**
 * Smoke test de ponta a ponta contra a stack do `docker compose` — `bun run smoke`
 *
 * Confere, do lado de fora, o que um avaliador faria à mão:
 * 1. as 3 instâncias prontas (PostgreSQL e as 3 filas alcançáveis de DENTRO dos containers);
 * 2. wallet criada e BET via HTTP, com replay idêntico;
 * 3. BET via SQS consumida por um dos containers (inbox + ack);
 * 4. eventos publicados pela outbox na fila de eventos;
 * 5. reconciliação consistente.
 * Sai com código 1 na primeira falha.
 *
 * Alvos: SMOKE_TARGETS (padrão localhost:3001–3003) e SQS_ENDPOINT (padrão localhost:4566).
 */
import { GetQueueAttributesCommand, GetQueueUrlCommand, SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";

const targets = (process.env.SMOKE_TARGETS ?? "http://localhost:3001,http://localhost:3002,http://localhost:3003").split(",");
const sqs = new SQSClient({
  endpoint: process.env.SQS_ENDPOINT ?? "http://localhost:4566",
  region: process.env.AWS_REGION ?? "us-east-1",
  credentials: { accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? "test", secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? "test" },
});

function check(condition: unknown, message: string): asserts condition {
  if (!condition) {
    console.error(`FALHOU: ${message}`);
    process.exit(1);
  }
  console.log(`ok  ${message}`);
}

async function call(target: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${target}${path}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined };
}

async function waitFor<T>(what: string, fn: () => Promise<T | undefined>, timeoutMs = 60_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value !== undefined) return value;
    } catch {
      // ainda subindo
    }
    await Bun.sleep(500);
  }
  check(false, `${what} (timeout)`);
  throw new Error("inalcançável");
}

// 1. Readiness das 3 instâncias: prova que, de dentro dos containers, PostgreSQL e as filas respondem.
for (const target of targets) {
  const ready = await waitFor(`${target} pronta`, async () => {
    const res = await call(target, "GET", "/health/ready");
    return res.status === 200 ? res.body : undefined;
  });
  check(Object.values(ready.checks).every((s) => s === "up"), `${target} /health/ready com postgres e as 3 filas "up"`);
}

// 2. HTTP: wallet, BET e replay.
const [a, b, c] = [targets[0]!, targets[1 % targets.length]!, targets[2 % targets.length]!];
const playerId = crypto.randomUUID();
const wallet = await call(a, "POST", "/wallets", { playerId, initialBalance: { amount: "100.00", currency: "BRL" } });
check(wallet.status === 201 && wallet.body.balance.amount === "100.00", "wallet criada com 100.00 BRL");
const walletId = wallet.body.id as string;

const run = crypto.randomUUID().slice(0, 8);
const bet = {
  providerId: "smoke", externalTransactionId: `bet-http-${run}`, playerId, walletId,
  roundId: `round-${run}`, gameId: "fortune-chimp", kind: "BET", money: { amount: "25.00", currency: "BRL" },
};
const key = `smoke:${bet.externalTransactionId}`;
const first = await call(b, "POST", "/wagering/transactions", bet, { "Idempotency-Key": key });
check(first.status === 200 && first.body.balance.amount === "75.00", "BET via HTTP processada (saldo 75.00)");
const replay = await call(c, "POST", "/wagering/transactions", bet, { "Idempotency-Key": key });
check(replay.status === 200 && replay.body.idempotentReplay === true && replay.body.transactionId === first.body.transactionId,
  "replay em outra instância devolve o resultado original");

// 3. SQS: uma BET pela fila, consumida por um dos containers.
const queueUrl = (await sqs.send(new GetQueueUrlCommand({ QueueName: process.env.WAGER_QUEUE_NAME ?? "wager-transactions.fifo" }))).QueueUrl!;
const sqsBet = { ...bet, externalTransactionId: `bet-sqs-${run}`, money: { amount: "10.00", currency: "BRL" } };
await sqs.send(new SendMessageCommand({
  QueueUrl: queueUrl,
  MessageGroupId: walletId,
  MessageDeduplicationId: `smoke-${run}`,
  MessageBody: JSON.stringify({
    messageId: `smoke-${run}`, type: "WagerTransactionRequested", occurredAt: new Date().toISOString(),
    data: { ...sqsBet, idempotencyKey: `smoke:${sqsBet.externalTransactionId}` },
  }),
}));
const viaSqs = await waitFor("BET via SQS processada", async () => {
  const res = await call(a, "GET", `/providers/smoke/wagering/transactions/${sqsBet.externalTransactionId}`);
  return res.status === 200 && res.body.status === "PROCESSED" ? res.body : undefined;
});
check(viaSqs.balance.amount === "65.00", "BET via SQS consumida por um container (saldo 65.00)");

// 4. Outbox: os eventos chegam à fila de eventos.
const eventsUrl = (await sqs.send(new GetQueueUrlCommand({ QueueName: process.env.EVENTS_QUEUE_NAME ?? "wallet-events.fifo" }))).QueueUrl!;
await waitFor("eventos publicados pela outbox", async () => {
  const attrs = await sqs.send(new GetQueueAttributesCommand({
    QueueUrl: eventsUrl, AttributeNames: ["ApproximateNumberOfMessages", "ApproximateNumberOfMessagesNotVisible"],
  }));
  const total = Number(attrs.Attributes?.ApproximateNumberOfMessages ?? 0) + Number(attrs.Attributes?.ApproximateNumberOfMessagesNotVisible ?? 0);
  return total >= 6 ? total : undefined; // abertura (2) + BET HTTP (2) + BET SQS (2)
});
check(true, "eventos da abertura e das duas BETs publicados em wallet-events.fifo");

// 5. Reconciliação.
const reconciliation = await call(b, "POST", `/wallets/${walletId}/reconciliation`);
check(reconciliation.body.consistent === true && reconciliation.body.storedBalance.amount === "65.00", "reconciliação consistente (saldo == ledger)");

console.log("\nSMOKE OK");
