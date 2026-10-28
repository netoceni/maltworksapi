# Maltworks Cloud — política de telemetria e histórico (proposta, 28/10/2026)

> Status: **desenho técnico para futura implementação**. Este documento e o monitoramento
> preventivo do mesmo PR NÃO alteram a retenção de produção, a frequência de captura
> nem executam migrações. O banco ativo é `maltworks-recovery-20261027`.
> Dados de usuários, controladores, receitas, lotes, histórico de fermentação e
> auditoria devem ser preservados.

## Problema comprovado no código

- Firmware aceita intervalos de telemetria de **5 a 3600 segundos**.
- Cada amostra de telemetria HTTP normalmente faz pelo menos três operações
  de escrita D1: `INSERT telemetry`, `UPDATE devices`, `UPSERT device_latest_state`.
  Escritas em índices, notificações e operações de comando aumentam esse número.
- A tabela `telemetry` também persiste `payload_json`, duplicando informações
  armazenadas em colunas indexáveis.
- A retenção atual apaga exclusivamente amostras brutas com mais de **7 dias**,
  em lotes de **250 registros a cada 10 minutos** (36.000 registros/dia).
- O `deviceHistory()` consulta apenas `telemetry`: até um pedido com
  `range=all` retorna somente as amostras ainda existentes, não um arquivo histórico.
- A interface apresenta planos Plus/Pro com histórico ampliado, mas isso ainda não
  constitui um arquivo histórico implementado.
- Segundo a documentação pública da Cloudflare consultada em 28/10/2026:
  D1 Workers Free = **500 MB por banco, 100.000 linhas gravadas/dia,
  5 milhões de linhas lidas/dia**. As cotas diárias de leitura/escrita são
  aplicadas desde 01/09/2026.

## Capacidade teórica — transmissão contínua

| Cadência por Controller | Amostras/dia por Controller | Estimativa mínima de 3 escritas D1/amostra |
| --- | ---: | ---: |
| 5 s | 17.280 | 51.840/dia |
| 15 s | 5.760 | 17.280/dia |
| 30 s | 2.880 | 8.640/dia |
| 60 s | 1.440 | 4.320/dia |

**Esses valores são estimativas da rota HTTP, não métricas reais de cobrança.**
Dois equipamentos a cada 5 segundos geram no mínimo 103.680 operações simples
de escrita/dia, antes da rotina de retenção e de eventuais índices/alertas.
Três equipamentos a 5 s geram 51.840 amostras/dia, superando a
capacidade de exclusão de 36.000/dia.

## Fases recomendadas (nesta ordem)

### Fase A — instrumentação sem impacto funcional
- Manter `TELEMETRY_RETENTION_DAYS=7` (padrão de desenvolvimento).
- Observar contagem da última hora, últimas 24h, projeção diária, fila
  expirada, snapshots `d1_health_daily` e bytes do banco.
- Fazer diagnóstico remoto **somente leitura** pelo workflow manual;
  não divulgar credenciais, identificadores de dispositivos ou dados brutos.
- Validar pela primeira vez a coleta de 09:05 BRT; um deploy bem-sucedido
  não prova que o monitor executou.

### Fase B — desacoplar ingestão, realtime e persistência (PR separado)
- Receber a telemetria autenticada na cadência do ESP32, sem mudar proteção
  térmica, comandos ou dados operacionais enviados.
- Encaminhar atualizações transitórias ao Durable Object em tempo real.
- Limitar gravações D1 de estados periódicos por dispositivo **sem causar
  alarmes falsos de offline** (hoje a verificação de presença no D1 usa 30 s).
- Preservar *imediatamente* mudanças de alarme/sensor/etapa/resultado de
  comando; deduplicar por evento sem perder transições.
- Coletar uma amostra bruta periodicamente (por exemplo 30–60 s),
  após simular picos e validar todas as notificações e a API.
- O `device_latest_state`, `devices.last_seen_at`, `recordTelemetryNotifications`,
  `scanOfflineDevices` e o fallback HTTP de comandos precisam de uma
  estratégia conjunta, não simplesmente pular INSERTs.
- Testar concorrência, reboot, quedas de internet, picos de sensores e
  períodos de fermentação antes de ativar o mecanismo. Feature flag
  desabilitada por padrão até concluir testes.

### Fase C — histórico agregado antes da limpeza
- Adicionar *em migração revisada* tabelas de agregados de 5 minutos (30 dias)
  e horários (até 365 dias): contagens; temperatura média/mínima/máxima,
  temperatura do poço, setpoint e estados relevantes, usando
  `(device_id, bucket_start)` como chave idempotente.
- Criar agregados **antes** de apagar a fonte, com transação/falha segura:
  nenhum lote de exclusão pode descartar amostras ainda não resumidas.
- Retenção bruta de 7 dias permanece inicialmente; eventual ampliação apenas
  com medição de orçamento D1 e/ou arquivamento R2.
- Adaptar `GET /v1/devices/:id/telemetry` para servir série coerente
  (recente bruta, antiga agregada) com metadata de resolução e compatibilidade.
  Evitar somar `COUNT(*)` de unidades temporais incompatíveis.
- Não misturar leitura de densidade manual/registro de lote com telemetria
  transitória, nem aplicar limpeza a tabelas `fermentation_*`, `batches`,
  `audit_log`, `users` ou `device_latest_state`.

### Fase D — arquivo e planos
- Definir objetivos de histórico para Essencial/Plus/Pro **antes** de prometer
  ou cobrar o recurso. Comparar duração/resolução por plano.
- Se o volume exceder os orçamentos do D1, usar objetos comprimidos no R2,
  particionados por dispositivo/período, com manifesto e verificação.
- Nunca apagar R2 antes da confirmação de integridade e disponibilidade
  do arquivo; reter backup e considerar LGPD/consentimento.
- Testar exportação CSV e histórico histórico em aparelhos simulados.

## Critérios mínimos de aceite
1. Um Controller emitindo a cada 5 s não aumenta o D1 como se todas as
   amostras fossem persistidas, após ativar a política futura.
2. Dois e cinco equipamentos simulados não atingem cota diária no
   cenário de laboratório escolhido; medir `meta.rows_written`, não
   inferir apenas pelo número de requests.
3. Sem comando duplicado, nenhum alarme perdido, nenhuma alteração no
   comportamento térmico local ou falsa notificação offline.
4. Séries de 1h, 7 dias, 30 dias e 1 ano são coerentes e informam
   claramente a resolução/fonte dos pontos.
5. Limpeza é idempotente e só remove brutos já cobertos pela agregação;
   todos os testes de D1 são locais/isolados antes de migrar produção.

## Proteções de GitHub pendentes
Os 4 branches `main` estavam sem branch protection em 28/10/2026.
O conector GitHub atual não possui permissão de administração de regras.
Bloquear push direto, exigir PR, checks e revisão humana no GitHub Settings.
Admin é repositório privado e a API retornou restrição de plano para rulesets.
