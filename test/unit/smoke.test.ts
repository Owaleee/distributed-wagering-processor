import { describe, expect, test } from "bun:test";
import { loadConfig } from "../../src/infrastructure/config";

describe("configuração", () => {
  test("padrões de desenvolvimento local", () => {
    const config = loadConfig();
    expect(config.sqs.wagerQueueName).toBe("wager-transactions.fifo");
    expect(config.sqs.wagerDlqName).toBe("wager-transactions-dlq.fifo");
  });

  test("variável numérica inválida é recusada", () => {
    process.env.WAGER_MAX_RECEIVE_COUNT = "zero";
    try {
      expect(() => loadConfig()).toThrow("WAGER_MAX_RECEIVE_COUNT");
    } finally {
      delete process.env.WAGER_MAX_RECEIVE_COUNT;
    }
  });
});
