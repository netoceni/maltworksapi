# Maltworks Lab 5.19 — retomada no desktop de casa (03/11/2026)

Este documento é um handoff operacional. O ensaio de 30 minutos **não foi executado**. Não executar deploy, merge, migrations ou limpeza de D1 para retomar o trabalho.

## Estado aprovado

- Branch: `test/staging-history-lab-free10-20261028`.
- Staging Worker: `maltworks-api-lab-staging`; versão API `5.19.0`; publicação anterior no staging: `75a11f3b-3b79-46d3-b66d-773bfff252b8`.
- D1 exclusivamente de staging: `maltworks-lab-staging` / `26b9ecab-1aaa-4120-93a5-1c409555d28b`.
- Cloudflare Access protege `api-staging.maltworks.com.br`.
- `LAB_STAGING_ROLLUP_ONLY=true`, todas as retenções em `0`, cron de rollups */5.
- Homologação curta de dez WebSockets: 10/10 ready, 30/30 heartbeats e um evento online por dispositivo no intervalo auditado; o offline após 90 segundos de silêncio está correto.
- O novo script de soak `07-estabilidade-integrada-lab.ps1` prevê 60 ticks a cada 30 s, dez WebSockets com HTTP simultâneo, 595 pacotes por canal, pausa apenas do dispositivo 00 nos ticks 30–34, auditoria D1 intermediária e ao final.
- O script não publica Worker nem modifica diretamente D1. HTTP e presença via API criam dados **apenas** no D1 de staging.

## Atenção: DPAPI não é portátil

No notebook, os arquivos:
- `%LOCALAPPDATA%\Maltworks\lab-access-client.dpapi.json`
- `%LOCALAPPDATA%\Maltworks\lab-staging-ten-tokens.dpapi`

estão protegidos para aquele usuário Windows, **não** para o desktop. Copiá-los diretamente não permite descriptografar.

Os scripts `08-transferir-lab-entre-pcs.ps1` e `maltworks-lab-vault-crypto.mjs` transferem **somente** os cofres de teste em um envelope AES-256-GCM autenticado, com chave derivada por scrypt e uma senha que não sai do usuário. Nenhum segredo é impresso, colocado em argumentos ou gravado em plaintext. O arquivo criptografado ainda deve ser tratado como sensível e excluído após a importação.

## 1 — NO NOTEBOOK, antes de desligar

No checkout `$HOME\maltworksapi-staging`:

```powershell
Set-Location "$HOME\maltworksapi-staging"
git pull --ff-only origin test/staging-history-lab-free10-20261028
if ($LASTEXITCODE -ne 0) { throw "Falha no Git" }
powershell.exe -NoProfile -ExecutionPolicy Bypass -File ".\scripts\08-transferir-lab-entre-pcs.ps1" -Etapa Checar
```

Se ambos os cofres estiverem presentes, exporte para um **caminho privado e fora do Git**. Exemplo usando USB na unidade E: (substitua pela unidade real; não presuma que é E:):

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File ".\scripts\08-transferir-lab-entre-pcs.ps1" -Etapa Exportar -Arquivo "E:\maltworks-lab-transfer.enc.json"
```

Digite duas vezes uma senha **forte, única**, de pelo menos 20 caracteres ASCII sem espaços (idealmente gerada por gerenciador de senhas). Nunca cole a senha nem o arquivo aqui, no repositório, em issues ou em chats. Guarde a senha separada do USB. Exportar não altera o cofre original.

## 2 — NO DESKTOP

Checkout existente, em princípio `$HOME\maltworksapi-staging`. Se não existir, autentique no GitHub e faça o clone da branch de homologação em pasta separada da produção.

```powershell
Set-Location "$HOME\maltworksapi-staging"
git pull --ff-only origin test/staging-history-lab-free10-20261028
if ($LASTEXITCODE -ne 0) { throw "Falha no Git" }
npm.cmd ci
if ($LASTEXITCODE -ne 0) { throw "Falha no npm ci" }
powershell.exe -NoProfile -ExecutionPolicy Bypass -File ".\scripts\09-preparar-desktop-lab.ps1" -Etapa PrepararLocal
```

`PrepararLocal` gera `wrangler.lab-staging.jsonc` localmente somente se não existir. Aponta exclusivamente ao D1 de staging; nunca faz deploy.

Se os dois cofres DPAPI estiverem ausentes no desktop, importe o pacote criptografado **após** conectá-lo no USB:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File ".\scripts\08-transferir-lab-entre-pcs.ps1" -Etapa Importar -Arquivo "E:\maltworks-lab-transfer.enc.json"
```

A importação recusa sobrescrever cofres existentes e recria as credenciais DPAPI para a identidade local do desktop. Depois de testar o acesso, apague o pacote de transferência e mantenha a senha fora do repositório.

## 3 — APENAS verificação de pré-requisitos

```powershell
npx.cmd wrangler whoami
powershell.exe -NoProfile -ExecutionPolicy Bypass -File ".\scripts\07-estabilidade-integrada-lab.ps1" -Etapa Checar
```

`whoami` consulta o login Cloudflare; `Checar` confere branch, arquivo de staging, credenciais Access e /health, identidades de staging e D1. **Não** abre WS e **não** envia telemetria. Se qualquer etapa falhar, investigar antes de seguir; não copiar arquivos DPAPI diretamente, nem rodar scripts de provisionamento de produção.

## 4 — Ensaio posterior, apenas após o Checar aprovado

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File ".\scripts\07-estabilidade-integrada-lab.ps1" -Etapa Executar30Min
```

Confirmação exata: `EXECUTAR 30MIN WS HTTP LAB`.

Deixar computador ligado, sem suspensão e sem outro simulador. Nunca reiniciar automaticamente após falha; pode haver dados parciais.

O ensaio **pausa a emissão** HTTP e os heartbeats do controlador 00 por cinco ticks, mas não fecha fisicamente o socket; depois retoma tráfego. A autenticação em nova conexão WebSocket já foi testada separadamente.

Critérios: HTTP 595 entregues/5 omitidos; WS 595 ACK/5 omitidos; nove dispositivos sem falso offline; um único offline/online controlado; todas as sequências finais em 60; cadências válidas. Registra métricas D1 em janela móvel de 24 h (não equivalem a custo isolado de linhas) e requer consulta complementar ao Analytics para consumo real dos Durable Objects.

Relatório local sem credenciais: `%LOCALAPPDATA%\Maltworks\lab-soak-30min-last.json`.

## Limitações

Não há acesso remoto ao desktop do usuário nesta conversa. A preparação local só se confirma quando `PrepararLocal` e `Checar` forem executados **nesse desktop**. O CI valida sintaxe e cenários artificiais; não substitui o ensaio remoto. Nenhum teste de 30 min foi executado nem agendado.
