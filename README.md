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
