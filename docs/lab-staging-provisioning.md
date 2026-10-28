# Maltworks 5.19 — provisionamento da homologação isolada

**Estado atual (28/10/2026):** testes de integração executados no GitHub,
**infraestrutura Cloudflare remota ainda não provisionada**. Este manual
não autoriza usar o D1 recuperado de produção. A base do trabalho é o
[PR #18](https://github.com/netoceni/maltworksapi/pull/18), derivado do
[PR #14](https://github.com/netoceni/maltworksapi/pull/14). Nenhum merge
em `main` é necessário para homologar.

## Permissões necessárias

Uma conta Cloudflare com permissões para criar e administrar **Workers,
D1, Durable Objects, DNS/Routes e Zero Trust Access**. Recomenda-se
conta de teste separada quando possível; se a homologação compartilhar
a conta Free de produção, **as cotas diárias são compartilhadas**.
As credenciais nunca devem ser coladas no chat ou commitadas.

Se o usuário autorizar o controle da Cloudflare pelo ChatGPT, abrir esta
tarefa no **modo Work**, com o navegador conectado e login na conta
Cloudflare. O chat atual só tem o conector GitHub e leitura limitada
de abas, sem permissão de clicar/criar recursos Cloudflare.

## A. Preparação local (não modifica recursos remotos)

No diretório da API:

```powershell
git fetch origin
git switch test/staging-history-lab-free10-20261028
npm ci
npm run check
npm test
node --test scripts/maltworks-lab*.spec.mjs
node scripts/maltworks-lab-staging.mjs  # DRY RUN: zero rede
```

Conferir a branch com `git status`: jamais executar o deployment
da branch `main` com o `wrangler.jsonc` de produção por engano.

## B. Criar D1 NOVO (único passo que cria banco remoto)

Após login e seleção da conta correta:

```powershell
npx wrangler whoami
npx wrangler d1 list
npx wrangler d1 create maltworks-lab-staging
```

O último comando precisa retornar UUID **novo**, associado a
`maltworks-lab-staging`. NÃO usar o UUID
`a1bf5a75-1bec-4437-92fa-64e69c3da081` (produção recuperada).
Se já existir banco de staging antigo, interromper para inspecionar
antes de reaproveitar ou recriar.

```powershell
Copy-Item wrangler.lab-staging.example.jsonc wrangler.lab-staging.jsonc
# Editar SOMENTE database_id no novo arquivo para usar o UUID retornado.
node scripts/maltworks-lab-stage-preflight.mjs wrangler.lab-staging.jsonc
```

Esse arquivo é ignorado pelo Git. O preflight exige outro Worker/DO,
`workers_dev:false`, sem cron, sem R2/e-mail e host de staging.
**A checagem local não prova que o UUID existe, pertence à conta certa
ou que o Cloudflare Access já está ativo.** Isso precisa ser verificado
no painel antes de aplicar qualquer migração.

## C. Aplicar schema apenas no novo D1

```powershell
npx wrangler d1 info maltworks-lab-staging --json
npx wrangler d1 migrations list DB --remote --config wrangler.lab-staging.jsonc
npx wrangler d1 migrations apply DB --remote --config wrangler.lab-staging.jsonc
```

Conferir nome e UUID em cada etapa. Isso aplica todas as migrações,
inclusive **0017** (agregados) e **0018** (entitlements), **somente
ao D1 de staging**. Nenhum `DROP`, restauro ou `DELETE` manual
de produção é permitido.

## D. Segredos de teste e Worker sem ingresso público

Criar **segredos aleatórios, exclusivos de staging**; nunca copiar
variáveis de produção ou colocá-las em `wrangler.vars`:

```powershell
npx wrangler secret put BOOTSTRAP_SECRET --config wrangler.lab-staging.jsonc
npx wrangler secret put PASSWORD_PEPPER --config wrangler.lab-staging.jsonc
npx wrangler secret put PASSWORD_RESET_SECRET --config wrangler.lab-staging.jsonc
npx wrangler deploy --config wrangler.lab-staging.jsonc --dry-run
npx wrangler deploy --config wrangler.lab-staging.jsonc
```

A versão inicial da configuração **não possui routes** e usa
`workers_dev:false`: o Worker é criado **sem URL pública intencional**.
Não expor o serviço até confirmar o controle de acesso.

## E. Proteger o Worker e configurar hostname

Pelo painel Cloudflare Zero Trust:
1. Ativar Cloudflare Access no **Worker inteiro**, inclusive previews,
   restringindo desenvolvedores autorizados. Proteger apenas um hostname
   pode deixar outras URLs acessíveis.
2. Criar uma política **Service Auth** e um service token de staging
   para o CLI do Maltworks Lab.
3. Verificar que requisições anônimas para o Worker são bloqueadas.
4. Configurar e verificar a rota `api-staging.maltworks.com.br/*`
   apontando para `maltworks-api-lab-staging`, com DNS/proxy corretos.
5. Só depois adicionar ao arquivo local:

```json
"routes": [
  { "pattern": "api-staging.maltworks.com.br/*", "zone_name": "maltworks.com.br" }
]
```

Executar novamente o preflight e o deploy **somente após a verificação
de Access**. O token deve permanecer no cofre/variáveis locais,
não dentro de código, commits, prompts ou issues.

## F. Primeiro teste real da API e do Lab

- Criar uma organização e conta de **teste** no staging, usando
  `BOOTSTRAP_SECRET` apenas de homologação.
- Registrar dez identidades fictícias e vinculá-las à organização.
  Uma telemetria de dispositivo `pending` retorna HTTP 202 e **não é
  considerada teste concluído** pelo emissor Lab.
- Armazenar mapa `MALTWORKS_LAB_STAGING_TOKENS_JSON` localmente.
- Configurar `CF_ACCESS_CLIENT_ID` e `CF_ACCESS_CLIENT_SECRET`
  do service token de staging.

```powershell
node scripts/maltworks-lab-staging.mjs --send `
  --endpoint https://api-staging.maltworks.com.br/v1/telemetry `
  --devices 1 --ticks 12 --scenario alarm --pace-ms 30000
```

Primeiro testar um dispositivo e cenário curto. Em seguida:
`normal`, `sensor-loss`, `offline`, `reboot`, `command`.
Expandir até dez com monitoramento das três cotas (Workers, DO, D1).
`--pace-ms 0` serve somente para smoke HTTP, **não** valida
timeout offline/cron/retention.

## G. Interface Cloud de staging

Depois da API responder, implantar o Cloud a partir do
[PR #11](https://github.com/netoceni/maltworkspanel/pull/11) em
**projeto Pages separado**, com origem de API de staging e autenticação
própria. Não usar preview com login desabilitado como prova de E2E.
Proteger com Access e testar planos, gráficos, CSV e grupos distintos.

## H. Critérios de aceite e recuperação

- Logs e métricas reais (Workers requests/CPU; DO requests/rows_written;
  D1 rows_read/rows_written/database_size) abaixo de **80% da cota**.
- Simulações de alarme e comando preservadas; sem notificações falsas.
- Backfill, dois watermarks e retenção segura verificados antes de DELETE.
- Sem acesso cruzado entre organizações, sem bypass de plano.
- Se algo falhar: desativar a rota ou reverter apenas o **Worker de
  staging**. Não restaurar, apagar ou reconfigurar produção.
- O Lab continua exclusivo do time de engenharia; não existe menu
  de simulação no Cloud comercial.

Documentação oficial:
- D1: https://developers.cloudflare.com/workers/wrangler/commands/d1/
- Workers: https://developers.cloudflare.com/workers/wrangler/commands/workers/
- Access: https://developers.cloudflare.com/workers/configuration/cloudflare-access/
