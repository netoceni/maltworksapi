# Atualizacao da API 5.1.0 para 5.1.1

Esta revisao corrige a incompatibilidade entre as 600.000 iteracoes de PBKDF2
da versao 5.1.0 e o limite de 100.000 iteracoes por operacao do Cloudflare
Workers.

A protecao de senha agora combina:

- HMAC-SHA256 com um `PASSWORD_PEPPER` secreto e independente;
- PBKDF2-SHA256 com salt aleatorio individual;
- armazenamento apenas do hash, salt e numero de iteracoes no D1.

O banco `maltworks-production` e o `BOOTSTRAP_SECRET` existentes devem ser
preservados. Nao execute `db:create` nem `db:migrate:remote` novamente.

## Publicar a correcao

Abra o PowerShell nesta pasta e instale as dependencias:

```powershell
npm.cmd install
```

Gere o novo segredo diretamente em uma variavel:

```powershell
$pepper = node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))"
```

Confira somente o comprimento, sem exibir o segredo:

```powershell
$pepper.Length
```

O resultado deve ser `64`. Grave o segredo no Worker:

```powershell
$pepper | npx.cmd wrangler secret put PASSWORD_PEPPER
```

Depois publique:

```powershell
npm.cmd run deploy
```

Confirme a versao pelo endereco:

```text
https://maltworks-api.maltworks-cloud.workers.dev/health
```

A resposta deve conter `"version":"5.1.1"`.

Depois disso, repita uma unica vez a requisicao de bootstrap com as variaveis
`$segredo`, `$email`, `$nome`, `$senha` e `$corpo` usadas na configuracao.
