# Atualizacao da API 5.1.1 para 5.1.2

Esta revisao adiciona uma recuperacao administrativa temporaria para a senha
do proprietario. Ela nao altera o banco, a organizacao, os dispositivos ou a
telemetria.

A rota somente funciona enquanto o segredo `PASSWORD_RESET_SECRET` existir no
Worker. Depois da redefinicao, remova esse segredo para desativar a rota.

## 1. Instalar e validar

```powershell
npm.cmd install
npm.cmd run check
npm.cmd test
```

## 2. Gerar e gravar o segredo temporario

```powershell
$segredoRecuperacao = node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))"
$segredoRecuperacao.Length
$segredoRecuperacao | npx.cmd wrangler secret put PASSWORD_RESET_SECRET
```

O comprimento exibido deve ser `64`. Nao imprima nem envie o valor do segredo.

## 3. Publicar

```powershell
npm.cmd run deploy
```

Confirme que `/health` responde com `"version":"5.1.2"`.

## 4. Redefinir a senha

```powershell
$email = Read-Host "E-mail da conta Maltworks"
$novaSenhaSegura = Read-Host "Nova senha (minimo 12 caracteres)" -AsSecureString
$confirmacaoSegura = Read-Host "Repita a nova senha" -AsSecureString
$novaSenha = [System.Net.NetworkCredential]::new("", $novaSenhaSegura).Password
$confirmacao = [System.Net.NetworkCredential]::new("", $confirmacaoSegura).Password

if ($novaSenha -cne $confirmacao) {
    Remove-Variable novaSenha, confirmacao
    throw "As senhas nao coincidem."
}

$corpoRecuperacao = @{
    email = $email
    newPassword = $novaSenha
} | ConvertTo-Json

$resultadoRecuperacao = Invoke-RestMethod `
    -Method Post `
    -Uri "https://maltworks-api.maltworks-cloud.workers.dev/v1/auth/recovery/reset-password" `
    -Headers @{ Authorization = "Bearer $segredoRecuperacao" } `
    -ContentType "application/json" `
    -Body $corpoRecuperacao

Remove-Variable novaSenha, confirmacao, corpoRecuperacao
$resultadoRecuperacao | ConvertTo-Json -Depth 10
```

O resultado esperado contem `"passwordReset":true` e
`"sessionsRevoked":true`.

## 5. Desativar imediatamente a recuperacao

```powershell
npx.cmd wrangler secret delete PASSWORD_RESET_SECRET
Remove-Variable segredoRecuperacao
```

Confirme a exclusao quando o Wrangler solicitar. Nao e necessario publicar
novamente: sem o segredo, a rota responde `503` e nao redefine senhas.
