# Maltworks Lab 5.19: guarded 10-device, 60-tick, 30-second staging-only pilot.
# Checar is read-only; Enviar30Min sends 600 synthetic HTTP packets after confirmation.
# No deploy, migrations, database mutation commands or production routes.
[CmdletBinding()]
param(
    [ValidateSet("Checar", "Enviar30Min")]
    [string] $Etapa = "Checar"
)
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$ExpectedBranch = "test/staging-history-lab-free10-20261028"
$ExpectedWorker = "maltworks-api-lab-staging"
$ExpectedDb = "maltworks-lab-staging"
$ExpectedDbId = "26b9ecab-1aaa-4120-93a5-1c409555d28b"
$ExpectedAccountId = "4e8c08f70722d344cf39c362a110d706"
$ExpectedAccessTokenId = "9b64b50b-5d45-472e-abdf-ac9d51e427bc"
$ExpectedHost = "api-staging.maltworks.com.br"
$ExpectedDevices = 10
$ExpectedTicks = 60
$ExpectedFrames = 600
$Root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$ConfigPath = Join-Path $Root "wrangler.lab-staging.jsonc"
$VaultDir = Join-Path ([Environment]::GetFolderPath("LocalApplicationData")) "Maltworks"
$AccessVault = Join-Path $VaultDir "lab-access-client.dpapi.json"
$DeviceVault = Join-Path $VaultDir "lab-staging-ten-tokens.dpapi"

function Desproteger-Valor([string] $Cifrado) {
    $Secure = ConvertTo-SecureString -String $Cifrado
    $Handle = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Secure)
    try {
        return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($Handle)
    } finally {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($Handle)
        $Secure.Dispose()
    }
}

function Conferir-D1 {
    $Raw = & npx.cmd wrangler d1 info $ExpectedDb --json
    if ($LASTEXITCODE -ne 0) { throw "Falha ao consultar metadados do D1." }
    $Info = ($Raw | Out-String) | ConvertFrom-Json
    if ($Info.uuid -cne $ExpectedDbId -or $Info.name -cne $ExpectedDb) {
        throw "D1 remoto nao corresponde ao staging aprovado."
    }
    return $Info
}

