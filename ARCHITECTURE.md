# Arquitetura e decisões

> Documento vivo: cada decisão entra aqui no momento em que é tomada, com motivo e trade-off.

## Visão geral

Uma única aplicação NestJS (monólito modular). A mesma imagem roda em três ou mais instâncias. Cada instância cumpre quatro papéis: API HTTP, consumidor SQS, publicador da outbox e worker de transações `PENDING_REFERENCE`.

As instâncias não se coordenam entre si. Todas as garantias de unicidade, imutabilidade e não-negatividade ficam no PostgreSQL. Recursos do broker (FIFO, deduplicação) são otimização, nunca garantia.

## Decisões

### D1 — Runtime e framework: Bun 1.4 + NestJS 12 + TypeScript estrito
- **Contexto:** stack obrigatória do desafio.
- **Decisão:** a aplicação roda direto no Bun, sem etapa de build. O `tsc` (TypeScript 7) só faz a checagem de tipos (`bun run typecheck`), com `strict`, `noUncheckedIndexedAccess` e `noImplicitOverride`.

### D2 — ORM: MikroORM 7
- **Contexto:** o desafio prefere MikroORM (Unit of Work, `EntityManager.transactional()`, `LockMode`).
- **Decisão:** MikroORM 7 com driver PostgreSQL. As entidades de persistência são definidas com `defineEntity`, sem decorators, separadas das classes de domínio, que não conhecem o ORM.

### D3 — Migrations em lista explícita
- **Decisão:** as migrations são classes registradas em ordem em `src/infrastructure/persistence/migrations/index.ts`, cada uma com `up` e `down`, executadas em transação (`allOrNothing`).
- **Motivo:** execução determinística no Bun e no Docker, sem depender de descoberta de arquivos em disco.

### D4 — Emulador de SQS: MiniStack
- **Contexto:** desde março de 2026 a imagem do LocalStack exige conta e auth token para iniciar, o que impediria o avaliador de rodar o projeto sem cadastro.
- **Decisão:** MiniStack com versão fixa da imagem (1.5.34). Não exige conta e suporta filas FIFO, DLQ por `RedrivePolicy` e visibilidade.
- **Trade-off:** um emulador pode divergir da AWS real; os comportamentos usados são cobertos por testes de integração.

### D5 — Topologia local e entrega
- **Decisão:** o `docker compose` sobe PostgreSQL, MiniStack, um serviço `setup` e três instâncias idênticas da aplicação (portas 3001–3003, configuráveis).
- **Responsabilidades:** o `setup` é o **único** que aplica migrations e cria filas. Se três instâncias fizessem isso ao mesmo tempo, poderiam disputar entre si, e uma instância que sobe antes do schema falharia de forma confusa.
- **Imagem:** roda como o usuário `bun` (não root) e tem healthcheck em `/health/live`.
- **Verificação contínua:** o GitHub Actions roda typecheck e todos os testes com PostgreSQL e MiniStack como serviços, e sobe o `docker compose` do zero para conferir as três instâncias. O hook de pre-commit (`bun run hooks:install`) roda typecheck e testes de unidade antes de cada commit.

### D6 — Domínio puro em `src/domain`
- **Decisão:** `Money`, `Wallet`, `WagerTransaction`, `WalletLedgerEntry`, `InboxMessage`, `OutboxMessage` e os eventos são TypeScript puro, sem Nest nem ORM. Construtores privados, factories (`from`, `open`, `create`, `enqueue`, `receive`) e `rehydrate`, que reconstrói o estado sem revalidar transições.
- **Motivo:** as invariantes ficam encapsuladas e testáveis em milissegundos; a infraestrutura só traduz de/para o banco.

### D7 — `Money` com `bigint` em centavos
- **Decisão:** o valor é guardado como `bigint` de centavos; no banco, `NUMERIC(20,2)`; nos contratos, string com exatamente 2 casas.
- **Motivo:** inteiro de precisão arbitrária é exato sem depender de biblioteca decimal. Com escala fixa e sem multiplicação/divisão, nunca há arredondamento: entradas com mais de 2 casas são **rejeitadas**, não arredondadas.
- **Trade-off:** se um dia houver juros, câmbio ou moedas com outra escala, será preciso um tipo decimal com política de arredondamento explícita.

