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
- **O 409 de idempotência não expõe ids internos.** `details.reason` diz o motivo (`PAYLOAD_MISMATCH`: mesma chave, payload diferente; `EXTERNAL_ID_REUSED`: mesmo `externalTransactionId` com outra chave). O provedor já sabe qual chave e qual id enviou. Já o 409 `WALLET_ALREADY_EXISTS` devolve o `walletId`: a criação de wallet não tem Idempotency-Key, e quem reenvia depois de um timeout precisa descobrir a wallet do próprio player.
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

### D17 — Consumidor SQS
- **Mesmo caso de uso:** o consumidor chama `ProcessWagerTransaction.executeIn` dentro de uma transação que, antes, grava a inbox (`InboxMessage` do domínio) com `INSERT … ON CONFLICT DO NOTHING`. O registro da inbox e o efeito financeiro entram juntos no COMMIT, ou nenhum entra. A inbox é gravada por SQL direto porque o ORM não expressa "insira se não existir" num único comando sem abortar a transação.
- **Ack só depois do commit:** `DeleteMessage` acontece após a transação confirmar. Se o processo morrer entre os dois, a mensagem volta depois do visibility timeout e a inbox reconhece a redelivery: confirma sem reaplicar.
- **Duas camadas de deduplicação:** a inbox deduplica pelo `messageId` (a mesma mensagem entregue de novo). A idempotência do caso de uso deduplica pela `(providerId, idempotencyKey)` (a mesma operação em mensagens diferentes, ou também enviada por HTTP).
- **Classificação de erros:**

| Tipo | Exemplos | Ação |
|---|---|---|
| Negócio | saldo insuficiente, referência inválida | transação `REJECTED` gravada → **ack** |
| Transitório | banco indisponível, lock timeout, pool esgotado, unicidade concorrente | **sem ack**; `ChangeMessageVisibility` com backoff `base · 2^(tentativa−1)` |
| Permanente | JSON inválido, schema inválido, `OPENING`, `providerId` reservado, wallet inexistente, conflito de idempotência | cópia para a **DLQ** com `failureReason`, depois ack |
| Inesperado | bug | tratado como transitório; o **redrive** (`maxReceiveCount`, padrão 5) leva à DLQ se persistir |

- **Limite de tentativas garantido pelo broker:** mesmo que o processo caia em todas as tentativas, a `RedrivePolicy` move a mensagem para a DLQ após `maxReceiveCount` recebimentos.
- **Ordem por wallet:** `MessageGroupId = walletId`. O lote é processado em sequência; se uma mensagem volta para a fila (retry), **as seguintes do mesmo grupo no lote são devolvidas sem processar**. O SQS só as entrega de novo depois da que falhou, e a ordem da wallet é preservada. Mensagens que vão para a DLQ não bloqueiam o grupo: são removidas da fila principal. A correção financeira não depende dessa ordem (vem do lock e das constraints), mas ela evita, por exemplo, que um WIN passe na frente da BET e vire `PENDING_REFERENCE` sem necessidade.
- **DLQ observável:** a métrica `wager_dlq_depth` lê a profundidade real da DLQ (`ApproximateNumberOfMessages`) a cada `CONSUMER_DLQ_POLL_INTERVAL_MS`. Ela inclui o que o redrive do SQS moveu, que o código nunca vê. É ela que um alerta deve observar; `wager_dlq_messages_total{reason}` conta só os envios feitos pelo consumidor.
- **SIGTERM:** o consumidor para de buscar, termina a mensagem em andamento e devolve com visibilidade 0 as recebidas e não iniciadas. O long polling em curso **não é abortado**: um `ReceiveMessage` cancelado no cliente ainda pode ter recebido mensagens no servidor, que ficariam invisíveis e gastariam uma tentativa (observado nos testes do protótipo). O `CONSUMER_SHUTDOWN_TIMEOUT_MS` limita a espera de verdade: se estourar, o processo segue o encerramento e a mensagem sem ack volta depois, sem duplicar efeito.
- **`messageId` repetido com conteúdo diferente:** mantém o primeiro processamento e registra um warning (o hash do envelope fica na inbox).
- **Readiness:** `/health/ready` confere o PostgreSQL e as três filas (entrada, DLQ, eventos). A aplicação só **localiza** as filas no boot (D5); se faltar alguma, o boot falha com erro claro.
- **Evidência:** `test/integration/sqs-consumer.test.ts` (processamento, redelivery, replay por idempotency key, rejeição de negócio, DLQ direta, retry transitório, DLQ por redrive e a métrica, ordem FIFO após retry, SIGTERM, timeout do stop, ciclo de vida) e `test/integration/consumer-crash.test.ts`: um processo real (`bun src/main.ts`) se mata com SIGKILL entre o COMMIT e o ack (`FAULT_CRASH_AFTER_COMMIT`, injeção de falha só para teste), outra instância recebe a redelivery, e o débito acontece uma única vez.

