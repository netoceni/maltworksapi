# Maltworks Lab - teste somente no ambiente de homologacao.
# Por padrao NAO envia dados; -Enviar exige Access + token de teste.
[CmdletBinding()]
param(
    [switch] $Enviar,
    [ValidateSet("normal","alarm","sensor-loss","reboot","offline","command")]
    [string] $Cenario = "alarm",
    [ValidateRange(1,10)]
    [int] $Controladores = 1,
    [ValidateRange(1,120)]
    [int] $Ciclos = 12,
    [string] $ZoneId = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$Root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$ConfigFile = Join-Path $Root "wrangler.lab-staging.jsonc"
$Preflight = Join-Path $Root "scripts\maltworks-lab-stage-preflight.mjs"
$BranchExpected = "test/staging-history-lab-free10-20261028"
$Endpoint = "https://api-staging.maltworks.com.br/v1/telemetry"


function Conferir-Rota-No-Painel([string] $Zone, [string] $Worker) {
    # This route is managed by the Cloudflare dashboard, not the local Wrangler
    # config. Verify its real Worker target using a READ-ONLY API call.
    if ($Zone -notmatch '^[a-fA-F0-9]{32}
    $Branch = (& git branch --show-current | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or $Branch -ne $BranchExpected) {
        throw "Execute este script apenas na branch de homologacao PR #18."
    }

    if (-not $Enviar) {
        Write-Host "Dry-run: nenhum HTTP sera enviado." -ForegroundColor Cyan
        & node "scripts\maltworks-lab-staging.mjs"
        if ($LASTEXITCODE -ne 0) { throw "Dry-run do Maltworks Lab falhou." }
        Write-Host "Para testar de verdade, use -Enviar APOS proteger o hostname via Access."
        return
    }

    if (-not (Test-Path -LiteralPath $ConfigFile)) {
        throw "Config de staging ausente. Execute primeiro 01-provisionar-staging.ps1."
    }
    & node $Preflight $ConfigFile
    if ($LASTEXITCODE -ne 0) { throw "Preflight rejeitou o staging." }
    $Config = Get-Content -LiteralPath $ConfigFile -Raw | ConvertFrom-Json
    # The route may be configured in Cloudflare's dashboard only. Do not
    # add it to Wrangler just to make this script pass: audit live routing.
    Conferir-Rota-No-Painel -Zone $ZoneId -Worker $Config.name

    foreach ($Name in @(
        "MALTWORKS_LAB_STAGING_TOKENS_JSON",
        "CF_ACCESS_CLIENT_ID",
        "CF_ACCESS_CLIENT_SECRET"
    )) {
        $Value = [Environment]::GetEnvironmentVariable($Name, "Process")
        if ([string]::IsNullOrWhiteSpace($Value)) {
            throw ("Variavel de teste nao configurada: " + $Name + ". Nao envie seu valor pelo chat.")
        }
    }

    Write-Host ("Alvo: " + $Endpoint) -ForegroundColor Yellow
    Write-Host ("Cenario: " + $Cenario + "; controllers: " + $Controladores +
        "; ciclos: " + $Ciclos + "; intervalo real: 30s")
    Write-Host "ATENCAO: este comando executa requisicoes REMOTAS apenas para staging."
    $Confirm = Read-Host "Digite ENVIAR LAB para continuar"
    if ($Confirm -cne "ENVIAR LAB") { throw "Envio cancelado." }

    $Arguments = @(
        "--send", "--endpoint", $Endpoint,
        "--devices", ([string] $Controladores),
        "--ticks", ([string] $Ciclos),
        "--scenario", $Cenario,
        "--pace-ms", "30000"
    )
    & node "scripts\maltworks-lab-staging.mjs" @Arguments
    if ($LASTEXITCODE -ne 0) { throw "Teste remoto rejeitado ou interrompido pelo Lab." }
} finally {
    Pop-Location
}) {
        throw "Informe -ZoneId com o Zone ID de maltworks.com.br (32 hex)."
    }
    Write-Host "Auditoria SOMENTE LEITURA: Workers Routes Read no zone maltworks.com.br."
    $Seguro = Read-Host "Token de API Cloudflare (nao sera exibido nem salvo)" -AsSecureString
    $Ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Seguro)
    $ApiToken = $null
    try {
        $ApiToken = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($Ptr)
    } finally {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($Ptr)
    }
    if ([string]::IsNullOrWhiteSpace($ApiToken)) {
        throw "Token de consulta vazio. Nada sera enviado."
    }
    try {
        $Uri = "https://api.cloudflare.com/client/v4/zones/$Zone/workers/routes"
        $Resposta = Invoke-RestMethod -Method Get -Uri $Uri -ErrorAction Stop -Headers @{
            Authorization = ("Bearer " + $ApiToken)
        }
        if ($Resposta.success -ne $true) {
            throw "API nao confirmou sucesso."
        }
        $Rotas = @($Resposta.result | Where-Object {
            $_.pattern -eq "api-staging.maltworks.com.br/*"
        })
        if ($Rotas.Count -ne 1 -or $Rotas[0].script -cne $Worker) {
            throw "Rota staging nao aponta exclusivamente ao Worker esperado."
        }
    } catch {
        # Never interpolate original HTTP failures: they may include request
        # details. No network send will occur if this audit fails.
        throw "Falha na auditoria da rota Cloudflare. Verifique Zone ID, token Workers Routes Read e destino do Worker; envio bloqueado."
    } finally {
        $ApiToken = $null
        $Seguro = $null
    }
    Write-Host ("Rota real confirmada: api-staging.maltworks.com.br/* -> " + $Worker) -ForegroundColor Green
}

