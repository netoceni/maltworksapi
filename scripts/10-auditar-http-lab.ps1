# Maltworks Lab: READ-ONLY postmortem of a previously failed 30-minute soak.
# No WebSockets, HTTP telemetry, deploys, migrations, D1 DML or production.
[CmdletBinding()]
param()
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$Root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$Config = Join-Path $Root "wrangler.lab-staging.jsonc"
$Db = "maltworks-lab-staging"
$ExpectedDbId = "26b9ecab-1aaa-4120-93a5-1c409555d28b"
$Branch = "test/staging-history-lab-free10-20261028"
$ReportPath = Join-Path (Join-Path ([Environment]::GetFolderPath("LocalApplicationData")) "Maltworks") "lab-soak-30min-last.json"

function Query-D1([string] $Sql) {
    $Raw = & npx.cmd wrangler d1 execute $Db --remote --config $Config --json --command $Sql
    if ($LASTEXITCODE -ne 0) {
        throw "Consulta D1 SELECT falhou. Nenhuma simulacao foi iniciada."
    }
    $Reply = @(($Raw | Out-String) | ConvertFrom-Json)
    if ($Reply.Count -ne 1 -or $Reply[0].success -ne $true) {
        throw "Resposta JSON inesperada da consulta."
    }
    return @($Reply[0].results)
}

Push-Location $Root
try {
    if ((& git branch --show-current | Out-String).Trim() -cnotin @($Branch, "main")) {
        throw "Use main ou a branch de homologacao; auditoria cancelada."
    }
    if (-not (Test-Path -LiteralPath $Config) -or -not (Test-Path -LiteralPath $ReportPath)) {
        throw "Configuracao ou relatorio anterior nao encontrado."
    }
    & node (Join-Path $PSScriptRoot "maltworks-lab-stage-preflight.mjs") $Config
    if ($LASTEXITCODE -ne 0) { throw "Preflight staging falhou." }
    $Cfg = Get-Content -LiteralPath $Config -Raw | ConvertFrom-Json
    if ($Cfg.name -cne "maltworks-api-lab-staging" -or
        $Cfg.d1_databases.Count -ne 1 -or
        $Cfg.d1_databases[0].database_name -cne $Db -or
        $Cfg.d1_databases[0].database_id -cne $ExpectedDbId -or
        $Cfg.vars.LAB_STAGING_ROLLUP_ONLY -cne "true") {
        throw "D1 de homologacao nao corresponde ao ambiente esperado."
    }

    $Report = Get-Content -LiteralPath $ReportPath -Raw | ConvertFrom-Json
    if ($Report.environment -cne "staging" -or $Report.result -cne "failed" -or
        [int]$Report.controllers -ne 10 -or [int]$Report.ticks -ne 60) {
        throw "Relatorio nao e o ensaio integrado interrompido."
    }
    $StartUnix = ([DateTimeOffset]::Parse([string]$Report.started_at_utc)).ToUnixTimeSeconds()
    $EndUnix = ([DateTimeOffset]::Parse([string]$Report.finished_at_utc)).ToUnixTimeSeconds()
    if ($StartUnix -le 0 -or $EndUnix -le $StartUnix -or $EndUnix - $StartUnix -gt 7200) {
        throw "Janela de tempo invalida no relatorio."
    }

    $RawInfo = & npx.cmd wrangler d1 info $Db --json --config $Config
    if ($LASTEXITCODE -ne 0) { throw "Consulta de identidade D1 falhou." }
    $Info = ($RawInfo | Out-String) | ConvertFrom-Json
    if ($Info.uuid -cne $ExpectedDbId -or $Info.name -cne $Db) {
        throw "D1 remoto nao corresponde ao staging."
    }
    Write-Host ""
    Write-Host "=== AUDITORIA DO HTTP JA EXECUTADO ===" -ForegroundColor Cyan
    Write-Host ("Inicio UTC: " + $Report.started_at_utc)
    Write-Host ("Fim UTC:    " + $Report.finished_at_utc)
    Write-Host "Somente duas instrucoes SELECT; sem envio ou alteracao de dados."

    $Sql = "SELECT d.id AS controlador, COUNT(t.id) AS amostras_persistidas, COALESCE(MAX(t.sequence),0) AS maior_sequencia_raw, datetime(MAX(t.received_at),'unixepoch') AS ultima_raw_utc, COALESCE(s.sequence,0) AS sequencia_atual, datetime(s.received_at,'unixepoch') AS ultimo_estado_utc FROM devices d LEFT JOIN telemetry t ON t.device_id=d.id AND t.received_at >= $StartUnix AND t.received_at <= $EndUnix LEFT JOIN device_latest_state s ON s.device_id=d.id WHERE d.id BETWEEN 'MW-C00000000000' AND 'MW-C00000000009' GROUP BY d.id ORDER BY d.id;"
    $Rows = @(Query-D1 $Sql)
    if ($Rows.Count -ne 10) { throw "Auditoria nao retornou dez controladores." }
    $Rows | Format-Table -AutoSize

    Write-Host ""
    Write-Host "=== PERSISTENCIA POR BLOCO DE 5 MINUTOS ===" -ForegroundColor Cyan
    $SqlBuckets = "SELECT CAST((received_at - $StartUnix)/300 AS INTEGER) AS bloco_de_5min, COUNT(*) AS raw_persistidas, COUNT(DISTINCT device_id) AS controladores, MAX(sequence) AS maior_sequencia_raw FROM telemetry WHERE received_at >= $StartUnix AND received_at <= $EndUnix AND device_id BETWEEN 'MW-C00000000000' AND 'MW-C00000000009' GROUP BY bloco_de_5min ORDER BY bloco_de_5min;"
    $Buckets = @(Query-D1 $SqlBuckets)
    if ($Buckets.Count -eq 0) {
        Write-Host "Sem amostras raw dentro da janela."
    } else {
        $Buckets | Format-Table -AutoSize
    }

    Write-Host ""
    Write-Host "AUDITORIA HISTORICA CONCLUIDA - SOMENTE LEITURA" -ForegroundColor Green
} finally {
    Pop-Location
}
