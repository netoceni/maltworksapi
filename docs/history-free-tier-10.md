# Historico Inteligente 5.19 — piloto Cloudflare Free de 10 controladores

**Atualiza** o estudo anterior de 25 dispositivos, que permanece apenas
como referencia para uma futura fase paga. Este PR esta em draft; **nao
houve migracao ou limpeza em producao**.

## Cadencia planejada

| Operacao | Intervalo |
| --- | --- |
| Telemetria HTTPS do ESP32 | 30s |
| Heartbeat WebSocket | 30s |
| Estado e grafico ao vivo no Cloud | ~30s |
| Snapshot D1 em estado estavel | 180s |
| Evento critico / alarme / ACK | Persistir na proxima telemetria |
| Detectar offline | 90s |
| Limpeza de brutos expirados | ate 250 / 10min = 36.000/dia |
| Retencao de bruto | 7 dias |
| Historico de 5min | 90 dias (controle de acesso Plus/Pro) |
| Historico horario | 365 dias (controle de acesso Pro) |

**O firmware nao precisa da API para acionar o compressor**. Intervalos
de telemetria alteram apenas o envio dos dados e a velocidade com que o
usuario observa as mudancas pelo Cloud.

## Estimativa de trafego, 10 controladores funcionando 24h

- HTTP Workers: 28.800 requisicoes/dia (limite Free 100.000/dia).
- DO: 28.800 RPC de repasse + 28.800 heartbeats WebSocket
  = ~57.600 requisicoes/dia (limite Free 100.000/dia).
- D1: 4.800 snapshots brutos/dia em regime estavel, sem contar eventos.
- Agregados: 2.880 buckets de 5min e 240 horarios por dia.
- Rows-written D1: usar metrica real. Heuristica de 8 writes por snapshot,
  mais deletes, indices e resumos, pode chegar a ~55 mil linhas/dia com
  2% de eventos, nao constitui valor garantido nem cobranca.
- Armazenamento: limite **500 MB por banco**; SQL local aproxima o espaco
  mas nao substitui telemetria e metricas D1 reais.

O emissor de heartbeat e o servidor DO foram ajustados em PRs separados.
O DO consolida presenca escrita a intervalos de pelo menos 20s para nao
duplicar as atualizacoes HTTP/WS.

## Comandos de simulacao / capacity QA

```bash
python3 scripts/simulate_history_capacity.py \
  --devices 1,5,10 \
  --http-seconds 30 \
  --heartbeat-seconds 30 \
  --persist-seconds 180 \
  --payload-bytes 900 \
  --event-percent 2
```

A CI exige que o cenario de 10 dispositivos esteja abaixo de **80%**
das cotas de Workers (HTTP), DO (RPC+heartbeat) e estimativa D1
(`rows_written`); armazenamento projetado do SQL local precisa ficar
abaixo de 400 MB, como margem de seguranca. Esses criterios sao
conservadores, mas o faturamento real so sera medido na Cloudflare.

## Dependencias

- [API #17](https://github.com/netoceni/maltworksapi/pull/17):
  snapshot 180s, offline 90s, deduplicacao de presenca no DO, testes.
- [Controller #3](https://github.com/netoceni/maltworkscontroller/pull/3):
  defaults de 30s para HTTPS e WS; **NVS preexistente de 5s permanece
  ate o equipamento ser reconfigurado**.
- [API #14](https://github.com/netoceni/maltworksapi/pull/14):
  5min/hora, migracoes 0017/0018, planos, safe cleanup.
- [Cloud #11](https://github.com/netoceni/maltworkspanel/pull/11):
  seletor de historico por plano, CSV, interface.

## Condicoes para nao saturar novamente

1. Nao ultrapassar dez equipamentos em transmissao continua sem
   recalcular quotas.
2. Monitorar requisicoes de **todos os Workers** e DO no mesmo
   projeto/conta, pois trafego dos usuarios tambem consome limites.
3. Observar D1 rows_read/rows_written e memoria do banco, nao apenas
   contagem de amostras.
4. Nao mudar manualmente a cadencia de um ESP de 30s para 5s em
   operacao permanente.
5. A migracao 0017 e agregacao devem ser homologadas em D1 isolado
   antes de executar na base recuperada.
6. Medir custo/limites novamente se adicionar assinaturas, integracao
   de densidade ou mais dispositivos.

Fontes: https://developers.cloudflare.com/workers/platform/limits/ ;
https://developers.cloudflare.com/durable-objects/platform/pricing/ ;
https://developers.cloudflare.com/d1/platform/pricing/ ;
https://developers.cloudflare.com/d1/platform/limits/ .
