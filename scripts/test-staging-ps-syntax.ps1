# Static security and syntax checks only. Does NOT run Wrangler or touch Cloudflare.
$ErrorActionPreference = "Stop"
$Repo = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$Files = @(
    (Join-Path $PSScriptRoot "01-provisionar-staging.ps1"),
    (Join-Path $PSScriptRoot "02-testar-staging.ps1")
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
Write-Host "PowerShell staging: verificacao estatica concluida." -ForegroundColor Green