### D8 — Regras de negócio como função pura
- **Decisão:** `decideWager(contexto)` decide o desfecho (`apply`, `record`, `reject`, `pending`) sem efeitos colaterais; `applyWagerDecision` executa a decisão na wallet e na transação.
- **Motivo:** as regras da seção 7 ficam todas num lugar, testadas de forma isolada, e o caso de uso só orquestra persistência, locks e eventos.

### D9 — Versão da wallet encadeia o ledger
- **Decisão:** cada lançamento grava `walletVersion` (a versão da wallet depois dele). A abertura com saldo gera o lançamento da versão 1; cada movimento seguinte, versão + 1.
- **Motivo:** permite uma constraint `UNIQUE(wallet_id, wallet_version)`: dois movimentos calculados a partir do mesmo estado (lost update) são barrados pelo banco.

### D10 — Garantias no schema (não só no código)
- **Contexto:** o desafio exige que unicidade, imutabilidade e não-negatividade sejam aplicadas pelo banco.
- **Decisão:** cada invariante tem uma constraint ou trigger correspondente, coberta por teste de integração em `test/integration/schema.test.ts`:

| Invariante | Onde no schema |
|---|---|
| Uma wallet por player + moeda | `UNIQUE (player_id, currency)` |
| Saldo nunca negativo | `CHECK (balance >= 0)` em `wallets` e nos saldos do ledger |
| Toda mudança de saldo tem lançamento (e vice-versa) | constraint trigger **adiada para o COMMIT** `wallets_assert_ledger`: saldo inicial exige lançamento de abertura; mudança de saldo exige versão + 1 e o lançamento daquela versão com `antes`/`depois` iguais |
| Sem lost update | `UNIQUE (wallet_id, wallet_version)` no ledger |
| Aritmética do lançamento | `CHECK` de `antes ± valor = depois` |
| Moeda do lançamento = moeda da wallet | FK composta `(wallet_id, currency) → wallets (id, currency)` |
| No máximo 1 lançamento por transação por wallet | `UNIQUE (transaction_id, wallet_id)` |
| Ledger imutável | triggers bloqueiam `UPDATE`, `DELETE` e `TRUNCATE` |
| Idempotência persistente, isolada por provedor | `UNIQUE (provider_id, idempotency_key)` e `UNIQUE (provider_id, external_transaction_id)`: a key de um provedor nunca colide com a de outro |
| REFUND/ROLLBACK com referência | `CHECK` por kind |
| Reversão única por referência | índice único parcial em `reference_transaction_id` para reversões `PROCESSED` |
| Estado terminal é definitivo; campos de negócio imutáveis; nada é apagado | trigger `wager_transactions_guard` |
| Rejeição/falha sempre com código | `CHECK` de consistência `status` ↔ `failure_code` |
| Inbox deduplicada | chave primária `(consumer_name, message_id)` |

- **Trade-off:** o trigger adiado custa uma consulta indexada por wallet alterada no commit. Em troca, nenhum caminho de escrita (bug, script manual, outra aplicação) consegue mudar saldo sem deixar rastro no ledger.
- **Consequência para testes:** para simular uma divergência na reconciliação, o teste precisa desligar explicitamente os triggers (`session_replication_role = replica`), o que deixa claro que a adulteração não acontece por acidente.

## Máquina de estados de `WagerTransaction`

```
PENDING ──► PROCESSED | REJECTED | FAILED | PENDING_REFERENCE
PENDING_REFERENCE ──► PROCESSED | REJECTED | FAILED
PROCESSED, REJECTED, FAILED: terminais (qualquer transição lança InvalidTransactionStateError)
```

## Códigos de falha

