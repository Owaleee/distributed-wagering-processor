# Distributed Wagering Processor

[![CI](https://github.com/Owaleee/distributed-wagering-processor/actions/workflows/ci.yml/badge.svg)](https://github.com/Owaleee/distributed-wagering-processor/actions/workflows/ci.yml)

> Solução do desafio técnico [junglegaming/backend-challenge](https://github.com/junglegaming/backend-challenge).

Uma **carteira digital para apostas**. Provedores de jogos enviam operações (`BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`) por HTTP ou por uma fila SQS, e o serviço mantém o saldo de cada jogador e um extrato (ledger) que não pode ser alterado.

O difícil não é somar e subtrair: é continuar **certo** quando a mesma operação chega duas vezes, quando um estorno chega antes da aposta que ele estorna, quando três cópias do serviço disputam o mesmo saldo e quando o processo morre no meio do caminho. Este README explica como o projeto resolve isso; os detalhes de cada decisão estão no [`ARCHITECTURE.md`](./ARCHITECTURE.md).

## Índice
- [Início rápido](#início-rápido)
- [Como funciona](#como-funciona)
- [As garantias e onde cada uma é provada](#as-garantias-e-onde-cada-uma-é-provada)
- [Operações, estados e respostas](#operações-estados-e-respostas)
- [Usando a API](#usando-a-api)
- [Testes](#testes)
- [Configuração](#configuração)
- [Estrutura do código](#estrutura-do-código)
- [Documentação e limitações](#documentação-e-limitações)

## Início rápido

Requisitos: **Docker** com Compose v2. Para os testes e o smoke, também **Bun 1.4**.

```bash
docker compose up --build -d   # PostgreSQL, MiniStack, setup e 3 instâncias da aplicação
bun install
bun run smoke                  # confere tudo de ponta a ponta → "SMOKE OK"
bun test                       # 329 testes com PostgreSQL e SQS reais
```

O que o `docker compose` sobe:

| Serviço | Para quê | Porta no host |
|---|---|---|
| `postgres` | banco (PostgreSQL 16): saldo, transações, ledger, inbox, outbox | 5432 |
| `ministack` | emulador de SQS (sem conta nem token) | 4566 |
| `setup` | roda uma vez: aplica as migrations e cria as filas, depois termina | — |
| `app-1`, `app-2`, `app-3` | três cópias idênticas da aplicação | 3001, 3002, 3003 |

O `bun run smoke` faz o que você faria à mão: confere que as 3 instâncias estão prontas, cria uma wallet, faz uma aposta por HTTP, repete a aposta em outra instância (replay), envia uma aposta pela fila SQS, espera um container consumir, confere que os eventos foram publicados e roda a reconciliação. O CI roda esse mesmo smoke contra os containers a cada push.

> **Portas ocupadas?** Todas são configuráveis: `POSTGRES_PORT=5433 SQS_PORT=4567 docker compose up --build -d` (ver [`.env.example`](./.env.example)).
> **Windows:** os comandos acima funcionam no PowerShell. Os exemplos com `curl` mais abaixo são para bash (WSL ou Git Bash); o `bun run smoke` faz o mesmo em qualquer sistema.
> **Para desligar:** `docker compose down -v`.

## Como funciona

### Visão geral

Os provedores enviam operações por HTTP (para qualquer uma das 3 instâncias) ou pela fila `wager-transactions.fifo`. Nas duas entradas, o mesmo caso de uso processa a operação e grava tudo no PostgreSQL numa única transação. Em segundo plano, cada instância também roda um publicador, que envia os eventos confirmados para a fila `wallet-events.fifo`, e um worker, que reavalia as operações que chegaram fora de ordem. Mensagens inválidas, ou que falham em todas as tentativas, vão para a DLQ `wager-transactions-dlq.fifo`.

As três instâncias não conversam entre si: **todas as garantias ficam no PostgreSQL** (locks, constraints, triggers). Por isso dá para ter 1, 3 ou 30 cópias sem mudar nada.

### O caminho de uma aposta

1. **Trava a wallet.** Antes de qualquer verificação, a transação SQL trava a linha da wallet. Duas cópias da mesma aposta, ou duas apostas disputando o mesmo saldo, entram em fila no banco; a segunda só lê depois que a primeira confirmou.
2. **Confere a idempotência.** A `Idempotency-Key` é única por provedor. Se ela já existe com o mesmo conteúdo (comparado por um hash), devolve o resultado original, inclusive o saldo daquele momento. Se existe com outro conteúdo, responde 409.
3. **Aplica as regras** de negócio (saldo suficiente, moeda, dono da wallet, referência válida…). Uma regra violada não é erro: a transação é gravada como `REJECTED`, com um `failureCode`.
4. **Grava tudo numa única transação SQL:** a transação, o novo saldo, o lançamento no ledger e os eventos na outbox. Se o processo morrer antes do commit, nada fica gravado.
5. **Responde** ao provedor.
6. **Publica os eventos depois**, por outro processo, que só enxerga o que já foi confirmado. Nenhum evento sai antes do commit, e nenhum evento confirmado se perde.

**Pela fila SQS** o caminho é o mesmo, com duas diferenças: o registro da mensagem na *inbox* entra no mesmo commit (uma mensagem repetida é reconhecida e não é aplicada de novo), e o *ack* para a fila só acontece depois do commit. Se o processo morrer entre os dois, a mensagem volta e a inbox impede o efeito duplicado; um teste mata um processo real exatamente nesse ponto.

**Operações fora de ordem:** um `REFUND` que chega antes da `BET` fica como `PENDING_REFERENCE` (HTTP 202). Um worker o reavalia com espera crescente (2 s, 4 s, 8 s… por até ~8,5 min) e é acordado na hora quando a `BET` chega.

## As garantias e onde cada uma é provada

| O desafio exige | Como o projeto garante | Prova (testes) |
|---|---|---|
| Dinheiro exato, nunca `number` | `bigint` em centavos no código, `NUMERIC(20,2)` no banco, string `"25.00"` nos contratos; entrada fora do formato é recusada, nunca arredondada | `money.test.ts`, `hostile-input.test.ts` |
| Saldo nunca negativo, mesmo com concorrência | lock da wallet antes de ler o saldo + `CHECK (balance >= 0)` no banco | 100/80/80, hot wallet, 3 instâncias (`wallet-concurrency`, `multi-instance`) |
| Nada de débito ou crédito em dobro | idempotência e inbox com `UNIQUE` no banco; cada referência só pode ser revertida uma vez (índice único parcial) | 50 cópias em paralelo, redelivery, crash entre commit e ack |
| Saldo sempre igual ao ledger | ledger imutável (triggers), encadeado pela versão da wallet; um trigger impede mudar o saldo sem lançamento; endpoint de reconciliação | verificador de invariantes no fim de **toda** suíte |
| Correto com várias instâncias | nenhum estado em memória; `FOR UPDATE` e `FOR UPDATE SKIP LOCKED` no banco | 3 processos reais com SIGKILL sob carga; teste de caos |
| Evento nunca antes do commit, nunca perdido | Transactional Outbox: eventos gravados no mesmo commit e publicados depois | publishers concorrentes, crash antes de marcar como publicado |
| Falhas de infraestrutura tratadas | lock demorado, pool cheio ou banco fora → 503 com `Retry-After` (reenviar é seguro); fila: retry com backoff e DLQ | `infrastructure-failures.test.ts`, `sqs-consumer.test.ts` |

## Operações, estados e respostas

| Operação | Efeito no saldo | Regra principal |
|---|---|---|
| `BET` | débito | rejeitada se faltar saldo (`INSUFFICIENT_FUNDS`) |
| `WIN` | crédito | pode apontar para a `BET` da rodada; não paga prêmio de aposta já devolvida |
| `LOSS` | nenhum | só registra o resultado |
| `REFUND` | crédito | devolve uma `BET`, uma única vez |
| `ROLLBACK` | inverso da referência | desfaz uma `BET`, `WIN` ou `REFUND`, uma única vez |

Cada operação termina num estado, e cada estado tem um status HTTP, para o provedor saber se pode reenviar sem ler a mensagem de erro:

| Situação | HTTP | O provedor deve… |
|---|---|---|
| Processada (`PROCESSED`) | 200 | seguir |
| Aguardando a referência (`PENDING_REFERENCE`) | 202 | consultar depois ou reenviar a mesma chave (recebe o estado atual) |
| Rejeitada por regra de negócio (`REJECTED` + `failureCode`) | 422 | não reenviar; corrigir conforme o código |
| Payload inválido | 400 | corrigir o payload |
| Wallet ou transação inexistente | 404 | conferir os ids |
| Mesma chave com outro conteúdo | 409 | não reenviar; é um bug no provedor |
| Falha temporária (lock, banco, pool) | 503 + `Retry-After` | reenviar com a **mesma** chave (seguro) |

A lista completa de `failureCode` (14 códigos, cada um com o que o provedor deve fazer) está na [tabela de códigos de falha](./ARCHITECTURE.md#códigos-de-falha).

## Usando a API

| Método e rota | O que faz |
|---|---|
| `POST /wallets` | Cria a wallet de um player numa moeda, com saldo inicial (gera o primeiro lançamento no ledger) |
| `GET /wallets/:walletId` | Saldo e versão |
| `GET /wallets/:walletId/ledger?limit=&cursor=` | Extrato, paginado por cursor |
| `POST /wallets/:walletId/reconciliation` | Confere se o saldo bate com a soma do ledger (sinaliza, não corrige) |
| `POST /wagering/transactions` | Processa uma operação (header `Idempotency-Key` obrigatório) |
| `GET /wagering/transactions/:transactionId` | Consulta por id interno |
| `GET /providers/:providerId/wagering/transactions/:externalTransactionId` | Consulta pelo id do provedor |
| `GET /health/live` · `GET /health/ready` · `GET /metrics` | Processo vivo · banco e filas alcançáveis · métricas Prometheus |

### Exemplo por HTTP (bash)
Os ids são gerados na hora, então o exemplo pode ser repetido:
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
# Repetir o mesmo curl (mesma chave, mesmo corpo), em qualquer instância → mesma resposta, com "idempotentReplay":true
```
Valores sempre como string com 2 casas (`"25.00"`): `25`, `25.5` ou `"25.005"` são recusados.

### Exemplo pela fila SQS
A fila `wager-transactions.fifo` recebe o mesmo comando, no envelope `WagerTransactionRequested`:
```json
{ "messageId": "msg-1", "type": "WagerTransactionRequested", "occurredAt": "2026-10-29T12:00:00Z",
  "data": { "providerId": "provider-a", "externalTransactionId": "bet-2", "idempotencyKey": "provider-a:bet-2",
            "playerId": "…", "walletId": "…", "roundId": "round-1", "gameId": "fortune-chimp",
            "kind": "BET", "money": { "amount": "10.00", "currency": "BRL" } } }
```
Use `MessageGroupId = walletId`. O consumidor decide o destino de cada mensagem:

| Resultado | O que acontece com a mensagem |
|---|---|
| Processada ou rejeitada por regra de negócio | confirmada (ack); a transação fica gravada |
| Erro temporário (banco, lock) | volta para a fila com espera crescente |
| Mensagem inválida ou wallet inexistente | vai para a DLQ com o motivo em `failureReason` |
| Mesma mensagem entregue de novo | reconhecida pela inbox e confirmada, sem efeito |

## Testes

Os testes de integração e de concorrência usam **PostgreSQL e MiniStack reais, nunca mocks**: cada suíte cria um banco e filas próprios. Basta ter os dois no ar (`docker compose up -d postgres ministack`).

| Comando | O que prova |
|---|---|
| `bun run test:unit` | regras puras: `Money`, regras de cada operação, ledger, idempotência, formato de log, classificação de erros |
| `bun run test:integration` | API, constraints do schema, atomicidade, consumidor SQS (inbox, retry, DLQ, SIGTERM, crash real entre commit e ack), outbox, operações fora de ordem, falhas de infraestrutura, **oráculo** e **entradas hostis** |
| `bun run test:concurrency` | 100/80/80, a mesma aposta 50 vezes em paralelo, hot wallet, 3 processos reais com SIGKILL e o **teste de caos** |
| `bun test` | tudo (329 testes, ~80 s) |
| `bun run smoke` | ponta a ponta contra a stack do compose |
| `bun run test:load` | teste de carga (resultados em [`LOAD_TEST.md`](./LOAD_TEST.md)) |

Toda suíte termina com um **verificador de invariantes** que procura no banco estados impossíveis: saldo negativo, saldo diferente do ledger, extrato com buraco, transação com lançamento a mais ou a menos, reversão dupla, crédito em dobro, evento faltando na outbox.

### Como sei que os testes pegam bugs
Um teste que sempre passa não prova nada. Por isso:
- **Oráculo independente** (`model-based.test.ts`): as regras foram reescritas do zero, dentro do teste, sem usar o código do sistema. 1 800 operações aleatórias (com seed fixa, reproduzíveis) são enviadas à API real, e cada resposta é comparada com a do oráculo. Um portão de cobertura falha se algum código de falha nunca aparecer.
- **Mutação:** 9 bugs plausíveis foram injetados de propósito no código (regra do WIN, idempotência sem provedor, direção do ROLLBACK, valor da reversão…). O oráculo pegou **todos**.
- **O verificador de invariantes também é testado,** contra um banco adulterado de propósito (`invariant-checker.test.ts`).
- **Fuzz** (`hostile-input.test.ts`): valores de dinheiro malformados, campos faltando ou a mais, chaves `__proto__`, headers, corpos gigantes, rotas e cursores inválidos, 600 corpos aleatórios e mensagens SQS com lixo. Nunca responde 500, nunca muda o saldo. Foi esse teste que achou um bug real (byte nulo no texto respondia 503), já corrigido.
- **Caos** (`chaos.test.ts`): 3 processos recebendo operações aleatórias por HTTP e SQS ao mesmo tempo, com duplicatas, fora de ordem e um SIGKILL no meio. Cada operação teve efeito único e o banco ficou íntegro.

Se você mudou as portas do compose, aponte os testes para elas: `TEST_DATABASE_ADMIN_URL=postgresql://postgres:postgres@localhost:5433/postgres SQS_ENDPOINT=http://localhost:4567 bun test`.

### Desenvolvimento
```bash
bun install
bun run hooks:install   # typecheck + testes de unidade antes de cada commit
docker compose up -d postgres ministack
bun run setup           # migrations + filas
bun run start           # aplicação na porta 3000
```
A cada push, o GitHub Actions roda o typecheck e todos os testes, sobe o `docker compose` do zero e roda o smoke contra os containers.

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

## Estrutura do código
O código é separado em camadas: as regras de negócio não sabem que existe banco, HTTP ou fila.

```
src/
  domain/          regras puras: Money, Wallet, WagerTransaction, ledger, eventos (sem framework nem banco)
  application/     casos de uso e portas (UnitOfWork, Clock…): o mesmo fluxo para HTTP e SQS
  infrastructure/  MikroORM, migrations, SQS, publicador da outbox, worker de pendências, logs e métricas
  interface/       controllers HTTP, validação de entrada (zod), mapeamento de erros para status HTTP
test/
  unit/  integration/  concurrency/  support/
scripts/           setup (migrations + filas), smoke, teste de carga, hook de pre-commit
```

Por onde começar a ler: [`process-wager-transaction.ts`](./src/application/wagering/process-wager-transaction.ts) (o fluxo inteiro) → [`wager-rules.ts`](./src/domain/wagering/wager-rules.ts) (as regras) → [`Migration20261029170000InitialSchema.ts`](./src/infrastructure/persistence/migrations/Migration20261029170000InitialSchema.ts) (as garantias no banco).

## Documentação e limitações
- [`ARCHITECTURE.md`](./ARCHITECTURE.md): as 21 decisões (cada uma com motivo, trade-off e o teste que a prova), a máquina de estados, os códigos de falha, as interpretações adotadas onde o desafio era ambíguo, as limitações conhecidas e a revisão contra as falhas eliminatórias.
- [`LOAD_TEST.md`](./LOAD_TEST.md): metodologia, resultados (~165 req/s sem erros nem divergências, memória estável) e análise.

Principais limitações, explicadas no ARCHITECTURE: não há autenticação (o ponto de extensão está pronto e o desenho com um provedor de identidade está descrito); uma única wallet muito disputada tem vazão limitada pelo lock; inbox e outbox ainda não têm rotina de limpeza.