Push-Location $Root
try {
    $Branch = (& git branch --show-current | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or $Branch -ne $BranchExpected) {
        throw "Execute este script apenas na branch de homologacao PR #18."
    }

    if (-not $Enviar) {
        Write-Host "Dry-run: nenhum HTTP sera enviado." -ForegroundColor Cyan
        & node "scripts\maltworks-lab-staging.mjs"
        if ($LASTEXITCODE -ne 0) { throw "Dry-run do Maltworks Lab falhou." }
        Write-Host "Para testar de verdade, use -Enviar APOS proteger o hostname via Access."
        return
    }

    if (-not (Test-Path -LiteralPath $ConfigFile)) {
        throw "Config de staging ausente. Execute primeiro 01-provisionar-staging.ps1."
    }
    & node $Preflight $ConfigFile
    if ($LASTEXITCODE -ne 0) { throw "Preflight rejeitou o staging." }
    $Config = Get-Content -LiteralPath $ConfigFile -Raw | ConvertFrom-Json
    $HasRoutes = $Config.PSObject.Properties.Name -contains "routes"
    if (-not $HasRoutes -or @($Config.routes).Count -ne 1 -or
        $Config.routes[0].pattern -ne "api-staging.maltworks.com.br/*") {
        throw "A rota staging ainda nao foi habilitada e conferida."
    }

    foreach ($Name in @(
        "MALTWORKS_LAB_STAGING_TOKENS_JSON",
        "CF_ACCESS_CLIENT_ID",
        "CF_ACCESS_CLIENT_SECRET"
    )) {
        $Value = [Environment]::GetEnvironmentVariable($Name, "Process")
        if ([string]::IsNullOrWhiteSpace($Value)) {
            throw ("Variavel de teste nao configurada: " + $Name + ". Nao envie seu valor pelo chat.")
        }
    }

    Write-Host ("Alvo: " + $Endpoint) -ForegroundColor Yellow
    Write-Host ("Cenario: " + $Cenario + "; controllers: " + $Controladores +
        "; ciclos: " + $Ciclos + "; intervalo real: 30s")
    Write-Host "ATENCAO: este comando executa requisicoes REMOTAS apenas para staging."
    $Confirm = Read-Host "Digite ENVIAR LAB para continuar"
    if ($Confirm -cne "ENVIAR LAB") { throw "Envio cancelado." }

    $Arguments = @(
        "--send", "--endpoint", $Endpoint,
        "--devices", ([string] $Controladores),
        "--ticks", ([string] $Ciclos),
        "--scenario", $Cenario,
        "--pace-ms", "30000"
    )
    & node "scripts\maltworks-lab-staging.mjs" @Arguments
    if ($LASTEXITCODE -ne 0) { throw "Teste remoto rejeitado ou interrompido pelo Lab." }
} finally {
    Pop-Location
}