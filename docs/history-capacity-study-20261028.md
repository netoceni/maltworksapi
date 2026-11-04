> **HISTORICO / SUPERADO EM 28/10/2026**: o alvo comercial atual
> e **10 controladores no Cloudflare Free** (HTTP/WS 30s, D1 180s)
> com cleanup 250/10min. As contas e exemplos antigos de 25
> controladores ou cleanup 400 se referem ao estudo anterior, de
> expansao paga; nao representam a configuracao atual do PR.
> Consulte [history-free-tier-10.md](history-free-tier-10.md)
> e [history-staging-free-10.md](history-staging-free-10.md)
> para decisoes e testes em vigor.

# Maltworks Cloud 5.19 — simulação de capacidade (28/10/2026)

**Status:** estudo local isolado, sem tocar no D1, no Worker ou no hardware
de produção. Implementação de expiração em
[PR API #14](https://github.com/netoceni/maltworksapi/pull/14).

## Metodologia

- Python 3.13.5, SQLite 3.46.1; dados fictícios em banco temporário.
- Simulação de 24 horas, **1, 5, 10, 25, 50 e 100 controladores**.
- Intervalo HTTP do Controller: **5 segundos**, contabilizado matematicamente.
  As requisições HTTP/WebSockets/DO **não foram executadas remotamente**.
- Gravação bruta D1 equivalente: **1 minuto**, payload JSON fictício de
  aproximadamente **900 bytes por registro**, além de eventos críticos.
- Executadas consultas SQL de agregação de 5 minutos e 1 hora, usando o
  esquema real da migration 0017, com verificação de igualdade entre
  total de amostras e soma dos agregados.
- O tempo medido é **SQLite local**, não latência de rede, CPU real do Worker
  nem resultado de medição do Cloudflare D1.
- Projeção de armazenamento em regime completo: **7 dias brutos**,
  **90 dias de resumos de 5 minutos** e **365 dias horários**.

## Resultados — cenário estável, sem eventos extras

| Controllers | HTTP req/dia | Brutos D1/dia | Agregados 5min/dia | Arquivo SQLite após 24h | Armazenamento estimado em regime | Rollup 5min / 1h (dia inteiro, SQLite) |
|---:|---:|---:|---:|---:|---:|---:|
| 1 | 17.280 | 1.440 | 288 | 1,73 MB | 15,1 MB | 3 / 2 ms |
| 5 | 86.400 | 7.200 | 1.440 | 8,43 MB | 81,0 MB | 27 / 13 ms |
| 10 | 172.800 | 14.400 | 2.880 | 16,83 MB | 164,8 MB | 46 / 45 ms |
| 25 | 432.000 | 36.000 | 7.200 | 42,02 MB | 415,4 MB | 133 / 101 ms |
| 50 | 864.000 | 72.000 | 14.400 | 84,05 MB | 830,2 MB | 195 / 137 ms |
| 100 | 1.728.000 | 144.000 | 28.800 | 168,34 MB | 1.664 MB | 406 / 271 ms |

Em SQLite local, consulta de histórico para um dispositivo com até 288 buckets
teve P95 entre **0,5 e 2,0 ms**; esta medição **não prevê** desempenho remoto
com filas, rede ou concorrência.

## Pressão de cotas e capacidade de limpeza

Fontes oficiais consultadas em 28/10/2026:
- [Workers Free: 100.000 requests/dia](https://developers.cloudflare.com/workers/platform/limits/)
- [D1 Free: 100.000 linhas gravadas/dia](https://developers.cloudflare.com/d1/platform/pricing/)
- [D1 Free: 500 MB por banco](https://developers.cloudflare.com/d1/platform/limits/)
- [Índices também geram rows_written](https://developers.cloudflare.com/d1/reference/faq/)

**Workers Free:** cinco controladores a cada 5s ocupam **86.400
requisições/dia** antes dos acessos ao Cloud e demais operações; seis
ultrapassam 100.000. O tráfego HTTP e o custo do DO são independentes
da amostragem no D1.

**D1 Free:** a simulação estima, incluindo inserções e expirações de
resumos, **6.384–13.584 linhas/escritas lógicas por controlador/dia**.
O piso conta operações de SQL, o teto heurístico usa fator 8 por bruto
observado indiretamente no diagnóstico real da API em 28/10; **nenhum dos
dois é uma medição de `meta.rows_written` do D1 deste workload**.
Exemplos: 5 controladores = ~31.920–67.920/dia;
10 controladores = ~63.840–135.840/dia. D1 real inclui índices,
comandos, sessão, notificações e possíveis leituras de manutenção.

**Capacidade de limpeza das camadas** (400 brutos/10min, 250 agregados
5min/10min, 100 agregados horários/10min):

| Camada | Limite operacional de expiração |
|---|---:|
| Brutos 60s | **57.600 linhas/dia** (40 controllers sem eventos) |
| Agregados 5min | **36.000 linhas/dia** (~125 controllers) |
| Agregados horários | **14.400 linhas/dia** (~600 controllers) |

**Eventos críticos extras:** simulada a gravação imediata de mais
**2% das amostras brutas**, além da cadência de 60 segundos. Nesse caso
as sobras de registros expirados por dia, após os sete dias iniciais,
foram 0 (5 e 10 controllers), **721 (25)**, **37.440 (50)** e
**110.880 (100)**. O crescimento da fila de brutos provoca aumento
contínuo de armazenamento mesmo com a nova expiração dos agregados.

As projeções de espaço **415 MB com 25**, **830 MB com 50** e
**1,66 GB com 100** equipamentos são do SQLite sintético e dependem
do tamanho real do `payload_json`, dos índices, da densidade de
eventos e da eficiência do arquivo. **Não extrapolar os milissegundos
locais para uma SLA de Cloudflare D1.**

## Decisões de engenharia

1. A rotina nova limita as exclusões e verifica se o resumo horário
   cobre cada bucket de 5min antes da exclusão; a rotina não mexe em
   contas, sensores, receitas, comandos ou histórico de lotes.
2. **Para mais de cinco controladores a cada 5 segundos, considerar
   Workers Paid ou ampliar o intervalo HTTP (15–60s)**. O D1 e o DO
   devem ser dimensionados separadamente.
3. Para **25 ou mais controladores**, rever o teto da limpeza bruta,
   pois mesmo uma pequena taxa de eventos cria fila sem saída. Não
   aumentar o teto sem verificar `meta.rows_written` e storage real;
   para uso comercial, o caminho provável é **D1 Paid, política de
   amostragem por escala e eventual arquivamento R2**.
4. Na fase de homologação, simular comandos/alarme sob concorrência,
   falhas de DO e backfill. O benchmark atual mede a camada SQL apenas.
5. Monitorar na Cloudflare `rowsWritten`, `rowsRead`,
   `databaseSizeBytes`, requisições Worker e custo do DO. Somente
   essas métricas validam o comportamento real.

## Reproduzir

O script foi incluído em `scripts/simulate_history_capacity.py`.
Somente Python 3 (biblioteca padrão) e o arquivo de migration são exigidos.

```bash
python3 scripts/simulate_history_capacity.py --devices 1,5,10,25,50,100 --event-percent 0
python3 scripts/simulate_history_capacity.py --devices 5,10,25,50,100 --event-percent 2
```

O CI executa um cenário reduzido de smoke test; o cenário com 100
dispositivos deve ser feito sob demanda por consumir recursos de
processamento local. Não executar no banco de produção.

## Publicação

**Manter PR #14 em draft.** O merge na `main` executa a migration 0017
e ativa as rotinas de cron na conta Cloudflare de produção. Nenhum merge
ou deploy do Histórico 5.19 foi realizado durante este teste.


## Revisão para lote piloto de 25 controladores
A política de limpeza bruta no PR #14 foi ajustada para 400 registros
a cada 10 minutos (máximo **57.600 registros/dia**). Com telemetria
persistida a cada 60 segundos, 25 dispositivos geram 36.000 snapshots
normais/dia; mais 2% de eventos críticos, aproximadamente 36.720/dia.
Isso oferece margem teórica de 20.880 exclusões/dia, **sem significar
que o D1 Free suporte a ingestão**.

25 controladores transmitindo HTTP a cada 5 segundos significam 432.000
requests/dia, mais os acessos da interface e tarefas administrativas.
Portanto a homologação comercial de 25 controladores **exige planejar
Workers Paid**, e o orçamento D1 Paid deve ser medido por
`meta.rows_written`, conforme documentação oficial. O limite do
Workers Free de 100.000 requests/dia torna inviável a hipótese de
25 controladores contínuos a cada cinco segundos no plano gratuito.

O simulador local e o teste de 25 dispositivos confirmam apenas a
consistência do SQL e as projeções analíticas. Não medem cobrança,
concorrência real ou latência da Cloudflare D1. Veja o plano separado de
homologação em `docs/history-staging-25-controllers.md`.

## Permissões por plano (proposta provisória)
- Essencial: até 7 dias de amostras detalhadas, sem endpoint agregado.
- Plus: até 90 dias agregados (5 minutos ou reagrupados).
- Pro: até 365 dias agregados, incluindo fonte horária.
Os dados físicos não são eliminados na redução do plano. A definição
comercial e o fluxo de cobrança continuam pendentes.
