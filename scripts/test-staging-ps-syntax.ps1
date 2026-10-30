# Static security and syntax checks only. Does NOT run Wrangler or touch Cloudflare.
$ErrorActionPreference = "Stop"
$Repo = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$Files = @(
    (Join-Path $PSScriptRoot "01-provisionar-staging.ps1"),
    (Join-Path $PSScriptRoot "02-testar-staging.ps1"),
    (Join-Path $PSScriptRoot "03-configurar-access.ps1")
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
Write-Host "PowerShell staging: verificacao estatica concluida." -ForegroundColor Green
