# Segredos da API de staging — cadastrados na API publicada privadamente

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
plaintext permanente de secrets, `.dev.vars` ou `.env` gerado pela preparação. Na
publicação autorizada, o `--secrets-file` consumiu um JSON temporário com ACL privada,
fora dos repositórios; ele e os logs temporários foram removidos no finally. Valores,
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

## Primeira publicação privada concluída

A conta e os recursos foram reconferidos. O Worker inexistente na preparação foi
criado pela primeira publicação privada autorizada, incluindo os três secrets e a
migration `v1-realtime-app-staging` do DO SQLite, com Wrangler 4.118.0 e
`deploy --config wrangler.app-staging.jsonc --secrets-file`.
Versão `7a78a58f-842d-4524-981f-70bfd65374f8`; namespace DO
`a7eef169f38d4a2d850c4bbed602f043`, exclusivo do script de staging.
Metadados remotos confirmaram os três nomes como `secret_text`, sem leitura dos
valores. Não houve rotação do cofre, exposição/versionamento de valores ou cadastro
de contas. `workers_dev=false`, `preview_urls=false`, nenhum custom domain ou route
da nova API; produção/Lab e mapeamentos públicos permaneceram iguais.
Evidências: [staging-private-publication.json](staging-private-publication.json).

O ensaio com valores fictícios passou antes do envio real. O processo leu o cofre
DPAPI apenas em memória, gravou a entrada efêmera em diretório restrito ao usuário
e SYSTEM, suprimiu/redigiu valores de saídas e limpou arquivos no encerramento.
`WRANGLER_LOG_SANITIZE=true` permaneceu ativo. O helper de preparação continua
somente local: seu campo `cloudflare_upload_performed=false` descreve o helper,
não substitui o estado remoto registrado no inventário de publicação.

## Futuras alterações sem ativação imediata

No Wrangler local **4.118.0**, `versions secret bulk` recebe JSON por stdin e cria
uma nova versão, sem ativá-la. A versão base agora existe. A inclusão coordenada
dos segredos evita versões parciais; não executar para esta publicação já concluída.
A forma futura é:

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

A primeira publicação aplicou a migration inicial de DO pela via suportada de deploy.
Não foi feito upload-only/placeholder nem atualização do Wrangler. Futuras migrations
de DO continuam exigindo revisão do ciclo de publicação; a existência desta versão
base não autoriza migrações, rotação de secrets ou ativação de tráfego automaticamente.

Não usar `wrangler secret put`, `secret bulk` sem `versions`, `secret delete` ou o
botão Deploy do painel para esta preparação: esses fluxos podem publicar
imediatamente. Não usar a etapa `Segredos` de `01-provisionar-staging.ps1`, que é do
Lab antigo e utiliza o fluxo de publicação imediata.

O estado correto é **cofre local preservado / secrets cadastrados / API e DO privados
publicados**. O código da aplicação não foi alterado para efetuar a publicação.
Continuam pendentes contas de teste, DNS/Access, Admin/Cloud, ativação de domínios
protegidos e testes remotos com simuladores. Sem URL pública, não foi feito health
HTTP/WebSocket remoto; não abrir endpoint para contornar essa limitação.

Referências oficiais:
[secrets em Workers](https://developers.cloudflare.com/workers/configuration/secrets/),
[comandos de versões](https://developers.cloudflare.com/workers/wrangler/commands/workers/#versions-secret-bulk),
[migrations de DO e versões](https://developers.cloudflare.com/workers/versions-and-deployments/gradual-deployments/#durable-objects),
[DPAPI CurrentUser](https://learn.microsoft.com/en-us/dotnet/api/system.security.cryptography.dataprotectionscope).
