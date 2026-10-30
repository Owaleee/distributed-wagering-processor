# Teste de carga

```bash
docker compose up --build -d      # 3 instâncias em localhost:3001–3003
bun run test:load                 # padrão: 64 clientes, 30 s, 100 wallets, 10% hot wallet
```

Variáveis: `LOAD_TARGETS`, `LOAD_CONCURRENCY`, `LOAD_DURATION_S`, `LOAD_WALLETS`, `LOAD_HOT_RATIO`. O script sai com código 1 se **qualquer** wallet terminar com saldo divergente do ledger.

## Metodologia

- **Carga em laço fechado:** 64 clientes enviam requisições sem pausa durante 30 s, em rodízio entre as 3 instâncias.
- **Mistura:**
  - 10% são **replays** de requisições já enviadas (mesma `Idempotency-Key` e mesmo payload);
  - 10% são BETs na mesma **hot wallet** (disputa de lock);
  - o resto se divide entre BET (1.25), WIN (2.50) e LOSS (1.25) em 100 wallets com saldo alto.
- **Medições:** latência ponta a ponta do cliente, códigos de status, erros de rede (com a mensagem), `outbox_lag_seconds` amostrado a cada segundo em `/metrics` e `wager_lock_conflicts_total`.
- **Verificação final:** o script espera a outbox drenar e roda a **reconciliação de todas as wallets**.
- **Estado inicial limpo em cada cenário:** banco recriado, filas esvaziadas e instâncias reiniciadas. Sem isso, os eventos acumulados das rodadas anteriores na fila de eventos (dezenas de milhares, ninguém os consome) deixam o emulador mais lento e distorcem a comparação.

## Ambiente da medição

| Item | Valor |
|---|---|
| Máquina | contêiner Linux com 2 vCPU (Intel Xeon 2.1 GHz) e 7.8 GB de RAM |
| Processos no mesmo host | PostgreSQL 16, MiniStack, 3 instâncias da aplicação (`bun src/main.ts`, Bun 1.4.4) e o gerador de carga |
| Configuração | padrão (`pool max 20` por instância, `lock_timeout 5 s`, outbox em lotes de 10 a cada 500 ms) |

Tudo divide as mesmas 2 vCPUs, então os números medem o comportamento **relativo** da solução (filas de lock, atraso da outbox e correção), não a capacidade de produção. A mesma máquina variou bastante ao longo da noite (de 117 a 211 req/s no mesmo código); por isso as comparações abaixo foram feitas em sequência, com estado limpo.

## Resultados (30/10/2026, código final)

| Cenário | Requisições | Vazão | p50 | p95 | p99 | Erros 5xx | Erros de rede | Conflitos de lock | Outbox lag (máx / média) | Drenagem após a carga | Divergências |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 10% na hot wallet | 3 943 | 129.0 req/s | 201 ms | 2 641 ms | 4 432 ms | 0 | 1 (0.03%) | 0 | 14.9 s / 7.2 s | 24.1 s | 0 de 101 |
| sem hot wallet | 4 101 | 135.5 req/s | 447 ms | 991 ms | 1 315 ms | 0 | 0 | 0 | 19.8 s / 10.1 s | 36.6 s | 0 de 101 |

Na rodada com hot wallet, as requisições à hot wallet tiveram p50 de 2 596 ms e p95 de 4 823 ms.

## Otimização da outbox encontrada na medição

A primeira rodada sem hot wallet mostrou o atraso da outbox chegando a 20 s. O plano de execução da consulta do relay revelou que o índice estava em `next_attempt_at`, mas a consulta ordena por `occurred_at`: **a cada lote de 10 eventos, o banco ordenava todos os eventos pendentes**. Com fila acumulada, cada lote ficava mais lento e o atraso crescia sozinho. Duas correções:

- índice parcial em `(occurred_at, id) where published_at is null` (migration `Migration20261030010000OutboxRelayOrder`): o plano passou de `Sort` sobre todos os pendentes (custo 2 934) para `Index Scan` que para nos 10 primeiros (custo 24);
- os eventos publicados de um lote são marcados com **um único `UPDATE`**, em vez de um por evento.

Comparação em sequência, mesmas condições (cenário com hot wallet):

| Código | Vazão | Outbox lag máx | Drenagem após a carga |
|---|---|---|---|
| antes (`3f99193`) | 118.6 req/s | 18.6 s | 35.0 s |
| depois | 129.0 req/s | 14.9 s | 24.1 s |

## Análise

- **Correção sob carga:** ~8 000 operações nos dois cenários, incluindo 770 replays, sem nenhuma divergência entre saldo e ledger e sem nenhum erro 5xx. Os replays devolveram o resultado original.
- **A vazão é limitada pela CPU compartilhada,** não pelos locks: com ou sem hot wallet ela fica na mesma faixa. Cada operação faz um commit com 4 a 6 escritas mais o trigger adiado, e o PostgreSQL divide 2 vCPUs com todo o resto.
- **A hot wallet mostra o custo do lock pessimista.** As operações da mesma wallet entram em fila, e numa carga em laço fechado os clientes se acumulam nela: p95 de ~4.8 s. A cauda das outras requisições também sobe (p95 de 1.0 s para 2.6 s), porque quem espera o lock **ocupa uma conexão do pool** e as demais esperam conexão. A latência do cliente inclui essa espera por conexão, por isso o p99 da hot wallet passa de 5 s sem nenhum `lock_timeout` (0 conflitos): a espera pelo lock em si ficou abaixo do limite.
- **O atraso da outbox** é a métrica que mais sofre neste ambiente: o publicador disputa a CPU com a carga, e o MiniStack (escrito em Python) processa cada `SendMessageBatch`. Nenhum evento se perdeu, e todos foram publicados depois da carga.
- **Erros de rede:** no máximo 1 em ~4 000 requisições em algumas rodadas, sem resposta HTTP e sem erro nos logs das instâncias (provavelmente uma conexão keep-alive fechada pelo servidor no momento do reuso). O script agora registra a mensagem. Um provedor reenviaria com a mesma chave, sem risco de efeito duplicado.

## O que eu faria com mais tempo

- Rodar com PostgreSQL, broker e aplicação em máquinas separadas, e na AWS de verdade, para medir capacidade real.
- Limitar quantas requisições podem esperar o lock da mesma wallet (ou um pool separado para elas), para que uma hot wallet não segure conexões das demais.
- Separar o publicador da outbox em um processo próprio e aumentar o paralelismo de publicação, se o atraso dos eventos virar requisito de SLO.
