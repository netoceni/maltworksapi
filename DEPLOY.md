# Publicação da Maltworks Cloud API 5.4.0

## 1. Preparar o computador

Instale o Node.js LTS pelo site oficial e abra o PowerShell dentro desta pasta.

```powershell
npm.cmd install
npx.cmd wrangler login
```

O segundo comando abre o navegador para autorizar sua conta Cloudflare.

## 2. Criar o banco D1 em uma instalacao nova

```powershell
npm.cmd run db:create
```

O comando mostrara um `database_id`. Abra `wrangler.jsonc` e substitua o valor
atual pelo ID exibido, mantendo as aspas. Nao execute esta etapa ao atualizar a
instalacao Maltworks existente.

## 3. Criar as tabelas

```powershell
npm.cmd run db:migrate:remote
```

Confirme a aplicação das migrações `0001` até `0005` se o Wrangler perguntar.

## 4. Configurar o segredo inicial

Gere e guarde uma senha aleatoria longa, diferente da senha do futuro painel. Depois execute:

```powershell
npx.cmd wrangler secret put BOOTSTRAP_SECRET
```

Cole o segredo quando solicitado. Ele nao sera gravado no codigo nem no banco.

Crie um segundo segredo aleatorio e independente para proteger os hashes de senha:

```powershell
npx.cmd wrangler secret put PASSWORD_PEPPER
```

O `PASSWORD_PEPPER` deve ter pelo menos 32 caracteres e nao pode ser igual ao
`BOOTSTRAP_SECRET`. Ele tambem nao sera gravado no codigo nem no D1.

## 5. Publicar

```powershell
npm.cmd run deploy
```

Ao final, o Wrangler mostrara um endereco semelhante a:

```text
https://maltworks-api.<sua-conta>.workers.dev
```

Abra no navegador acrescentando `/health`. A resposta deve conter `"ok":true`.

## 6. Proximo passo acompanhado

Nao crie o primeiro usuario nem habilite a nuvem no ESP32 antes de confirmar que `/health` respondeu. Com a URL publicada, faremos juntos:

1. o bootstrap do primeiro proprietario;
2. o primeiro envio real do ESP32;
3. o vinculo do controlador;
4. a associacao de `api.maltworks.com.br`;
5. a troca da URL provisoria pela definitiva.

## Desenvolvimento local

Copie `.dev.vars.example` para `.dev.vars`, defina um segredo de teste e rode:

```powershell
npm.cmd run db:migrate:local
npm.cmd run dev
```

Validacoes antes de publicar:

```powershell
npm.cmd run check
npm.cmd test
```