### D18 — Transactional Outbox
- **Gravação:** os eventos são inseridos em `outbox_messages` na **mesma transação SQL** do efeito financeiro. Nenhum evento é publicado antes do commit, porque quem publica é outro processo, que só enxerga linhas confirmadas.
- **Publicação:** o `OutboxRelay` roda em todas as instâncias. Cada rodada trava um lote com `FOR UPDATE SKIP LOCKED`, publica em `wallet-events.fifo` (`SendMessageBatch`) e marca `published_at` no mesmo COMMIT. Com SKIP LOCKED, publishers concorrentes pegam lotes disjuntos; isso é verificado em teste.
- **Crash depois de publicar e antes do commit:** o lock some com a conexão, a linha continua pendente e outra instância publica de novo. A entrega é **at-least-once**: `MessageDeduplicationId = eventId` descarta a cópia em até 5 min no FIFO, e fora dessa janela o consumidor deduplica pelo `eventId` do envelope.
- **Falha no SQS:** `OutboxMessage.scheduleRetry` (backoff exponencial de 1 s a 5 min), `attempts` e `last_error` gravados. O evento nunca é descartado.
- **Ordem dos eventos:** não há ordem global garantida, porque vários publishers rodam em paralelo e um lote que falhou volta depois. Os eventos de saldo (`WalletBalanceChanged`) usam `MessageGroupId = walletId` e carregam `walletVersion`, que cresce de 1 em 1 por wallet. **O consumidor deve ordenar e deduplicar por `walletVersion`** (ignorar versões já vistas, esperar as que faltam), em vez de confiar na ordem de chegada. Os eventos de transação usam o `transactionId` como grupo.
- **SQL direto no relay:** a seleção precisa de `ORDER BY … LIMIT … FOR UPDATE SKIP LOCKED` numa tabela técnica, sem regra de domínio para hidratar; o estado de cada evento continua decidido pelo `OutboxMessage`.
- **Índice na ordem da leitura:** `(occurred_at, id) where published_at is null` (migration `Migration20261030010000OutboxRelayOrder`), e um único `UPDATE` marca o lote publicado. O índice anterior obrigava a ordenar todos os pendentes a cada lote; achado e medido no teste de carga (`LOAD_TEST.md`).
- **Métrica `outbox_lag_seconds`:** idade do evento pendente mais antigo, atualizada a cada rodada.
- **Trade-off:** a transação do relay fica aberta durante a chamada ao SQS (lotes pequenos, 10 por padrão). Uma alternativa sem transação longa seria um *lease* (`locked_until`), com mais complexidade e o mesmo resultado at-least-once.
- **Evidência:** `test/integration/outbox-and-pending.test.ts` (envelope, publishers concorrentes sem sobreposição, crash entre publicar e marcar, SQS indisponível com backoff, ciclo de vida na aplicação).

