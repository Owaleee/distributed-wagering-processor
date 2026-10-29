export const CREATE_WALLET = Symbol("CREATE_WALLET");
export const PROCESS_WAGER = Symbol("PROCESS_WAGER");
export const RECONCILE_WALLET = Symbol("RECONCILE_WALLET");
export const READ_MODEL = Symbol("READ_MODEL");
export const READINESS_CHECKS = Symbol("READINESS_CHECKS");
export const PROM_METRICS = Symbol("PROM_METRICS");

export interface ReadinessCheck {
  readonly name: string;
  check(): Promise<void>;
}
