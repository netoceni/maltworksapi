# Homologacao isolada — Free: 10 controladores / Historico 5.19

**Status: roteiro; NENHUM teste de producao deve ser feito nesta etapa.**
O D1 atual `maltworks-recovery-20261027` e o binding de producao
NAO podem ser reutilizados ou restaurados.

## Passo 1: recursos independentes
- Criar banco D1 novo de staging com UUID e bindings exclusivos.
- Criar Worker API separado, DO SQLite novo e credenciais ficticias;
  bloquear qualquer requisicao para o dominio da API de producao.
- Usar Cloud em staging autenticavel, nao apenas `.pages.dev` atual
  onde o login e desabilitado.
- Isolar R2, OTA e notificacoes de e-mail, ou desativar esses recursos.
- Conferir duas vezes nome/UUID antes de executar migracoes 0017/0018
  em staging. Nunca aplicar comandos D1 remotos via configuracao da main.

## Passo 2: simulacao/CI
- API PR #17 e Firmware PR #3 definem HTTP 30s, WS 30s, D1 180s,
  timeout offline 90s.
- Rodar `npm run check`, `npm test` e
  `python3 scripts/simulate_history_capacity.py --devices 1,5,10
  --http-seconds 30 --heartbeat-seconds 30 --persist-seconds 180
  --event-percent 2 --payload-bytes 900`.
- O simulador SQL mede espaco/latencia local: NUNCA interpretar
  como custo ou CPU real de Workers/D1.

## Passo 3: testes funcionais
- Criar dez dispositivos ficticios de organizacoes distintas.
- Transmitir dados via API de staging com **tokens exclusivamente de
  teste**. O Maltworks Lab v0 por ora so gera JSONL offline; o transporte
  ainda precisa ser implementado com bloqueio de URLs de producao.
- Testar alarmes, comando e ACK, reboot, NVS de 5s, sensor offline,
  perda/retorno de Wi-Fi, WS heartbeat, replay e DO failover.
- Medir ausencia de notificacoes falsas de offline e limite de 90s.
- Simular sete dias de historico, falha de cron, retomada do backfill,
  agregados 5min/1h idempotentes e ausencia de DELETE sem dois watermarks.
- Testar 7/90/365d conforme plano Essencial, Plus e Pro; negar 403
  quando usuario tenta exceder o proprio plano. Nao permitir acesso
  entre organizacoes.

## Passo 4: orcamento e monitoramento reais
- Workers Free <=100.000 req/dia; alvo sob 80.000.
- DO Free <=100.000 requests/dia (WS + RPC) e <=100.000 rows written/dia;
  alvo sob 80.000 para cada metrica.
- D1 Free <=100.000 rows written/dia, 5M rows read/dia e 500MB
  por banco; alvo sob 80% das cotas e abaixo de 400MB.
- Executar read-only diagnosticos de agregacao, ingestao e cleanup.
- Medir p95 da API, CPU e taxa real de falhas/retries; teste local
  nao valida limite Free CPU 10ms do Worker/cron.
- Validar erros 1027 (Workers quota) e limites D1 por simulacao
  controlada, nao por esgotamento da cota real de producao.

## Passo 5: interface
- API no staging antes de ativar Cloud historico em staging.
- Verificar carregamento, historico vazio, resolucao 5min/1h,
  timezone UTC/BRT, grafico, exportacao CSV e controles por plano.
- Testar mobile e desktop, sem dados reais de clientes.

## Gates de publicacao
- Todos os testes/CI do ultimo commit verdes nos PRs #14, #17,
  Controller #3 e Cloud #11.
- Lab #16 validado offline; envio HTTP real apenas no staging.
- Sem bugs de perda de dados, bypass de assinatura ou alertas offline.
- Uso de tres quotas independentes abaixo dos alvos com 10 devices.
- Revisao do procedimento de rollout/rollback e snapshots; nenhum
  DROP/DELETE/restauracao no D1 recuperado.

**Em nenhuma hipotese a abertura de PR aplica essa migracao no banco
de producao.** O merge da API dispara deploy e migracao automatica;
nao mesclar sem completar o plano.