### D19 — Referências fora de ordem
- Uma transação cuja referência ainda não existe é gravada como `PENDING_REFERENCE` (HTTP 202, evento `WagerTransactionPendingReference`), com a primeira reavaliação em `PENDING_REFERENCE_BASE_DELAY_MS` (2 s).
- O `PendingReferenceWorker` reavalia uma pendência por transação: `FOR UPDATE SKIP LOCKED` na linha da pendência (dois workers nunca pegam a mesma) e depois o **mesmo lock de wallet e as mesmas regras** do fluxo normal (`retryPending`).
- **Backoff e janela:** a 1ª reavaliação ocorre 2 s após a chegada e cada uma das seguintes dobra o intervalo. Com 8 tentativas, a janela total é **2 + 4 + … + 256 s = 510 s (~8,5 min)**. Escolhi assim porque provedores costumam reenviar a operação original em segundos ou minutos; depois disso, a ausência indica erro do provedor, não atraso. Os valores são configuráveis (`PENDING_REFERENCE_MAX_ATTEMPTS`, `PENDING_REFERENCE_BASE_DELAY_MS`).
- **Janela esgotada:** referência ausente → `REJECTED` / `REFERENCE_NOT_FOUND`; referência presente mas ainda pendente → `REJECTED` / `REFERENCE_STILL_PENDING`. São problemas diferentes: no primeiro falta a operação original; no segundo ela chegou, mas também ficou presa. Ambos geram `WagerTransactionRejected`.
- **Acordar as dependentes:** depois do COMMIT de uma transação que chegou a um **estado final** (`PROCESSED`, `REJECTED` ou `FAILED`; via HTTP, fila ou o próprio worker), o caso de uso antecipa para "agora" o `next_attempt_at` das pendências que esperavam por ela. Incluir os finais negativos evita que uma dependente de uma referência rejeitada espere a janela inteira para receber `REFERENCE_NOT_PROCESSED`. Roda numa transação separada e **sem o lock da wallet** (`UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED)`): dentro da transação original causaria deadlock com o worker, que trava a pendência antes da wallet. É só otimização: se falhar, o horário agendado continua valendo. A migration `Migration20261029190000PendingReferenceWorker` cria o índice parcial dessa busca.
- **`FAILED`:** se a reavaliação falhar por erro de infraestrutura (a transação do worker é desfeita), a falha é contada numa transação nova, em `processing_failures`, **separado** de `attempts` (tentativas de achar a referência). Uma reavaliação que termina zera a sequência. Depois de `PENDING_REFERENCE_MAX_PROCESSING_FAILURES` (5) falhas seguidas, a pendência vira **`FAILED` / `PROCESSING_FAILED`**, terminal e auditável, com o evento extra `WagerTransactionFailed`, em vez de tentar para sempre. Por HTTP, um replay dela responde 500 (D13).
- **Ordem de locks sem deadlock:** o worker trava a pendência e depois a wallet. O fluxo HTTP/SQS trava a wallet e só **lê** pendências, sem travá-las. Não há ciclo.
- **Evidência:** `test/integration/outbox-and-pending.test.ts` (ROLLBACK antes da BET e o replay 202 → 200, referência que nunca chega, referência ainda pendente, dois workers em paralelo, acordar ao PROCESSED e ao REJECTED, FAILED com contadores separados).

### D20 — Múltiplas instâncias e reinício
- **Nenhuma coordenação entre instâncias:** não há líder, lock distribuído nem estado em memória compartilhado. Cada instância roda HTTP, consumidor, publicador da outbox e worker de pendentes. Quem decide é o PostgreSQL: o lock da wallet serializa operações da mesma wallet; `SKIP LOCKED` divide outbox e pendências entre os workers; os UNIQUE impedem efeito duplicado.
- **Teste com processos reais:** `test/concurrency/multi-instance.test.ts` sobe **3 processos** `bun src/main.ts` independentes, com o mesmo PostgreSQL e as mesmas filas. Ele verifica:
  - uma hot wallet disputada pelas 3 instâncias, com cada aposta enviada em duplicata para instâncias diferentes;
  - mensagens SQS duplicadas consumidas pelas 3;
  - **SIGKILL** de uma instância no meio da carga HTTP: depois do reinício e do reenvio completo pelo provedor, só há replays, o saldo e o ledger fecham e a outbox drena;
  - **SIGKILL** de uma instância consumindo a fila: as mensagens dela voltam após o visibility timeout, as outras assumem, e cada uma tem efeito único;
  - fora de ordem entre instâncias: ROLLBACK numa, BET noutra, e o worker de qualquer uma resolve;
  - **SIGTERM** encerra com código 0 enquanto as outras seguem atendendo.
