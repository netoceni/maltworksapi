# Maltworks Cloud 5.19 — Histórico Inteligente

**Status:** protótipo funcional no [PR #14](https://github.com/netoceni/maltworksapi/pull/14), não aplicado ao D1 de produção.

## O que está implementado e testado

- Migration `0017_intelligent_history.sql` cria `history_5min`, `history_hourly` e `history_rollup_watermarks`. Só adiciona tabelas e índices. Nenhuma tabela ou linha histórica é modificada por essa migration.
- O cron (5 em 5 minutos) produz dois níveis de resumos dos registros **persistidos** em `telemetry`: 300 segundos e 3600 segundos. Cada bucket é UTC, não horário local.
- Calcula amostras, valores disponíveis por sensor, somas/médias, mínimos e máximos para geladeira e poço térmico, setpoint e contagens de amostras com relé ligado ou alarme ativo. `NULL` dos sensores não entra na média.
- O processamento limita cada execução a uma janela de 12 horas por resolução. Em falha, recomeça do último marcador; a inserção dos resumos e a atualização do marcador são transacionais.
- A rotina de retenção **não apaga** telemetria com 7 dias até que **ambos os marcadores** garantam que todo o período foi agregado. Sem marcadores, a limpeza é interrompida de forma segura.
- `src/history-retention.ts` implementa expiração em lotes: 90 dias para agregados de 5min (**250 por 10 minutos**) e 365 dias para agregados horários (**100 por 10 minutos**). A exclusão de 5min exige um watermark horário já processado; a exclusão horária preserva o backup de qualquer dado de 5min ainda não removido. Faltando cobertura, nenhum agregado é apagado.
- `GET /v1/devices/:id/history/summary?range=2592000&maxPoints=720` é um endpoint novo, autenticado e isolado por organização. O endpoint antigo `/telemetry` permanece inalterado.
- Até 90 dias a fonte é `history_5min`; acima de 90 dias até 365 dias, `history_hourly`. Os períodos de exibição são reagrupados para no máximo 1000 pontos, com média ponderada pelo número de amostras, e incluem `bucketSeconds`, `sourceResolutionSeconds`, `completeThrough` e `status` (`warming_up`, `catching_up`, `available`).
- O Cloud 5.19 foi preparado em [PR #11](https://github.com/netoceni/maltworkspanel/pull/11), **sem deploy**: períodos 7/30/90 dias e um ano, gráfico com resolução indicada, CSV de agregados sem apresentar contagens como falsos ON/OFF.
- `GET /v1/admin/history/health` é um diagnóstico **somente leitura para administradores do sistema**: informa quantidade total de registros brutos/agregados, progresso e atraso de cada resolução, cobertura segura da retenção e estado do backfill. Não expõe IDs de dispositivos ou organizações.

## Exemplo da origem dos dados

Se o ESP32 transmite a cada 5 segundos e a API mantém uma leitura no D1 por minuto em estado estável:

- A curva em tempo real (Durable Object) pode exibir até 15 minutos de dados a cada ~5 segundos, **voláteis**.
- No piloto Free de 10 controladores, o bruto no D1 contém tipicamente uma amostra por 180 segundos, além de mudanças de estado/alarmes/comandos (API #17 e firmware #3 pendentes).
- Um resumo de 5 minutos contém tipicamente 1 a 2 amostras persistidas, e o horário cerca de 20 (fora transições extras), se aplicada a cadência Free.
- As médias são **médias de amostras observadas**, e não médias físicas ponderadas por duração de tempo. Eventos que geram mais amostras podem introduzir viés. Futuras versões podem calcular `time_weighted_mean` com pesos por intervalo entre amostras.
- Mínimos e máximos dos resumos se referem somente a amostras persistidas, não a todas as leituras de 5 segundos feitas pelo Controller.

## Segurança e custo

1. `history_rollup_watermarks` avança somente após o agregado ser escrito na mesma transação (D1 batch).
2. Se o cron falha ou está atrasado, **não perde dados**; a retenção pode ficar atrasada. O avanço pode ser observado por `SELECT` somente leitura.
3. O cursor é temporal: o endpoint do ESP registra `received_at` no servidor. Dados artificialmente retrodatados após concluir um bucket não serão automaticamente reprocessados; importar/recuperar arquivo antigo exige rotina explícita de reprocessamento.
4. A expiração dos resumos foi implementada com padrões seguros (90/365 dias), exclusão em lotes e dependência do resumo horário. As variáveis `HISTORY_5MIN_RETENTION_DAYS` e `HISTORY_HOURLY_RETENTION_DAYS` permitem mudar os prazos ou usar `0` para interromper sua expiração. Valores não nulos abaixo de 90/365 dias são rejeitados, e a vigência horária precisa exceder a de 5 minutos.
5. Uma atualização D1 gratuita tem limite de 100.000 linhas escritas/dia e 500 MB por banco. Os resumos adicionam escritas, embora substituam um grande volume de dados antigos. Monitorar quantidades reais de amostras, `rows_written_24h`, custo de índices e duração das consultas em cenário multidispositivo.
6. Não executar DELETE, DROP ou REPLACE manual no banco recuperado `maltworks-recovery-20261027`. A migration 0017 deve ser aplicada uma única vez via pipeline após revisão.
7. O cron processa resumos **antes** de acionar a retenção bruta e dos agregados. A rota administrativa `/v1/admin/history/health` expõe os prazos efetivos, os índices temporais mais antigos e os limites de lote.
8. Não confundir estes agregados térmicos com leituras manuais de densidade e registros de lote; nenhuma dessas tabelas é agregada ou limpa aqui.

## Política de retenção proposta — decisão pendente

| Camada | Janela sugerida | Armazenamento |
|---|---|---|
| Detalhes em tempo real | 15 minutos (volátil) | Durable Object |
| Amostras brutas | 7 dias | D1 `telemetry` |
| Agregados 5 minutos | 90 dias | D1 `history_5min` |
| Agregados 1 hora | 365 dias | D1 `history_hourly` |
| Arquivos muito antigos / relatórios de lote | sob demanda, por plano | R2, a estudar |

**A rotina de 90/365 dias está implementada e testada neste PR, mas NÃO está publicada em produção.** Os prazos são defaults de desenvolvimento, independentes dos futuros direitos comerciais dos planos. Esses direitos e a política de arquivamento R2 permanecem por decidir.

O dimensionamento **atual** é para 10 controladores no Free, com HTTP e WebSocket a 30s, D1 a 180s, timeout offline de 90s e limpeza bruta de 250/10min. A simulação principal está em [history-free-tier-10.md](history-free-tier-10.md). O estudo anterior de 25/50/100 aparelhos é um cenário de expansão em plano pago, não o tamanho do piloto Free.
   
## Contratos da API

GET `/v1/devices/:id/history/summary?range=<segundos|all>&maxPoints=<20..1000>&organizationId=<opcional>`

- `range` numérico entre 300 e 31.536.000 segundos; `all` equivale a 365 dias (não histórico infinito).
- Campos principais da resposta: `points`, `source: d1_aggregate`, `bucketSeconds`, `sourceResolutionSeconds`, `completeThrough`, `status`.
- Cada ponto inclui `bucketStart`, `receivedAt`, `samples`, `refrigeratorValue/Min/Max`, `thermalWellValue/Min/Max`, `setpoint/Min/Max`, `coolingSamples`, `heatingSamples`, `alarmSamples`, `rssi`.
- `history-query.ts` valida parâmetros, controle de acesso por organização e limite de pontos antes da consulta SQL. Resoluções/tabelas são constantes compiladas, não nomes arbitrários de tabelas vindos do cliente.
- A resposta de tela pode estar `catching_up` até que os marcadores alcancem as janelas fechadas. Nunca apresentar dados parciais como um arquivo completo.

## Critérios de aceite antes de publicar

1. CI TypeScript + todos os testes D1 aprovados no último commit dos PRs API e Cloud.
2. Conferir em testes isolados idempotência, nulos, buckets UTC, cobertura 5min/hora, interrupção/reinício e impossibilidade de prune sem ambos os marcadores.
3. Testar com mais de um dispositivo, diferentes organizações e amostras com `NULL`, erros ou relógio não sincronizado.
4. Exercitar em homologação isolada cenários de 1/5/10 controladores, com HTTP/WS 30s e D1 180s, eventos e falhas; medir Workers, DO e D1 por quotas independentes. O Free não garante capacidade para dispositivos adicionais ou uso anormal da plataforma.
5. Revalidar os prazos de 90/365 dias e as métricas reais de `rowsWritten`, DO e Workers Free; se quotas forem ultrapassadas, ativar plano pago ou reduzir tráfego antes de lançar.
6. Simular falha do cron por várias horas: a retenção bruta pausa, o backfill é retomado de forma transacional e o indicador `catching_up` é mostrado.
7. Validar a interface 30/90/365 dias e exportação CSV, inclusive com 0 pontos e durante backfill.
8. Verificar manualmente o entitlement de histórico por plano já aplicado na API; não existe ainda cobrança/renovação automática nem atribuição comercial de assinatura.
9. Revisar a migration e backups do banco recuperado antes de permitir que a branch alcance `main`.

## Decisões para a próxima conversa

1. Ratificar os padrões implementados (7 dias bruto, 90 dias em 5min, 365 dias em 1h) antes de ligar a expiração em produção e decidir os planos comerciais.
2. Histórico de lote encerrado deve ser mantido além do prazo do controlador (arquivo R2 por lote)?
3. Para análises de fermentação, calcular média temporal ponderada e `tempo fora da banda de controle` já na primeira versão comercial?
4. Nos planos Essencial/Plus/Pro, quais períodos e resoluções serão incluídos?
5. Comparação automática de dois lotes de uma mesma receita entra no 5.19 ou fica para 5.20?


## Revisão de produto e escala — 28/10/2026

### Acesso por plano (proposta provisória, sem faturamento)
- **Essencial:** amostras brutas até 7 dias na rota de telemetria existente;
  sem acesso ao endpoint de agregado de longa duração.
- **Plus:** resumos de 5 minutos, até 90 dias.
- **Pro:** resumos de 5 minutos e horários, até 365 dias.

A migração aditiva `0018_organization_history_plans.sql` registra a
elegibilidade por organização. Ausência de linha significa Essencial, sem
acesso gratuito acidental. `/v1/me` informa `historyPlan` em cada
membership para a interface, mas o backend revalida o plano em toda consulta
histórica. Não há checkout, upgrade público ou renovação implementados.

A mudança de plano **não provoca DELETE histórico**. O armazenamento mantém
90 dias em 5 minutos e 365 dias em horas independentemente de qual cliente
possa consultar cada resolução. O custo de arquivamento ainda precisa ser
medido; a matriz comercial será aprovada separadamente.

### Dimensionamento inicial: 10 controladores no plano Free
A limpeza bruta mantém `RETENTION_BATCH_SIZE=250` a cada 10 minutos
(36.000/dia). Dez controladores geram cerca de **4.800 snapshots/dia** em
estado estável com D1 a 180 segundos, mais eventos críticos, permanecendo
bem abaixo da capacidade de remoção diária.

O firmware terá padrões de telemetria HTTP e heartbeat WebSocket a 30s
(Controller PR #3), enquanto a API terá snapshots 180s e presença offline
90s (API PR #17). **Os PRs ainda precisam de validação/publicação; a
branch de Histórico #14 não modifica a configuração da API em produção.**

No Free, 10 controladores a 30s enviam 28.800 requisições HTTP/dia e
28.800 mensagens WS/dia. As mensagens WS e os repasses HTTP consomem
também cota separada do DO. Monitorar a taxa real e as 100 mil operações
diárias de escrita D1 antes de escalar. Ver `docs/history-free-tier-10.md`.

### Homologação
O plano atual usa `docs/history-staging-free-10.md`. Testar migrações
`0017` e `0018` exclusivamente em D1 separado, com Worker, DO e
credenciais de staging. Verificar backfill, watermarks, limites diários
de **três serviços** (Workers, DO e D1), retenção, segurança e Cloud.
**Não integrar API #14 ou Cloud #11 antes da homologação.**
O roteiro de 25 dispositivos fica apenas como estudo de expansão futura.
