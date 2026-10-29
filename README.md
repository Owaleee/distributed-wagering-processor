# Distributed Wagering Processor

[![CI](https://github.com/Owaleee/distributed-wagering-processor/actions/workflows/ci.yml/badge.svg)](https://github.com/Owaleee/distributed-wagering-processor/actions/workflows/ci.yml)

> Solução do desafio técnico [junglegaming/backend-challenge](https://github.com/junglegaming/backend-challenge).

Serviço de carteira que processa transações de apostas (`BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`) recebidas por HTTP e por SQS, correto com mensagens duplicadas, fora de ordem e múltiplas instâncias.

> Em construção — as decisões técnicas ficam em [`ARCHITECTURE.md`](./ARCHITECTURE.md).

## Requisitos
- Docker com Docker Compose v2
- Bun 1.4.x (para testes e scripts fora do Docker)

## Subir tudo
```bash
docker compose up --build -d
curl localhost:3001/health/live
```
Sobem PostgreSQL 16, MiniStack (emulador de SQS, sem conta nem token), o serviço `setup` (migrations + filas) e três instâncias da aplicação nas portas 3001, 3002 e 3003. As portas do host são configuráveis (`POSTGRES_PORT`, `SQS_PORT`, `APP1_PORT`…, ver `.env.example`).

## API
| Método e rota | O que faz |
|---|---|
| `POST /wallets` | Cria a wallet de um player numa moeda, com saldo inicial (gera crédito no ledger) |
| `GET /wallets/:walletId` | Saldo e versão |
| `GET /wallets/:walletId/ledger?limit=&cursor=` | Lançamentos, paginados por cursor |
| `POST /wallets/:walletId/reconciliation` | Confere saldo == soma do ledger (não corrige) |
| `POST /wagering/transactions` | Processa BET, WIN, LOSS, REFUND ou ROLLBACK (header `Idempotency-Key` obrigatório) |
| `GET /wagering/transactions/:transactionId` | Consulta por id interno |
| `GET /providers/:providerId/wagering/transactions/:externalTransactionId` | Consulta por id do provedor |
| `GET /health/live`, `GET /health/ready`, `GET /metrics` | Saúde e métricas Prometheus |

Exemplo:
```bash
WALLET=$(curl -s localhost:3001/wallets -H 'content-type: application/json' \
  -d '{"playerId":"0b9f4d1e-6a51-4c39-9a76-1d1f8c2b7e10","initialBalance":{"amount":"100.00","currency":"BRL"}}')
WALLET_ID=$(echo "$WALLET" | sed -E 's/.*"id":"([^"]+)".*/\1/')

curl -s localhost:3001/wagering/transactions -H 'content-type: application/json' -H 'Idempotency-Key: provider-a:bet-1' \
  -d "{\"providerId\":\"provider-a\",\"externalTransactionId\":\"bet-1\",\"playerId\":\"0b9f4d1e-6a51-4c39-9a76-1d1f8c2b7e10\",
       \"walletId\":\"$WALLET_ID\",\"roundId\":\"round-1\",\"gameId\":\"fortune-chimp\",\"kind\":\"BET\",
       \"money\":{\"amount\":\"25.00\",\"currency\":\"BRL\"}}"
# → 200 {"transactionId":"…","status":"PROCESSED","balance":{"amount":"75.00","currency":"BRL"},"idempotentReplay":false}
```
Valores sempre como string com 2 casas (`"25.00"`). Status de resposta e códigos de falha: [`ARCHITECTURE.md`](./ARCHITECTURE.md#d13--mapeamento-http).

### Pela fila SQS
A fila `wager-transactions.fifo` recebe o mesmo comando, no envelope `WagerTransactionRequested`:
```json
{ "messageId": "msg-1", "type": "WagerTransactionRequested", "occurredAt": "2026-10-29T12:00:00Z",
  "data": { "providerId": "provider-a", "externalTransactionId": "bet-2", "idempotencyKey": "provider-a:bet-2",
            "playerId": "…", "walletId": "…", "roundId": "round-1", "gameId": "fortune-chimp",
            "kind": "BET", "money": { "amount": "10.00", "currency": "BRL" } } }
```
Use `MessageGroupId = walletId`. Rejeições de negócio são confirmadas (a transação fica `REJECTED`); erros temporários voltam para a fila com backoff; mensagens inválidas vão para a DLQ `wager-transactions-dlq.fifo` com o motivo em `failureReason`.

## Desenvolvimento
```bash
bun install
bun run hooks:install   # typecheck + testes de unidade antes de cada commit
docker compose up -d postgres ministack
bun run setup           # migrations + filas
bun run start           # aplicação na porta 3000
bun test
```
O GitHub Actions roda o typecheck, todos os testes e um `docker compose up` do zero a cada push.
