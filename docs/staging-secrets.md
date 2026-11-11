# Segredos da API de staging — preparados localmente, sem publicação

Foram preparados valores novos e independentes para `PASSWORD_PEPPER`,
`PASSWORD_RESET_SECRET` e `BOOTSTRAP_SECRET`, exclusivos de `maltworks-api-staging`,
conta `4e8c08f70722d344cf39c362a110d706` e D1
`5151e251-52c1-4406-8ae9-c6d38961d124`. Cada valor usa 256 bits de aleatoriedade
criptográfica e atende aos mínimos atuais do código: 32 caracteres para pepper/reset
e 24 para bootstrap. Nenhum segredo da API de produção ou do Lab foi copiado.

## Guarda local

O cofre fica fora dos repositórios:
`%LOCALAPPDATA%\Maltworks\api-staging\api-staging-secrets.dpapi.json`.
Contém somente metadados e payload cifrado por Windows DPAPI `CurrentUser`, com
contexto de conta/Worker/D1 e ACL restrita ao usuário atual e SYSTEM. Não há arquivo
plaintext de secrets, `.dev.vars` ou `.env` gerado por esta preparação. Valores,
ciphertext e fingerprints de valores não são incluídos no relatório, Git ou chat.

O helper `scripts/prepare-app-staging-secrets.ps1` não usa rede, Wrangler ou comandos
de publicação. Gera o cofre apenas se ausente; um cofre existente é validado, sem
sobrescrever ou rotacionar valores. Recusa configuração que não seja a pilha privada
esperada e caminhos de cofre redirecionados. `-VerifyOnly` não cria nem regrava o cofre:

```powershell
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File scripts/prepare-app-staging-secrets.ps1 -VerifyOnly
```

A verificação decifra somente em memória, confere os três nomes, formato e distinção,
ACL, round-trip e ausência dos valores no diff do índice Git. Emite apenas metadados
e resultados booleanos. A verificação local confirmou que o arquivo cifrado permaneceu
idêntico. Cópias `*.dpapi` e `*.dpapi.json` também estão ignoradas pelo Git.

Preservar o perfil e as chaves DPAPI do usuário Windows. O cofre não é um backup
portável; cópia para outro perfil não garante recuperação. Não rotacionar o pepper
após criar contas sem planejar a compatibilidade das senhas. A preparação pode ser
repetida para validar o mesmo cofre, sem regeneração automática.

## Cadastro Cloudflare sem ativar tráfego

A conta foi reconferida. A consulta somente de leitura
`versions list --name maltworks-api-staging --config wrangler.app-staging.jsonc --json`
retornou **10007: Worker inexistente**. Não houve tentativa de cadastrar os valores,
criar Worker/versão, alterar secrets remotos ou executar deploy.

No Wrangler local **4.118.0**, `versions secret bulk` recebe JSON por stdin e cria
uma nova versão, sem ativá-la. Requer uma versão base já enviada; o código local
trata ausência de versões como erro 10222. A inclusão dos três segredos juntos evita
três versões parciais. A forma futura, somente após a versão base existir, é:

```powershell
$env:CLOUDFLARE_ACCOUNT_ID = '4e8c08f70722d344cf39c362a110d706'
$env:WRANGLER_LOG_SANITIZE = 'true'
node node_modules/wrangler/bin/wrangler.js versions secret bulk --name maltworks-api-staging --config wrangler.app-staging.jsonc
```

Esse comando é um molde para um launcher seguro com stdin redirecionado, **não foi
executado**. O launcher deve validar conta, Worker, configuração e versão base antes
de decifrar o cofre; entregar o JSON apenas ao stdin do processo filho e limpar buffers
ao terminar. Não imprimir o JSON, copiar valores para argumentos, criar arquivo de
secrets em texto, desativar sanitização ou ativar logs de payloads.
O código inspecionado do Wrangler omite corpos de requisição quando
`WRANGLER_LOG_SANITIZE=true`; o bulk imprime os nomes das chaves, não seus valores.
Depois de cadastrar, verificar os nomes na versão retornada e confirmar que o
deployment ativo não mudou. `versions secret list` lista secrets atualmente
publicados e, sozinho, não comprova o conteúdo de uma versão ainda não ativada.

**Primeiro Worker ainda é uma etapa pendente.** A API tem a migration inicial de DO
`v1-realtime-app-staging`. A documentação exige publicação para aplicar migrations
de Durable Objects e registra a limitação de upload-only no Wrangler anterior a
4.131.0. Portanto, não tratar `versions upload --secrets-file` como um atalho já
validado para inicializar esta pilha, nem criar Worker placeholder, publicar código,
aplicar a migration de DO ou atualizar Wrangler nesta tarefa. Nenhuma dessas ações
foi executada. A primeira criação/publicação privada precisa de autorização própria.

Não usar `wrangler secret put`, `secret bulk` sem `versions`, `secret delete` ou o
botão Deploy do painel para esta preparação: esses fluxos podem publicar
imediatamente. Não usar a etapa `Segredos` de `01-provisionar-staging.ps1`, que é do
Lab antigo e utiliza o fluxo de publicação imediata.

O estado correto é **preparado localmente / cadastro remoto pendente**. O código
da API e seus bindings não foram alterados nesta etapa.
Continuam pendentes contas de teste, DNS/Access, primeira publicação privada/DO,
ativação de domínios e testes remotos com simuladores.

Referências oficiais:
[secrets em Workers](https://developers.cloudflare.com/workers/configuration/secrets/),
[comandos de versões](https://developers.cloudflare.com/workers/wrangler/commands/workers/#versions-secret-bulk),
[migrations de DO e versões](https://developers.cloudflare.com/workers/versions-and-deployments/gradual-deployments/#durable-objects),
[DPAPI CurrentUser](https://learn.microsoft.com/en-us/dotnet/api/system.security.cryptography.dataprotectionscope).