- **Testes por condição, não por tempo:** os momentos de falha ("mata no meio da carga") são disparados quando o banco mostra que a carga começou, e as verificações esperam o estado final com prazo, em vez de dormir um tempo fixo. Isso tira a instabilidade de máquinas lentas (como o CI).
- **Encerramento:** o `main.ts` trata SIGTERM/SIGINT chamando `app.close()`, que dispara os hooks de shutdown na ordem certa (os processos de fundo param antes do ORM fechar), e sai com 0. Há um limite rígido de 25 s para não travar um deploy.
- **Relógio:** as datas de agendamento vêm do Clock da aplicação (milissegundos). Comparações com `now()` do PostgreSQL (microssegundos) são evitadas no código; nos testes, "vencido" é marcado no passado para não depender do mesmo milissegundo.

### D21 — Observabilidade
- **Logs:** uma linha JSON por evento em stdout (`time`, `level`, `msg`, `service`). A aplicação, o NestJS (`component: "nest"`) e o MikroORM (`component: "mikro-orm"`) escrevem no mesmo formato; um erro de boot também sai em JSON, com stack. `LOG_LEVEL` = `info` (padrão), `warn`, `error` ou `silent`.
- **Campos de correlação**, quando existem: `correlationId` (header `X-Correlation-Id` ou gerado; nas mensagens, o do envelope), `messageId`, `transactionId`, `walletId`, `providerId`. O `correlationId` também volta no corpo de todo erro HTTP e segue nos eventos publicados (`causationId` aponta para a mensagem ou requisição de origem).
- **O que nunca vai para o log:** payload completo e valores enviados em requisições inválidas (só o código e os campos com problema, D13).

| Métrica (`GET /metrics`, Prometheus) | O que mostra |
|---|---|
| `wager_transactions_total{status,source}` | transações por status final e origem (http, sqs, worker) |
| `wager_duplicates_detected_total{kind}` | duplicatas: replay de idempotência e redelivery na inbox |
| `wager_retries_total{kind}` | novas tentativas: SQS, outbox, pendências |
| `wager_dlq_messages_total{reason}` / `wager_dlq_depth` | envios para a DLQ pelo consumidor / profundidade real da DLQ (inclui o redrive) |
| `wager_lock_conflicts_total{kind}` | lock timeout e unicidade concorrente |
| `outbox_lag_seconds` | idade do evento ainda não publicado mais antigo |
| `wager_processing_seconds{source}` | latência do processamento (histograma) |
| `http_requests_rejected_total{code}` | requisições recusadas (400, 404, 409) |
| `wallet_reconciliation_divergences_total` | reconciliações com divergência |

- **Health:** `/health/live` (processo vivo, não toca dependências) e `/health/ready` (PostgreSQL e as três filas).
- **Alertas sugeridos:** `wager_dlq_depth > 0`; `outbox_lag_seconds` crescendo; taxa de `wager_lock_conflicts_total{kind="lock_timeout"}`; `wallet_reconciliation_divergences_total` aumentando (sempre investigar).
- **Evidência:** `test/unit/json-logger.test.ts` (formato, níveis, Nest e MikroORM) e o teste "contrato de observabilidade" em `test/integration/api.test.ts` (todas as métricas presentes).

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
| `REFERENCE_NOT_FOUND` | REJECTED | Referência não chegou dentro da janela de espera (~8,5 min) | Investigar; reenviar com nova chave se a referência existir |
| `REFERENCE_STILL_PENDING` | REJECTED | A referência chegou, mas ela mesma ficou pendente até o fim da janela | Resolver primeiro a referência; depois reenviar com nova chave |
| `REFERENCE_INVALID_KIND` | REJECTED | Tipo de referência não permitido | Corrigir o payload |
| `REFERENCE_NOT_PROCESSED` | REJECTED | Referência terminou REJECTED/FAILED | Não reenviar |
| `REFERENCE_MISMATCH` | REJECTED | Referência de outro player/wallet/moeda/rodada/provider | Corrigir o payload |
| `AMOUNT_MISMATCH` | REJECTED | Valor da reversão ≠ valor da referência | Corrigir o payload |
| `ALREADY_REVERSED` | REJECTED | A referência já foi revertida (inclusive WIN de uma BET revertida) | Não reenviar |
| `REFERENCE_ALREADY_SETTLED` | REJECTED | REFUND/ROLLBACK de uma BET que já teve um WIN pago e não revertido | Reverter o WIN primeiro; depois a BET |
| `BALANCE_LIMIT_EXCEEDED` | REJECTED | O crédito passaria do maior saldo armazenável (18 dígitos inteiros) | Não reenviar; tratar manualmente |
| `PROCESSING_FAILED` | FAILED | Falha permanente de infraestrutura com a transação já gravada (ver D19) | Contatar o operador |

