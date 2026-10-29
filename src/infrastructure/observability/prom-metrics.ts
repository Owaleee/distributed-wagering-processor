import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from "prom-client";
import type { Metrics } from "../../application/observability";

/** Métricas no formato Prometheus, expostas em GET /metrics. */
export class PromMetrics implements Metrics {
  readonly registry = new Registry();

  private readonly transactions = new Counter({
    name: "wager_transactions_total", help: "Transações por status final e origem",
    labelNames: ["status", "source"], registers: [this.registry],
  });
  private readonly duplicates = new Counter({
    name: "wager_duplicates_detected_total", help: "Duplicatas detectadas (replay de idempotência ou inbox)",
    labelNames: ["kind"], registers: [this.registry],
  });
  private readonly retries = new Counter({
    name: "wager_retries_total", help: "Novas tentativas", labelNames: ["kind"], registers: [this.registry],
  });
  private readonly dlq = new Counter({
    name: "wager_dlq_messages_total", help: "Mensagens enviadas para a DLQ", labelNames: ["reason"], registers: [this.registry],
  });
  private readonly dlqDepthGauge = new Gauge({
    name: "wager_dlq_depth", help: "Mensagens na DLQ agora (inclui as movidas pelo redrive do SQS)", registers: [this.registry],
  });
  private readonly lockConflicts = new Counter({
    name: "wager_lock_conflicts_total", help: "Conflitos de concorrência (lock timeout, unicidade concorrente)",
    labelNames: ["kind"], registers: [this.registry],
  });
  private readonly outboxLagGauge = new Gauge({
    name: "outbox_lag_seconds", help: "Idade do evento mais antigo ainda não publicado", registers: [this.registry],
  });
  private readonly latency = new Histogram({
    name: "wager_processing_seconds", help: "Latência do processamento de uma transação",
    labelNames: ["source"], buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [this.registry],
  });
  private readonly divergences = new Counter({
    name: "wallet_reconciliation_divergences_total", help: "Reconciliações com divergência", registers: [this.registry],
  });

  private readonly rejectedRequests = new Counter({
    name: "http_requests_rejected_total", help: "Requisições recusadas por código de erro (400, 404, 409)",
    labelNames: ["code"], registers: [this.registry],
  });

  constructor() {
    collectDefaultMetrics({ register: this.registry });
  }

  transactionProcessed(status: string, source: "http" | "sqs" | "worker"): void {
    this.transactions.inc({ status, source });
  }
  duplicateDetected(kind: "idempotency_replay" | "inbox"): void {
    this.duplicates.inc({ kind });
  }
  retry(kind: "sqs" | "outbox" | "pending_reference"): void {
    this.retries.inc({ kind });
  }
  sentToDlq(reason: string): void {
    this.dlq.inc({ reason });
  }
  dlqDepth(messages: number): void {
    this.dlqDepthGauge.set(messages);
  }
  lockConflict(kind: "lock_timeout" | "unique_conflict"): void {
    this.lockConflicts.inc({ kind });
  }
  outboxLag(seconds: number): void {
    this.outboxLagGauge.set(seconds);
  }
  processingLatency(seconds: number, source: "http" | "sqs" | "worker"): void {
    this.latency.observe({ source }, seconds);
  }
  reconciliationDivergence(): void {
    this.divergences.inc();
  }
  requestRejected(code: string): void {
    this.rejectedRequests.inc({ code });
  }
}