| Código | Status | Quando | O que o provedor deve fazer |
|---|---|---|---|
| `INSUFFICIENT_FUNDS` | REJECTED | BET maior que o saldo | Não reenviar |
| `REVERSAL_INSUFFICIENT_FUNDS` | REJECTED | ROLLBACK de WIN/REFUND deixaria saldo negativo | Não reenviar; tratar manualmente |
| `CURRENCY_MISMATCH` | REJECTED | Moeda diferente da wallet | Corrigir o payload |
| `PLAYER_WALLET_MISMATCH` | REJECTED | playerId não é o dono da wallet | Corrigir o payload |
| `REFERENCE_NOT_FOUND` | REJECTED | Referência não chegou dentro do limite | Investigar; reenviar com nova chave se a referência existir |
| `REFERENCE_INVALID_KIND` | REJECTED | Tipo de referência não permitido | Corrigir o payload |
| `REFERENCE_NOT_PROCESSED` | REJECTED | Referência terminou REJECTED/FAILED | Não reenviar |
| `REFERENCE_MISMATCH` | REJECTED | Referência de outro player/wallet/moeda/rodada/provider | Corrigir o payload |
| `AMOUNT_MISMATCH` | REJECTED | Valor da reversão ≠ valor da referência | Corrigir o payload |
| `ALREADY_REVERSED` | REJECTED | A referência já foi revertida (inclusive WIN de uma BET revertida) | Não reenviar |
| `BALANCE_LIMIT_EXCEEDED` | REJECTED | O crédito passaria do maior saldo armazenável (18 dígitos inteiros) | Não reenviar; tratar manualmente |
| `PROCESSING_FAILED` | FAILED | Falha permanente de infraestrutura com a transação já gravada (ver D18) | Contatar o operador |

A ordem das verificações define qual código vence quando há mais de um problema: moeda → player → referência (ausente, não processada, escopo, tipo, valor, já revertida) → limite de saldo → saldo.

## Idempotência: `payloadHash`

SHA-256 (hex) do **JSON canônico** dos campos de negócio: `providerId`, `externalTransactionId`, `playerId`, `walletId`, `roundId`, `gameId`, `kind`, `money.amount`, `money.currency` e `referenceExternalTransactionId` (quando houver). JSON canônico = chaves ordenadas em todos os níveis, sem espaços, campos ausentes omitidos. O header `Idempotency-Key` e metadados de transporte (`messageId`, `occurredAt`) não entram.

## Interpretações adotadas

1. **Escala fixa de 2 casas na entrada:** `amount` precisa ter exatamente 2 casas (`"25.00"`). `"25"` e `"25.5"` são payload inválido; `"25.005"` é rejeitado, nunca arredondado.
2. **Uma reversão por referência, de qualquer tipo:** a regra 4 do README fala em "mesmo tipo", mas REFUND seguido de ROLLBACK da mesma BET creditaria duas vezes. Para proteger a invariante de não duplicar créditos, uma referência só pode ser revertida uma vez. Um ROLLBACK de um REFUND é permitido, porque a referência é outra transação.
3. **WIN com referência opcional:** se vier, é validada como nas reversões (BET, mesmo escopo, existente) e **não pode apontar para uma BET já revertida** (pagaria prêmio de uma aposta desfeita). Se não vier, o WIN é processado normalmente.
4. **Referência ainda pendente:** se a referência existe mas está `PENDING_REFERENCE`, a transação dependente também fica pendente, em vez de ser rejeitada.
5. **LOSS e BET não aceitam referência:** recebê-la é payload inválido.
6. **Valor sempre maior que zero, inclusive em LOSS:** uma operação de valor 0.00 é payload inválido. O LOSS carrega o valor apostado que foi perdido; uma rodada sem aposta não gera operação.
7. **Limite de saldo:** um crédito que passaria de 999999999999999999.99 é rejeitado com `BALANCE_LIMIT_EXCEEDED`, em vez de estourar a coluna do banco.

## Limitações conhecidas

_A preencher._
