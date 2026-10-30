# Distributed Wagering Processor

[![CI](https://github.com/Owaleee/distributed-wagering-processor/actions/workflows/ci.yml/badge.svg)](https://github.com/Owaleee/distributed-wagering-processor/actions/workflows/ci.yml)

> Solução do desafio técnico [junglegaming/backend-challenge](https://github.com/junglegaming/backend-challenge).

Serviço de carteira que processa transações de apostas (`BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`) recebidas por HTTP e por SQS, correto com mensagens duplicadas, fora de ordem e múltiplas instâncias.

## Em resumo
- **Dinheiro nunca é `number`:** centavos em `bigint` no código, `NUMERIC(20,2)` no banco e string `"25.00"` nos contratos.
- **Cada operação trava a wallet** (`SELECT … FOR UPDATE`) antes de qualquer verificação: operações da mesma wallet entram em fila, wallets diferentes seguem em paralelo.
- **Idempotência no PostgreSQL:** `(providerId, Idempotency-Key)` única, comparação do `payloadHash`, replay com o resultado original; a inbox `(consumidor, messageId)` deduplica redeliveries da fila.
- **Ledger imutável e conferido pelo banco:** cada mudança de saldo tem um lançamento com saldo antes e depois e a versão da wallet; triggers impedem alterar o ledger ou mudar saldo sem lançamento.
- **Eventos só depois do commit** (Transactional Outbox) e **referências fora de ordem** resolvidas por um worker (`PENDING_REFERENCE`).
- **Várias instâncias sem coordenação:** todas as garantias estão no banco; testado com 3 processos reais e SIGKILL no meio da carga.

As decisões, com motivo e trade-off, estão em [`ARCHITECTURE.md`](./ARCHITECTURE.md); a medição de carga, em [`LOAD_TEST.md`](./LOAD_TEST.md).

## Requisitos
- Docker com Docker Compose v2
- Bun 1.4.x (para testes e scripts fora do Docker)

## Subir tudo
```bash
docker compose up --build -d
curl localhost:3001/health/ready   # {"status":"ok","checks":{"postgres":"up",…}}
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

Exemplo (ids gerados na hora, então pode ser repetido):
```bash
PLAYER=$(cat /proc/sys/kernel/random/uuid 2>/dev/null || uuidgen | tr A-Z a-z)
WALLET_ID=$(curl -s localhost:3001/wallets -H 'content-type: application/json' \
  -d "{\"playerId\":\"$PLAYER\",\"initialBalance\":{\"amount\":\"100.00\",\"currency\":\"BRL\"}}" \
  | sed -E 's/.*"id":"([^"]+)".*/\1/')

BET="bet-$(date +%s)"
curl -s localhost:3002/wagering/transactions -H 'content-type: application/json' -H "Idempotency-Key: provider-a:$BET" \
  -d "{\"providerId\":\"provider-a\",\"externalTransactionId\":\"$BET\",\"playerId\":\"$PLAYER\",
       \"walletId\":\"$WALLET_ID\",\"roundId\":\"round-1\",\"gameId\":\"fortune-chimp\",\"kind\":\"BET\",
       \"money\":{\"amount\":\"25.00\",\"currency\":\"BRL\"}}"
# → 200 {"transactionId":"…","status":"PROCESSED","balance":{"amount":"75.00","currency":"BRL"},"idempotentReplay":false}
# Repetir o mesmo curl (mesma chave, mesmo corpo) → mesma resposta, com "idempotentReplay":true
```
Para conferir tudo de uma vez (3 instâncias prontas, HTTP, replay, SQS, outbox e reconciliação): `bun run smoke`.

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

## Testes
Com PostgreSQL e MiniStack no ar (`docker compose up -d postgres ministack`). Se você mudou as portas do compose, aponte os testes para elas: `TEST_DATABASE_ADMIN_URL=postgresql://postgres:postgres@localhost:5433/postgres SQS_ENDPOINT=http://localhost:4567 bun test`.

| Comando | O que roda |
|---|---|
| `bun run test:unit` | domínio (Money, regras, ledger, idempotência), formato de log, filtro de erros HTTP e classificação de erros do banco — sem banco |
| `bun run test:integration` | API, schema e constraints, atomicidade, consumidor SQS (inbox, retry, DLQ, SIGTERM, crash entre commit e ack com processo real), outbox, pendências, falhas de infraestrutura (lock, pool, banco fora), **teste baseado em modelo** e **entradas hostis** |
| `bun run test:concurrency` | 100/80/80, 50 cópias em paralelo, hot wallet, 3 processos reais com SIGKILL sob carga HTTP e SQS, e **caos** (HTTP + SQS + duplicatas + fora de ordem + SIGKILL) |
| `bun test` | tudo |
| `bun run smoke` | smoke de ponta a ponta contra a stack do compose (o CI roda contra os containers) |
| `bun run test:load` | teste de carga contra a stack do compose (ver `LOAD_TEST.md`) |

Os testes de integração e de concorrência usam **PostgreSQL e MiniStack reais**, nunca mocks: cada suíte cria um banco e filas próprios. Toda suíte termina com um **verificador de invariantes** que procura no banco estados impossíveis (saldo negativo, saldo diferente do ledger, corrente do ledger quebrada, transação com lançamento a mais ou a menos, reversão dupla, crédito em dobro, evento faltando na outbox…).

### Como os testes foram validados
- **Oráculo independente** (`model-based.test.ts`): 1 800 operações aleatórias com seed fixa (válidas, inválidas, replays, conflitos, fora de ordem) comparadas, uma a uma, com as regras reescritas sem importar o domínio. Um portão de cobertura falha se algum código de falha não for exercitado.
- **Mutação:** 9 bugs injetados de propósito no código (regra do WIN, BET já liquidada, idempotência sem provedor, códigos de saldo trocados, escopo da rodada, saldo do replay, direção do ROLLBACK, valor da reversão, referência pendente); o oráculo pegou todos.
- **O verificador de invariantes é testado** contra um banco adulterado (`invariant-checker.test.ts`).
- **Fuzz** (`hostile-input.test.ts`): formatos de dinheiro, campos, chaves de protótipo, headers, corpos, rotas, cursores, 600 corpos aleatórios e mensagens SQS com lixo — nunca 500, nunca efeito no saldo.

## Configuração
Todas as variáveis têm padrão para desenvolvimento local; a lista comentada está em [`.env.example`](./.env.example). As principais:

| Variável | Padrão | Para quê |
|---|---|---|
| `DATABASE_URL` | `postgresql://postgres:postgres@localhost:5432/wagering` | PostgreSQL |
| `SQS_ENDPOINT` | `http://localhost:4566` | SQS (MiniStack) |
| `LOCK_TIMEOUT_MS` / `DB_CONNECT_TIMEOUT_MS` | 5000 / 5000 | espera máxima por lock e por conexão antes de responder 503 |
| `WAGER_MAX_RECEIVE_COUNT` | 5 | recebimentos antes de o SQS mover a mensagem para a DLQ |
| `PENDING_REFERENCE_BASE_DELAY_MS` / `PENDING_REFERENCE_MAX_ATTEMPTS` | 2000 / 8 | janela de espera por uma referência (~8,5 min) |
| `CONSUMER_ENABLED`, `OUTBOX_PUBLISHER_ENABLED`, `PENDING_REFERENCE_WORKER_ENABLED` | `true` | liga ou desliga cada processo de fundo |
| `LOG_LEVEL` | `info` | `info`, `warn`, `error` ou `silent` |

## Estrutura
```
src/
  domain/          regras puras: Money, Wallet, WagerTransaction, ledger, eventos (sem framework nem banco)
  application/     casos de uso e portas (UnitOfWork, Clock…): o mesmo fluxo para HTTP e SQS
  infrastructure/  MikroORM, migrations, SQS, outbox relay, worker de pendências, logs e métricas
  interface/http/  controllers, validação (zod), mapeamento de erros para status HTTP
test/
  unit/  integration/  concurrency/  support/
scripts/           setup (migrations + filas), teste de carga, hook de pre-commit
```

## Documentação
- [`ARCHITECTURE.md`](./ARCHITECTURE.md): decisões D1–D21, máquina de estados, códigos de falha, interpretações adotadas, limitações conhecidas e revisão contra as falhas eliminatórias.
- [`LOAD_TEST.md`](./LOAD_TEST.md): metodologia, resultados e análise do teste de carga.
