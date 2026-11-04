# Maltworks Lab: local-only staging preparation for another Windows desktop.
# PrepararLocal creates only an ignored local staging Wrangler config if absent.
# Checar verifies local readiness; no deployment or device traffic.
[CmdletBinding()]
param(
    [ValidateSet('Checar','PrepararLocal')]
    [string] $Etapa = 'Checar'
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$Config = Join-Path $Root 'wrangler.lab-staging.jsonc'
$Example = Join-Path $Root 'wrangler.lab-staging.example.jsonc'
$D1 = '26b9ecab-1aaa-4120-93a5-1c409555d28b'
$ExpectedBranch = 'test/staging-history-lab-free10-20261028'
$VaultDir = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Maltworks'
$AccessVault = Join-Path $VaultDir 'lab-access-client.dpapi.json'
$DeviceVault = Join-Path $VaultDir 'lab-staging-ten-tokens.dpapi'
Push-Location $Root
try {
    $Actual = (& git branch --show-current | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or ($Actual -cne $ExpectedBranch -and $Actual -cne "main")) {
        throw 'Selecione main ou a branch de homologacao antes de preparar o desktop.'
    }
    & node --version
    if ($LASTEXITCODE -ne 0) { throw 'Node.js nao encontrado.' }
    & npx.cmd --version
    if ($LASTEXITCODE -ne 0) { throw 'npm/npx nao encontrado.' }
    if ($Etapa -ceq 'PrepararLocal' -and -not (Test-Path -LiteralPath $Config)) {
        if (-not (Test-Path -LiteralPath $Example)) { throw 'Template local nao encontrado.' }
        $Source = [IO.File]::ReadAllText($Example)
        if (-not $Source.Contains('REPLACE_WITH_NEW_STAGING_D1_UUID')) {
            throw 'Template de staging alterado. Nao criar configuracao.'
        }
        $New = $Source.Replace('REPLACE_WITH_NEW_STAGING_D1_UUID', $D1)
        [IO.File]::WriteAllText($Config, $New, [Text.UTF8Encoding]::new($false))
        Write-Host 'Configuracao local staging criada sem deploy ou conexao Cloudflare.' -ForegroundColor Green
    }
    if (-not (Test-Path -LiteralPath $Config)) {
        Write-Host 'FALTA: wrangler.lab-staging.jsonc. Execute -Etapa PrepararLocal.' -ForegroundColor Yellow
        return
    }
    & node (Join-Path $PSScriptRoot 'maltworks-lab-stage-preflight.mjs') $Config
    if ($LASTEXITCODE -ne 0) { throw 'Config de staging nao passou preflight.' }
    $Cfg = Get-Content -LiteralPath $Config -Raw | ConvertFrom-Json
    if ($Cfg.d1_databases.Count -ne 1 -or
        $Cfg.d1_databases[0].database_id -cne $D1 -or
        $Cfg.name -cne 'maltworks-api-lab-staging' -or
        $Cfg.vars.LAB_STAGING_ROLLUP_ONLY -cne 'true') {
        throw 'Staging diferente do banco do teste.'
    }
    $A = Test-Path -LiteralPath $AccessVault
    $B = Test-Path -LiteralPath $DeviceVault
    Write-Host ('Credencial Access DPAPI neste PC: ' + $(if ($A) { 'presente' } else { 'ausente' }))
    Write-Host ('Tokens dos dez controladores DPAPI: ' + $(if ($B) { 'presentes' } else { 'ausentes' }))
    if (-not ($A -and $B)) {
        Write-Host 'Nao execute o ensaio antes de importar os cofres para este perfil Windows.' -ForegroundColor Yellow
        return
    }
    Write-Host 'Preparacao local pronta. Para validar credenciais remotas, use 07-estabilidade-integrada-lab.ps1 -Etapa Checar.' -ForegroundColor Green
} finally {
    Pop-Location
}
