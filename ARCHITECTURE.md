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

### D11 — Concorrência: lock pessimista por wallet
- **Decisão:** o caso de uso abre uma transação SQL e lê a wallet com `SELECT … FOR UPDATE` **antes** de qualquer outra verificação (inclusive a de idempotência). Operações da mesma wallet esperam em fila no banco; wallets diferentes seguem em paralelo. Não há lock global.
- **Por que não otimista:** numa "hot wallet" (50 cópias da mesma aposta, ou muitas apostas do mesmo jogador), o otimista gera uma tempestade de conflitos e retries. O pessimista resolve na fila do próprio banco, com custo previsível.
- **Por que o lock vem antes da idempotência:** duas cópias da mesma operação nunca são avaliadas ao mesmo tempo. A segunda só lê depois do commit da primeira e vira replay.
- **Redes de segurança no schema:** `CHECK (balance >= 0)`, `UNIQUE (wallet_id, wallet_version)`, o trigger saldo↔ledger e os UNIQUE de idempotência (D10). Mesmo um bug no código não produz saldo negativo nem débito duplicado.
- **Corrida entre wallets diferentes:** duas requisições com a mesma `(providerId, Idempotency-Key)` mas `walletId` diferentes não disputam o mesmo lock. A segunda esbarra no UNIQUE no COMMIT; o caso de uso desfaz tudo, relê e responde replay ou 409.
- **Trade-off:** a vazão de uma única wallet é limitada pela duração da transação (alguns ms). Para escalar uma hot wallet além disso, seria preciso particionar o saldo (sub-wallets) ou agrupar operações; está fora do escopo.
- **Evidência:** `test/concurrency/wallet-concurrency.test.ts` (100/80/80, 50 cópias em paralelo, 100 apostas na mesma wallet, wallets em paralelo, reversões concorrentes).

### D12 — Unit of Work com MikroORM e FKs adiadas
- **Decisão:** cada operação usa um `EntityManager` próprio (`fork`) dentro de `em.transactional()`. Wallet, transação, lançamento e eventos da outbox são persistidos e confirmados num único flush/commit. Os casos de uso dependem de portas (`UnitOfWork`, `TransactionalStore`), não do ORM, e por isso são testáveis sem banco.
- **FKs `DEFERRABLE INITIALLY DEFERRED`:** a ordem dos INSERTs do flush não importa; a integridade é verificada no COMMIT, junto com o trigger saldo↔ledger.
- **Leituras** (consultas, ledger paginado, reconciliação) usam SQL direto (`ReadModel`): não alteram nada, não precisam do Identity Map e deixam a consulta (e o índice que ela usa) explícita.

### D13 — Mapeamento HTTP
| Situação | Status | Corpo |
|---|---|---|
| Processada (inclusive LOSS) | 200 | `{ transactionId, status, balance, idempotentReplay }` |
| Aceita, aguardando referência | 202 | idem, `status: PENDING_REFERENCE` |
| Rejeição de negócio | 422 | idem + `failureCode` (a transação fica gravada, auditável) |
| Falha permanente do nosso lado (`FAILED`) | 500 | idem + `failureCode: PROCESSING_FAILED`; reenviar devolve o mesmo resultado |
| Payload inválido / header ausente / `providerId` reservado | 400 | `{ error: { code: "INVALID_PAYLOAD", details } }` |
| Wallet/transação inexistente | 404 | `WALLET_NOT_FOUND` / `TRANSACTION_NOT_FOUND` |
| Conflito de idempotência / wallet duplicada | 409 | `IDEMPOTENCY_CONFLICT` (com `details.reason`) / `WALLET_ALREADY_EXISTS` |
| Falha transitória (lock, pool, banco fora) | 503 + `Retry-After` | `TRANSIENT_FAILURE` — reenviar com a mesma key é seguro |
| Erro inesperado (bug) | 500 | `INTERNAL_ERROR`, logado com stack |

