# Static security and syntax checks only. Does NOT run Wrangler or touch Cloudflare.
$ErrorActionPreference = "Stop"
$Repo = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$Files = @(
    (Join-Path $PSScriptRoot "01-provisionar-staging.ps1"),
    (Join-Path $PSScriptRoot "02-testar-staging.ps1"),
    (Join-Path $PSScriptRoot "03-configurar-access.ps1"),
    (Join-Path $PSScriptRoot "04-credencial-access-lab.ps1"),
    (Join-Path $PSScriptRoot "06-websocket-lab.ps1"),
    (Join-Path $PSScriptRoot "07-estabilidade-integrada-lab.ps1"),
    (Join-Path $PSScriptRoot "08-transferir-lab-entre-pcs.ps1"),
    (Join-Path $PSScriptRoot "09-preparar-desktop-lab.ps1"),
    (Join-Path $PSScriptRoot "10-auditar-http-lab.ps1")
)
foreach ($File in $Files) {
    $Tokens = $null
    $Errors = $null
    $Ast = [System.Management.Automation.Language.Parser]::ParseFile(
        $File, [ref] $Tokens, [ref] $Errors
    )
    if ($null -eq $Ast -or @($Errors).Count -gt 0) {
        foreach ($ErrorItem in @($Errors)) { Write-Error $ErrorItem.Message }
        throw ("Erro de sintaxe em " + $File)
    }
    $Source = Get-Content -LiteralPath $File -Raw
    # PowerShell treats a question mark immediately after an unbraced variable
    # (e.g. $DatabaseName?) as part of the variable name under StrictMode.
    if ($Source -match '\$[A-Za-z_][A-Za-z0-9_]*\?') {
        throw ("Unbraced variable followed by ? in " + $File)
    }
    if ($Source -match '(?i)wrangler\s+d1\s+(delete|execute).*(maltworks-recovery|maltworks-production)') {
        throw ("Comando proibido em " + $File)
    }
    Write-Host ("Sintaxe valida: " + (Split-Path $File -Leaf)) -ForegroundColor Green
}
$Provision = Get-Content -LiteralPath $Files[0] -Raw
foreach ($Required in @(
    "maltworks-lab-stage-preflight.mjs",
    "maltworks-lab-staging",
    "workers_dev",
    "preview_urls",
    "PUBLICAR PRIVADO",
    "MIGRAR LAB"
)) {
    if (-not $Provision.Contains($Required)) { throw ("Guarda ausente: " + $Required) }
}
# The initial administrative bootstrap token must remain retrievable without
# being printed or stored in the repository. Only the current Windows identity
# can decrypt the DPAPI-protected file.
foreach ($Required in @(
    "ConvertFrom-SecureString",
    "lab-staging-bootstrap.dpapi",
    "Test-Path -LiteralPath `$StagingBootstrapVault",
    "if (`$Nome -eq `"BOOTSTRAP_SECRET`")",
    "secret put `$Nome --config `$ConfigName"
)) {
    if (-not $Provision.Contains($Required)) {
        throw ("Bootstrap secret preservation safeguard is missing: " + $Required)
    }
}
# Sending telemetry must first verify the actual Custom Domain mapping,
# not just trust a hostname or a local Wrangler route declaration.
$StageSender = Get-Content -LiteralPath $Files[1] -Raw
foreach ($Required in @(
    "Conferir-Dominio-No-Painel",
    "Workers Scripts Read",
    "api.cloudflare.com/client/v4/accounts/",
    "api-staging.maltworks.com.br",
    "26b9ecab-1aaa-4120-93a5-1c409555d28b",
    "previews_enabled",
    "Read-Host",
    "-AsSecureString"
)) {
    if (-not $StageSender.Contains($Required)) {
        throw ("Staging route validation safeguard missing: " + $Required)
    }
}
$Access = Get-Content -LiteralPath $Files[2] -Raw
foreach ($Required in @(
    "api-staging.maltworks.com.br",
    "Read-Host",
    "-AsSecureString",
    "ConvertFrom-SecureString",
    "service_token",
    "non_identity",
    "app_launcher_visible",
    "Listar-Aplicacoes",
    "Verificar-Aplicacao",
    "CRIAR ACCESS"
)) {
    if (-not $Access.Contains($Required)) {
        throw ("Cloudflare Access safeguard missing: " + $Required)
    }
}
if ($Access -match '(?i)(^|\s)(bypass|everyone)\s*=\s*\$true') {
    throw "Access provisioning contains a potentially permissive bypass."
}
$LocalCredentials = Get-Content -LiteralPath $Files[3] -Raw
foreach ($Required in @(
    "58d6a273-b961-4936-b444-482700608202",
    "26b9ecab-1aaa-4120-93a5-1c409555d28b",
    "lab-access-client.dpapi.json",
    "ConvertFrom-SecureString",
    "ConvertTo-SecureString",
    "Invoke-RestMethod",
    "MaximumRedirection 0",
    "LAB_STAGING_ROLLUP_ONLY",
    "Read-Host",
    "EnviarPiloto",
    "EnviarDez",
    "ENVIAR 1 LAB",
    "ENVIAR 10 LAB",
    "lab-staging-ten-tokens.dpapi",
    "MW-C{0:D11}",
    "9b64b50b-5d45-472e-abdf-ac9d51e427bc",
    "PreviousEnv",
    "maltworks-lab-staging.mjs"
)) {
    if (-not $LocalCredentials.Contains($Required)) {
        throw ("Local DPAPI vault safeguard missing: " + $Required)
    }
}
# Device IDs are generated dynamically. Verify the exact generator and all
# ten IDs, not a literal that no longer exists in the sender source.
if ($LocalCredentials -notmatch '\[string\]::Format\("MW-C\{0:D11\}",\s*\$Index\)') {
    throw "Lab staging controller ID format is not the expected MW-C prefix plus 11 digits."
}
if ($LocalCredentials -notmatch '(?s)for\s*\(\$Index\s*=\s*0;\s*\$Index\s+-lt\s+\$DeviceCount;\s*\$Index\+\+\)') {
    throw "Lab staging token loader must enumerate every requested controller."
}
$Ids = @(0..9 | ForEach-Object { [string]::Format("MW-C{0:D11}", $_) })
if ($Ids.Count -ne 10 -or
    $Ids[0] -cne "MW-C00000000000" -or
    $Ids[9] -cne "MW-C00000000009" -or
    @($Ids | Select-Object -Unique).Count -ne 10) {
    throw "Lab staging controller ID generator failed the 10-device check."
}
# Both remote pilots are fixed: 1 or 10 controllers and 3 frames,
# normal scenario, exact confirmation; never silently default to live sends.
if ($LocalCredentials -notmatch '(?s)\$DeviceCount\s*=\s*if\s*\(\$Etapa\s+-eq\s+"EnviarDez"\)\s*\{\s*10\s*\}\s*else\s*\{\s*1\s*\}') {
    throw "Remote pilot must only allow 1 or 10 staging controllers."
}
if ($LocalCredentials -notmatch '(?s)"--devices",\s*\(\[string\]\$DeviceCount\),\s*"--ticks",\s*"3"') {
    throw "Remote pilot must send exactly 3 frames per controller."
}
if ($LocalCredentials -notmatch '(?s)"--scenario",\s*"normal",\s*"--pace-ms",\s*"30000"') {
    throw "Remote pilot must remain normal scenario at 30-second intervals."
}
if ($LocalCredentials -notmatch '(?s)\$ConfirmationText\s*=\s*if\s*\(\$DeviceCount\s+-eq\s+10\)\s*\{\s*"ENVIAR 10 LAB"\s*\}\s*else\s*\{\s*"ENVIAR 1 LAB"\s*\}') {
    throw "Remote pilots must require distinct fixed confirmation phrases."
}
if ($LocalCredentials -notmatch '(?s)\$Confirm\s+-cne\s+\$ConfirmationText') {
    throw "Remote pilot must require an exact user confirmation."
}
if ($LocalCredentials -match '(?i)wrangler\s+(deploy|d1\s+(delete|execute|migrations))') {
    throw "Local credential script must not deploy or alter a D1."
}
# A new staging-only WebSocket pilot must never allow production connections,
# transmit user credentials in its output, or run remote D1 mutations.
$WebSocketPilot = Get-Content -LiteralPath $Files[4] -Raw
foreach ($Required in @(
    "wss://api-staging.maltworks.com.br/v1/device/realtime",
    "lab-staging-ten-tokens.dpapi",
    "lab-access-client.dpapi.json",
    "LAB_STAGING_ROLLUP_ONLY",
    "TestarUm",
    "TestarDez",
    "ABRIR 1 WS LAB",
    "ABRIR 10 WS LAB",
    "heartbeat_ack",
    "SetRequestHeader",
    "CloseAsync"
)) {
    if (-not $WebSocketPilot.Contains($Required)) {
        throw ("WebSocket Lab guarda ausente: " + $Required)
    }
}
if ($WebSocketPilot -match '(?i)wss?://(api|app|admin)\.maltworks\.com\.br/' -or
    $WebSocketPilot -match '(?i)wrangler\s+(deploy|d1\s+(delete|execute|migrations))') {
    throw "WebSocket Lab contem acesso proibido a producao ou mutacao D1."
}
# PowerShell can emit internal VoidTaskResult from awaited .NET tasks into the
# function success stream. Never let async task artifacts mix with WS handles.
foreach ($Required in @(
    '$null = $Socket.ConnectAsync(',
    '$null = $Socket.SendAsync(',
    '$null = $Socket.CloseAsync('
)) {
    if (-not $WebSocketPilot.Contains($Required)) {
        throw ("WebSocket task output guard missing: " + $Required)
    }
}
Write-Host "PowerShell staging: verificacao estatica concluida." -ForegroundColor Green

# Integrated endurance test: parser, staging identity, credential safety and no DML.
$Soak = Get-Content -LiteralPath $Files[5] -Raw
foreach ($Required in @(
    "Executar30Min",
    "EXECUTAR 30MIN WS HTTP LAB",
    "api-staging.maltworks.com.br",
    "maltworks-lab-staging",
    "LAB_STAGING_ROLLUP_ONLY",
    "CF-Access-Client-Secret",
    "lab-staging-ten-tokens.dpapi",
    "--soak-outage",
    "Start-Process",
    "heartbeat_ack",
    "Ler-Estados",
    "--json --command",
    "offline_events",
    "595"
)) {
    if (-not $Soak.Contains($Required)) {
        throw ("Integrated soak protection missing: " + $Required)
    }
}
if ($Soak -match '(?i)wss?://(api|app|admin)\.maltworks\.com\.br/' -or
    $Soak -match '(?i)https?://(api|app|admin)\.maltworks\.com\.br/' -or
    $Soak -match '(?i)wrangler\s+(deploy|d1\s+(delete|migrations))') {
    throw "Integrated soak must never access production or mutate Cloudflare resources."
}
if ($Soak -match '(?i)\b(DROP\s+TABLE|DELETE\s+FROM|UPDATE\s+notification_states|INSERT\s+INTO)\b') {
    throw "Integrated soak must perform no direct D1 writes."
}
Write-Host "Integrated Maltworks Lab: staging and syntax safeguards approved." -ForegroundColor Green

# Second-PC readiness and offline AES-GCM transfer: check syntax and hard guards.
$Transfer = Get-Content -LiteralPath $Files[6] -Raw
foreach ($Required in @(
    "Exportar", "Importar", "Read-Host", "-AsSecureString",
    "MALTWORKS_LAB_STAGING_PORTABLE_V1", "maltworks-lab-vault-crypto.mjs",
    "lab-access-client.dpapi.json", "lab-staging-ten-tokens.dpapi",
    "Maltworks", "Nao grave bundles", "Nao sobrescrever",
    "lab-staging", "test/staging-history-lab-free10-20261028"
)) {
    if (-not $Transfer.Contains($Required)) { throw ("Guard missing in vault transfer: " + $Required) }
}
$HomeSource = Get-Content -LiteralPath $Files[7] -Raw
foreach ($Required in @(
    "PrepararLocal", "Checar", "maltworks-lab-stage-preflight.mjs",
    "wrangler.lab-staging.example.jsonc", "REPLACE_WITH_NEW_STAGING_D1_UUID",
    "26b9ecab-1aaa-4120-93a5-1c409555d28b",
    "LAB_STAGING_ROLLUP_ONLY", "lab-access-client.dpapi.json", "lab-staging-ten-tokens.dpapi"
)) {
    if (-not $HomeSource.Contains($Required)) { throw ("Guard missing in home staging setup: " + $Required) }
}
foreach ($Source in @($Transfer, $HomeSource)) {
    if ($Source -match '(?i)wrangler\s+(deploy|d1\s+(delete|migrations|execute))' -or
        $Source -match '(?i)https?://(api|app|admin)\.maltworks\.com\.br/') {
        throw "Desktop preparation scripts must never deploy or mutate Cloudflare."
    }
}
Write-Host "Home desktop and AES credential transfer: static checks approved." -ForegroundColor Green

# An interrupted soak is audited with only SELECT queries on the staging D1.
$Postmortem = Get-Content -LiteralPath $Files[8] -Raw
foreach ($Required in @(
    "lab-soak-30min-last.json",
    "maltworks-lab-stage-preflight.mjs",
    "26b9ecab-1aaa-4120-93a5-1c409555d28b",
    "LAB_STAGING_ROLLUP_ONLY",
    "SELECT d.id AS controlador",
    "SELECT CAST(",
    "--remote --config",
    "--json --command",
    "somente leitura"
)) {
    if (-not $Postmortem.ToLowerInvariant().Contains($Required.ToLowerInvariant())) {
        throw ("Read-only D1 postmortem guard missing: " + $Required)
    }
}
if ($Postmortem -match '(?i)wrangler\s+(deploy|d1\s+(delete|migrations))' -or
    $Postmortem -match '(?i)https?://(api|app|admin)\.maltworks\.com\.br/' -or
    $Postmortem -match '(?i)\b(INSERT\s+INTO|UPDATE\s+\w+|DELETE\s+FROM|DROP\s+TABLE)\b') {
    throw "Read-only postmortem must never deploy, send telemetry or mutate D1."
}
Write-Host "Read-only historical D1 audit: safeguards approved." -ForegroundColor Green
