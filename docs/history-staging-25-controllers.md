# Homologação isolada — Histórico Inteligente v5.19 / até 25 controladores

Status: plano de execução. **NÃO executar contra a base de produção**
`maltworks-recovery-20261027`. A migração `0017` e a migração
`0018` dos planos ainda estão no PR #14 e **não estão publicadas**.

## 1. Isolamento indispensável

Criar recursos independentes:
- D1 **novo e vazio**, por exemplo `maltworks-history-staging`, com UUID
  diferente tanto do D1 recuperado quanto do D1 anterior.
- Worker `maltworks-api-history-staging`, com binding `DB` apontando
  exclusivamente para esse novo D1, e Durable Object próprio de staging.
- Cloud em um projeto de Pages de staging, domínio ou localhost isolado.
  A prévia automática `.pages.dev` atual desativa login e não permite um
  teste funcional de autenticação; não usá-la como evidência E2E.
- Segredos aleatórios de teste para token de controlador, bootstrap,
  PASSWORD_PEPPER e reset de senha; não copiar tokens de produção.
- OTA/R2: configurar bucket de teste isolado OU desabilitar completamente
  upload/download de firmware no Worker de staging.
- Não reutilizar o domínio `api.maltworks.com.br`, o domínio do painel
  comercial ou variáveis sensíveis de produção.

**Trava operacional:** antes de executar qualquer migração remota, confirmar
em dupla checagem o nome e UUID do novo banco no arquivo de configuração e
no comando Wrangler. Nunca executar `wrangler d1 execute DB --remote` a partir
do `wrangler.jsonc` de produção nesta homologação.

## 2. Pré-requisitos de billing e capacidade

- Preparar Workers Paid antes de testes contínuos de 25 controladores a
  5 segundos: 25 × 17.280 = 432.000 requests/dia, acima dos 100.000/dia
  do Workers Free. Verificar preço atual e limites no painel Cloudflare.
- Conferir o plano D1 aplicável: os limites Free são 100.000 rows_written/dia
  e 500 MB por banco; Workers Paid oferece cota mensal e banco até 10 GB.
- Configurar alertas operacionais de `rows_written`, `rows_read`,
  `database_size`, erros Worker, DO, falhas de comandos e latência p95.
- Não extrapolar o custo apenas pelo número de snapshots. Índices, DELETEs
  e comandos contribuem para rows_written.

## 3. Cenários de validação

**Fase A — CI isolada:** executar `npm run check`, `npm test` e o simulador:
`python3 scripts/simulate_history_capacity.py --devices 1,5,25
--event-percent 2 --payload-bytes 900`. Critérios: os 25 equipamentos
produzem amostras independentes; agregados corretos; zero fila líquida
estimada de limpeza; nenhuma perda nos testes de retenção.

**Fase B — staging D1, sem hardware:** criar 25 identidades fictícias,
cada uma com credencial diferente; conectar um emulador HTTP (Maltworks Lab)
à API de staging; variar cadência em 5/15/30s e manter persistência D1 em
60s. Simular comandos, troca de etapas, alarmes, desaparecimento de rede,
reinicialização, retransmissão e sensores desconectados. No Lab, nenhuma
requisição pode apontar para o domínio de produção.

**Fase C — backfill histórico:** carregar 7 dias de amostras fictícias
em staging; observar avanço dos dois watermarks a partir do bucket antigo;
injetar falha entre agregação e checkpoint; repetir job, confirmar
idempotência e que `pruneExpiredTelemetry` não apaga amostra antes de
ambos os agregados. Simular atraso de 24h e catch-up sem saturar D1.

**Fase D — janelas e planos:** testar:
- Essencial: até 7d via telemetria bruta; 30/90/365d negados na API;
- Plus: 30/90d agregados permitidos; 365d negado;
- Pro: 365d permitido, inclusive fonte horária;
- mudança de plano sem exclusão física dos dados;
- organização A não lê dados da B nem altera seu plano;
- conta não autenticada recebe 401 e não vê histórico/entitlements.

**Fase E — Cloud visual:** verificar estados vazio/carregando,
`warming_up`, `catching_up`, horários UTC e locais, zoom, tooltips,
min/máx, exportação CSV, responsividade e botões restritos por plano.
Testar no navegador e em viewport mobile. A prévia Pages exige host de
staging funcional configurado separadamente.

## 4. Critérios mensuráveis e decisão de release

Aceitar somente se:
1. 100% das transições de alarme e confirmações de comandos simulados
   constarem no log e jamais desaparecerem do sistema.
2. Agregados 5min/1h corresponderem aos brutos, inclusive sensor `NULL`,
   falhas, queda de internet e dados de múltiplas organizações.
3. Nenhum DELETE de bruto sem cobertura dos **dois** resumos; teste
   deliberado de watermark ausente precisa bloquear o cleanup.
4. A projeção de fila bruta não crescer continuamente com 25 controladores
   e 2% de eventos: a nova capacidade teórica é 400 × 144 = 57.600/dia.
5. Requisições, rows_written, CPU, duração de cron, DO e custo D1 medidos
   com pelo menos uma janela operacional em staging. O limite Free
   **não** é alvo de homologação com 25 unidades a 5s.
6. P95 de acesso à API e latência de comando definidos e aceitos em
   staging antes de declarar o produto pronto; não reutilizar latências
   de SQLite local como garantia de D1.
7. Fallback seguro após hibernação do Durable Object e após falha HTTP.
8. Autorização por organização/plano e rotas públicas/privadas sem bypass.

## 5. Sequência de publicação e recuperação

1. Revisar e aprovar o PR #14, só então aplicar migrações de maneira
   controlada (o pipeline da `main` as aplica automaticamente).
2. Publicar API primeiro e verificar o diagnóstico de agregados e
   watermarks. Não publicar Cloud com consulta ao endpoint ausente.
3. Publicar Cloud PR #11 após a API estar respondendo, com conta de
   teste e planos artificiais criados pela administração.
4. Confirmar nas primeiras 24h linhas gravadas, tamanho, backlog,
   alarmes e gráficos. A implantação não deve depender do ESP32 real.
5. Se o processamento falhar, reverter Worker e interface de forma
   controlada; **não restaurar D1 antigo** nem apagar migrações/tabelas
   como medida automática de rollback.
6. Postergar comercialização até completar onboarding do Controller
   e testes físicos dos relés, OTA e senha local.

## Decisões de produto ainda para aprovação

A matriz técnica proposta (Essencial 7d brutos, Plus 90d agregados,
Pro 365d horários) é provisória. Não há cobrança implementada,
renovação automática ou endpoint de alteração de plano neste PR.
Os controles do Cloud mostram elegibilidade; a autorização efetiva
está na API. Não anunciar assinatura funcional antes de integrar billing.