- **Replay:** responde com o **estado atual** da transação registrada, com `idempotentReplay: true`. Para uma transação terminal (PROCESSED, REJECTED, FAILED) o status e o corpo são os da primeira resposta, inclusive o saldo observado naquele momento. Uma `PENDING_REFERENCE` que já foi resolvida volta com o novo estado (202 → 200 ou 422): o provedor que reenvia quer saber o que aconteceu, e responder "pendente" para sempre seria mentir.
- **O 409 não expõe ids internos.** `details.reason` diz o motivo (`PAYLOAD_MISMATCH`: mesma chave, payload diferente; `EXTERNAL_ID_REUSED`: mesmo `externalTransactionId` com outra chave). O provedor já sabe qual chave e qual id enviou.
- **`DomainError` que escapa até o filtro é bug**, não payload inválido: os casos de uso já convertem entrada inválida em `ValidationError`. Por isso vira 500 e log de erro, em vez de se esconder atrás de um 400.
- **400, 404 e 409** são logados (só código e campos com problema, nunca os valores enviados) e contados em `http_requests_rejected_total{code}`.
- Todo erro usa o mesmo envelope `{ error: { code, message, details?, correlationId } }`.

### D14 — Reconciliação
- Lê a wallet com `FOR SHARE` (nenhum movimento entra no meio da contagem) e soma o ledger em `NUMERIC` no próprio PostgreSQL.
- Divergência → log `error`, métrica `wallet_reconciliation_divergences_total` e `consistent: false` na resposta. Nada é corrigido automaticamente: a correção de saldo é uma decisão humana e auditável.

### D15 — Autenticação: não implementada (ponto de extensão explícito)
- O desafio não pontua autenticação. Existe um `ProviderAuthGuard` no-op aplicado às rotas de wallet e wagering; health checks ficam abertos.
- **Desenho previsto:** cada provedor é um client OIDC num IdP externo. Ele obtém token por *client credentials*; o guard valida o JWT pelo JWKS do IdP e confere se o claim do provedor é igual ao `providerId` do corpo (senão 403). Mensagens da fila são canal interno confiável, mas o `providerId` continua sujeito às validações de domínio.

### D16 — Falhas de infraestrutura viram 503, nunca efeito parcial
- **Lock demorado:** `lock_timeout` por transação (`LOCK_TIMEOUT_MS`, padrão 5 s). Estourou → 503 e a métrica `wager_lock_conflicts_total{kind="lock_timeout"}`.
- **Pool sem conexão livre:** `connectionTimeoutMillis` do pool (`DB_CONNECT_TIMEOUT_MS`, padrão 5 s). Sem ele, sob saturação a requisição esperaria indefinidamente. O erro do pool é classificado como transitório.
- **Banco fora do ar:** POST e GET → 503; `/health/ready` → 503 com `postgres: "down"`; `/health/live` continua 200 (o processo está bem, não deve ser reiniciado). Quando o banco volta, a aplicação se recupera sozinha.
- **Classificação** (`db-errors.ts`): unicidade concorrente → releitura (replay/409); lock timeout, deadlock, serialização, conexão e pool → transitório; o resto sobe como erro inesperado (500), porque pode ser bug ou violação de invariante e deve aparecer.
- **Dependência corrigida — `kysely` fixado em 0.29.7 (`overrides` no `package.json`).** O MikroORM 7.2.5 exige o kysely 0.29.6, que tem um vazamento: se o `BEGIN` falha (conexão morta reaproveitada do pool depois de uma queda do banco), a conexão nunca é devolvida. O teste de queda reproduz: com a 0.29.6, 6 de 7 conexões ficam presas depois de uma única queda e a aplicação trava ao desligar; com a 0.29.7, que corrige exatamente esse caminho, nenhuma. Em produção, oscilações repetidas esgotariam o pool. Quando o MikroORM passar a depender da versão corrigida, o `overrides` pode sair.
- **Evidência:** `test/integration/infrastructure-failures.test.ts` (lock timeout, pool esgotado, banco fora e vazamento de conexão, este com um proxy TCP que derruba o banco sem avisar a aplicação).

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
8. **`playerId` e `walletId` são UUID:** os ids são gerados por este serviço (wallet) ou pelo cadastro de jogadores, então o formato é validado na entrada. Ids do provedor (`providerId`, `externalTransactionId`, `roundId`, `gameId`) são texto livre de até 128 caracteres.
9. **`providerId = "internal"` é reservado** às transações criadas pelo próprio sistema (abertura de wallet). Uma entrada externa com esse provedor é payload inválido, para que nenhuma chave de provedor colida com uma chave interna.
10. **`Idempotency-Key` é única por provedor**, não global: provedores não se coordenam entre si, e a chave de um nunca deve achar (nem revelar) a transação de outro.

## Limitações conhecidas

_A preencher._