Push-Location $Root
$ClientId = $null
$ClientSecret = $null
$TokenMapPlain = $null
$SelectedTokens = $null
try {
    $CurrentBranch = (& git branch --show-current | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or ($CurrentBranch -cne $ExpectedBranch -and $CurrentBranch -cne "main")) {
        throw "Use main ou a branch de homologacao. Nenhuma transmissao foi iniciada."
    }
    if (-not (Test-Path -LiteralPath $ConfigPath)) {
        throw "Configuracao local de staging ausente."
    }
    & node (Join-Path $Root "scripts\maltworks-lab-stage-preflight.mjs") $ConfigPath
    if ($LASTEXITCODE -ne 0) { throw "Preflight isolado falhou." }
    $Cfg = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
    if ($Cfg.name -cne $ExpectedWorker -or
        $Cfg.workers_dev -ne $false -or
        $Cfg.preview_urls -ne $false -or
        $Cfg.d1_databases.Count -ne 1 -or
        $Cfg.d1_databases[0].binding -cne "DB" -or
        $Cfg.d1_databases[0].database_name -cne $ExpectedDb -or
        $Cfg.d1_databases[0].database_id -cne $ExpectedDbId -or
        $Cfg.vars.LAB_STAGING_ROLLUP_ONLY -cne "true" -or
        $Cfg.vars.TELEMETRY_RETENTION_DAYS -cne "0" -or
        $Cfg.vars.HISTORY_5MIN_RETENTION_DAYS -cne "0" -or
        $Cfg.vars.HISTORY_HOURLY_RETENTION_DAYS -cne "0" -or
        $Cfg.vars.TELEMETRY_PERSIST_INTERVAL_SECONDS -cne "180") {
        throw "Configuracao local nao corresponde ao Lab Free isolado."
    }
    if (-not (Test-Path -LiteralPath $AccessVault) -or
        -not (Test-Path -LiteralPath $DeviceVault)) {
        throw "Cofres DPAPI locais ausentes. Nenhuma transmissao iniciada."
    }
    $Vault = Get-Content -LiteralPath $AccessVault -Raw | ConvertFrom-Json
    if ($Vault.account_id -cne $ExpectedAccountId -or
        $Vault.hostname -cne $ExpectedHost -or
        $Vault.service_token_id -cne $ExpectedAccessTokenId) {
        throw "Credencial Access nao corresponde ao simulador isolado."
    }
    $ClientId = Desproteger-Valor $Vault.client_id_dpapi
    $ClientSecret = Desproteger-Valor $Vault.client_secret_dpapi
    if ($ClientId -notmatch '^[A-Za-z0-9.-]{12,255}\.access(\.[A-Za-z0-9.-]+)?$' -or
        $ClientSecret -notmatch '^(cfast_[A-Za-z0-9]{48}|[A-Fa-f0-9]{64})$') {
        throw "Credenciais Access em formato inesperado."
    }
    $Headers = @{
        "CF-Access-Client-Id" = $ClientId
        "CF-Access-Client-Secret" = $ClientSecret
    }
    try {
        $Health = Invoke-RestMethod -Uri ("https://" + $ExpectedHost + "/health") -Method Get -Headers $Headers -MaximumRedirection 0 -TimeoutSec 15 -ErrorAction Stop
    } catch {
        throw "GET /health nao confirmou o staging autenticado."
    } finally {
        $Headers = $null
    }
    if ($Health.ok -ne $true -or $Health.version -cne "5.19.0") {
        throw "Worker ou versao do staging inesperados."
    }
    $Before = Conferir-D1
    Write-Host "Worker validado: $ExpectedWorker (v5.19.0)" -ForegroundColor Green
    Write-Host "D1 validado: $ExpectedDb / $ExpectedDbId" -ForegroundColor Green
    Write-Host "Retencao desativada; cron de rollups habilitado." -ForegroundColor Green
    if ($Etapa -eq "Checar") {
        Write-Host "Checagem concluida. Nenhuma telemetria enviada."
        return
    }

    $Cipher = (Get-Content -LiteralPath $DeviceVault -Raw).Trim()
    $TokenMapPlain = Desproteger-Valor $Cipher
    $TokenMap = ConvertFrom-Json -InputObject $TokenMapPlain
    $SelectedTokens = [ordered]@{}
    $Seen = New-Object 'System.Collections.Generic.HashSet[string]'
    for ($Index = 0; $Index -lt $ExpectedDevices; $Index++) {
        $WantedId = [string]::Format("MW-C{0:D11}", $Index)
        $Property = $TokenMap.PSObject.Properties[$WantedId]
        if ($null -eq $Property -or [string]$Property.Value -notmatch '^[a-fA-F0-9]{64}$') {
            throw "Token de controlador ausente ou invalido."
        }
        $Token = ([string]$Property.Value).ToLowerInvariant()
        if (-not $Seen.Add($Token)) { throw "Tokens de controladores duplicados." }
        $SelectedTokens[$WantedId] = $Token
        $Token = $null
    }
    if ($SelectedTokens.Count -ne $ExpectedDevices) {
        throw "Numero de tokens diferente de dez."
    }

    Write-Host "Ensaio: dez controladores, 60 ciclos a cada 30s (600 envios)." -ForegroundColor Yellow
    Write-Host "Destino: https://api-staging.maltworks.com.br/v1/telemetry"
    Write-Host "Duracao planejada: aproximadamente 30 minutos. Nao reiniciar se falhar."
    $Confirm = Read-Host "Digite exatamente ENVIAR 600 LAB 30MIN"
    if ($Confirm -cne "ENVIAR 600 LAB 30MIN") {
        throw "Envio cancelado. Nenhuma telemetria enviada."
    }

    $EnvNames = @("MALTWORKS_LAB_STAGING_TOKENS_JSON", "CF_ACCESS_CLIENT_ID", "CF_ACCESS_CLIENT_SECRET")
    $SavedEnv = @{}
    foreach ($Name in $EnvNames) {
        $SavedEnv[$Name] = [Environment]::GetEnvironmentVariable($Name, "Process")
    }
    $Started = (Get-Date).ToUniversalTime().ToString("o")
    try {
        $env:MALTWORKS_LAB_STAGING_TOKENS_JSON = ConvertTo-Json -InputObject $SelectedTokens -Compress
        $env:CF_ACCESS_CLIENT_ID = $ClientId
        $env:CF_ACCESS_CLIENT_SECRET = $ClientSecret
        $TokenMapPlain = $null
        $TokenMap = $null
        $SelectedTokens = $null
        $Arguments = @("--send", "--endpoint", "https://api-staging.maltworks.com.br/v1/telemetry", "--devices", "10", "--ticks", "60", "--scenario", "normal", "--pace-ms", "30000")
        $SenderOutput = & node (Join-Path $Root "scripts\maltworks-lab-staging.mjs") @Arguments
        if ($LASTEXITCODE -ne 0) {
            throw "Envio interrompido: pode ter havido entrega parcial. Nao reiniciar sem auditoria."
        }
        $Result = ($SenderOutput | Out-String) | ConvertFrom-Json
        if ($Result.delivered -ne $ExpectedFrames -or $Result.omitted -ne 0 -or
            $Result.timingValid -ne $true -or $Result.environment -cne "staging") {
            throw "Relatorio do emissor nao passou nos criterios."
        }
        Write-Host ($SenderOutput | Out-String).Trim() -ForegroundColor Green
    } finally {
        foreach ($Name in $EnvNames) {
            [Environment]::SetEnvironmentVariable($Name, $SavedEnv[$Name], "Process")
        }
    }

    $After = Conferir-D1
    $Report = [ordered]@{
        started_at_utc = $Started
        finished_at_utc = (Get-Date).ToUniversalTime().ToString("o")
        database = $ExpectedDb
        database_id = $ExpectedDbId
        devices = $ExpectedDevices
        ticks = $ExpectedTicks
        delivered = $Result.delivered
        omitted = $Result.omitted
        timing_valid = $Result.timingValid
        elapsed_ms = $Result.elapsedMs
        average_tick_interval_ms = $Result.averageTickIntervalMs
        min_tick_interval_ms = $Result.minTickIntervalMs
        max_tick_interval_ms = $Result.maxTickIntervalMs
        max_start_lag_ms = $Result.maxStartLagMs
        size_bytes_before = $Before.database_size
        size_bytes_after = $After.database_size
        rows_written_24h_before = $Before.rows_written_24h
        rows_written_24h_after = $After.rows_written_24h
        rows_read_24h_before = $Before.rows_read_24h
        rows_read_24h_after = $After.rows_read_24h
    }
    $Path = Join-Path $VaultDir "lab-30min-latest.json"
    [IO.File]::WriteAllText($Path, (($Report | ConvertTo-Json -Depth 5) + [Environment]::NewLine), (New-Object System.Text.UTF8Encoding($false)))
    Write-Host "Resumo local de consumo salvo: $Path" -ForegroundColor Green
    Write-Host "Contadores 24h sao janelas moveis, nao custo isolado do ensaio."
} finally {
    $ClientId = $null
    $ClientSecret = $null
    $TokenMapPlain = $null
    $SelectedTokens = $null
    Pop-Location
}