A ordem das verificações define qual código vence quando há mais de um problema: moeda → player → referência (ausente, não processada, escopo, tipo, valor, já revertida, já liquidada por WIN) → limite de saldo → saldo.

## Idempotência: `payloadHash`

SHA-256 (hex) do **JSON canônico** dos campos de negócio: `providerId`, `externalTransactionId`, `playerId`, `walletId`, `roundId`, `gameId`, `kind`, `money.amount`, `money.currency` e `referenceExternalTransactionId` (quando houver). JSON canônico = chaves ordenadas em todos os níveis, sem espaços, campos ausentes omitidos. O header `Idempotency-Key` e metadados de transporte (`messageId`, `occurredAt`) não entram.

## Interpretações adotadas

1. **Escala fixa de 2 casas na entrada:** `amount` precisa ter exatamente 2 casas (`"25.00"`). `"25"` e `"25.5"` são payload inválido; `"25.005"` é rejeitado, nunca arredondado.
2. **Uma reversão por referência, de qualquer tipo:** a regra 4 do README fala em "mesmo tipo", mas REFUND seguido de ROLLBACK da mesma BET creditaria duas vezes. Para proteger a invariante de não duplicar créditos, uma referência só pode ser revertida uma vez. Um ROLLBACK de um REFUND é permitido, porque a referência é outra transação.
3. **WIN com referência opcional:** se vier, é validada como nas reversões (BET, mesmo escopo, existente) e **não pode apontar para uma BET já revertida** (pagaria prêmio de uma aposta desfeita). Se não vier, o WIN é processado normalmente.
4. **BET com WIN pago não pode ser revertida direto** (a regra inversa da 3): um REFUND ou ROLLBACK de uma BET que tem um WIN `PROCESSED` apontando para ela, e não revertido, é rejeitado com `REFERENCE_ALREADY_SETTLED`. Devolver a aposta e manter o prêmio creditaria duas vezes pela mesma rodada. O provedor reverte o WIN primeiro (ROLLBACK do WIN) e então a BET. Só vale quando o WIN informa a referência (ver limitações).
5. **Referência ainda pendente:** se a referência existe mas está `PENDING_REFERENCE`, a transação dependente também fica pendente, em vez de ser rejeitada.
6. **LOSS e BET não aceitam referência:** recebê-la é payload inválido.
7. **Valor sempre maior que zero, inclusive em LOSS:** uma operação de valor 0.00 é payload inválido. O LOSS carrega o valor apostado que foi perdido; uma rodada sem aposta não gera operação.
8. **Limite de saldo:** um crédito que passaria de 999999999999999999.99 é rejeitado com `BALANCE_LIMIT_EXCEEDED`, em vez de estourar a coluna do banco.
9. **`playerId` e `walletId` são UUID:** os ids são gerados por este serviço (wallet) ou pelo cadastro de jogadores, então o formato é validado na entrada. Ids do provedor (`providerId`, `externalTransactionId`, `roundId`, `gameId`) são texto livre de até 128 caracteres.
10. **`providerId = "internal"` é reservado** às transações criadas pelo próprio sistema (abertura de wallet). Uma entrada externa com esse provedor é payload inválido, para que nenhuma chave de provedor colida com uma chave interna.
11. **`Idempotency-Key` é única por provedor**, não global: provedores não se coordenam entre si, e a chave de um nunca deve achar (nem revelar) a transação de outro.

## Limitações conhecidas

