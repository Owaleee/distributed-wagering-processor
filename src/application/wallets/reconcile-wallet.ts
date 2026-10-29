import type { MoneyProps } from "../../domain/money/money";
import { WalletNotFoundError } from "../errors";
import type { Logger, Metrics } from "../observability";

export interface ReconciliationSnapshot {
  walletId: string;
  storedBalance: MoneyProps;
  calculatedBalance: MoneyProps;
  difference: MoneyProps;
  checkedEntries: number;
}

export interface ReconciliationSource {
  reconciliationSnapshot(walletId: string): Promise<ReconciliationSnapshot | undefined>;
}

export interface ReconciliationReport extends ReconciliationSnapshot {
  consistent: boolean;
}

/**
 * Confere se o saldo materializado bate com o saldo reconstruído pelo ledger.
 * Divergências NÃO são corrigidas: são logadas, contadas em métrica e sinalizadas na resposta,
 * para que uma pessoa investigue a causa.
 */
export class ReconcileWallet {
  constructor(
    private readonly source: ReconciliationSource,
    private readonly logger: Logger,
    private readonly metrics: Metrics,
  ) {}

  async execute(walletId: string, correlationId: string): Promise<ReconciliationReport> {
    const snapshot = await this.source.reconciliationSnapshot(walletId);
    if (snapshot === undefined) throw new WalletNotFoundError(walletId);
    const consistent = snapshot.storedBalance.amount === snapshot.calculatedBalance.amount;
    if (!consistent) {
      this.metrics.reconciliationDivergence();
      this.logger.error("divergência entre saldo materializado e ledger", {
        correlationId,
        walletId,
        difference: snapshot.difference.amount,
        checkedEntries: snapshot.checkedEntries,
      });
    }
    return { ...snapshot, consistent };
  }
}
