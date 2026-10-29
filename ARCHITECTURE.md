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

## Interpretações adotadas

_A preencher conforme as fases avançam._

## Limitações conhecidas

_A preencher._