1. **Vazão de uma única wallet:** o lock pessimista serializa as operações da mesma wallet. Quem espera o lock ocupa uma conexão do pool, então uma hot wallet muito disputada aumenta a cauda de latência das demais (medido em `LOAD_TEST.md`). Mitigações possíveis: limitar requisições em espera por wallet, pool dedicado ou sub-wallets.
2. **Consumidor processa uma mensagem por vez por instância:** é o que preserva a ordem por wallet dentro do lote (D17). A vazão da fila escala com o número de instâncias, não com paralelismo dentro de uma. O próximo passo seria processar grupos (wallets) diferentes em paralelo, mantendo a sequência dentro de cada grupo.
3. **Inbox e outbox crescem para sempre:** não há rotina de retenção. Em produção, um job apagaria inbox mais antiga que a janela de redelivery do broker (dias) e outbox já publicada (horas), ou particionaria as tabelas por data. As transações e o ledger nunca são apagados (são o registro auditável).
4. **`FAILED` só no worker de pendências:** é o único ponto em que uma transação já gravada pode falhar repetidamente por infraestrutura (D19). Nas entradas HTTP e SQS, uma falha desfaz tudo antes de a transação existir: o HTTP responde 503 e a mensagem SQS volta para a fila e, se persistir, vai para a DLQ.
5. **Publicação at-least-once e sem ordem global:** um evento pode ser publicado mais de uma vez (crash entre publicar e marcar) e lotes podem sair fora de ordem. O consumidor deve deduplicar pelo `eventId` e ordenar por `walletVersion` (D18). Os consumidores de `wallet-events.fifo` estão fora do escopo.
6. **Transação aberta durante a publicação da outbox:** o relay mantém o lock do lote enquanto chama o SQS. Os lotes são pequenos, mas um SQS lento segura conexões. Um *lease* resolveria sem transação longa.
7. **Emulador de SQS:** os testes rodam no MiniStack, não na AWS. Os comportamentos usados (FIFO, visibilidade, `ApproximateReceiveCount`, redrive) foram verificados nele, mas podem divergir em detalhes.
8. **Escala fixa de 2 casas:** o modelo e o schema são multi-moeda (wallet única por player + moeda, conflito testado), mas a escala é 2 para todas as moedas, como o desafio define.
9. **Sem autenticação:** ver D15.
10. **Reversão parcial fora de escopo:** REFUND e ROLLBACK exigem o mesmo valor da referência.
11. **Ledger de partida simples:** cada movimento gera um lançamento na wallet. Partidas dobradas (contrapartida em contas da casa) seriam o próximo passo.
12. **Dependência com versão forçada:** `kysely` está fixado em 0.29.7 por `overrides` para corrigir um vazamento de conexão (D16). Ao atualizar o MikroORM, rever se o `overrides` ainda é necessário.
13. **Prêmio sem referência não liga o WIN à BET:** a regra de "BET já liquidada" (interpretação 4) só enxerga WINs que informam `referenceExternalTransactionId`. Um WIN sem referência não impede a devolução da BET da mesma rodada. Exigir a referência em todo WIN fecharia isso, mas mudaria o contrato do README, em que ela é opcional.

## Revisão contra as falhas eliminatórias

| Falha eliminatória (README, seção 14) | Como está coberta | Evidência |
|---|---|---|
| `number` para dinheiro | `Money` usa `bigint` em centavos; o banco usa `NUMERIC(20,2)` e os contratos usam string com 2 casas. Entrada `number` é rejeitada | `money.test.ts`, `api.test.ts` |
| Saldo negativo causado por race | lock por wallet antes de qualquer leitura + `CHECK (balance >= 0)` | `wallet-concurrency.test.ts` (100/80/80, hot wallet), `multi-instance.test.ts` |
| Débito ou crédito duplicado | idempotência persistente (UNIQUE por provedor), inbox, reversão única (índice parcial), trigger saldo↔ledger | 50 cópias em paralelo, redelivery, crash entre commit e ack com processo real |
| Idempotência apenas em memória | toda deduplicação está no PostgreSQL (`wager_transactions`, `inbox_messages`); nenhum `Map`/`Set` deduplica operações | `schema.test.ts`, `sqs-consumer.test.ts` |
| Correta só com uma instância | nenhum estado em memória; locks e `SKIP LOCKED` no banco | 3 processos reais com SIGKILL sob carga HTTP e SQS |
| Evento publicado antes do commit | eventos só saem pela outbox, lida por outro processo depois do commit | `outbox-and-pending.test.ts`, `atomicity.test.ts` |
| Ausência de ledger auditável | ledger imutável (triggers), encadeado por versão, com reconciliação | `schema.test.ts`, invariante saldo == ledger ao fim de cada suíte |
| Testes que trocam PostgreSQL e SQS por mocks | todos os testes de integração e concorrência usam PostgreSQL e MiniStack reais; falhas são injetadas por cima da infraestrutura real | `test/integration`, `test/concurrency` |
