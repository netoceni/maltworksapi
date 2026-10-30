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
    [string] $AccountId = "",
    [switch] $TokenFromClipboard
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$Root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$ConfigFile = Join-Path $Root "wrangler.lab-staging.jsonc"
$Preflight = Join-Path $Root "scripts\maltworks-lab-stage-preflight.mjs"
$BranchExpected = "test/staging-history-lab-free10-20261028"
$Endpoint = "https://api-staging.maltworks.com.br/v1/telemetry"


function Conferir-Dominio-No-Painel([string] $Account, [string] $Worker, [switch] $FromClipboard) {
    # Cloudflare dashboard-managed Custom Domain: verify live target via read-only API.
    if ($Account -cne "4e8c08f70722d344cf39c362a110d706") {
        throw "Account ID incorreto para o Maltworks Lab. Nenhum envio sera realizado."
    }
    Write-Host "Auditoria SOMENTE LEITURA: Workers Scripts Read (Custom Domains)."
    if ($FromClipboard) {
        Write-Host "Copie o token Cloudflare no navegador. Nao cole no PowerShell."
        [void](Read-Host "Pressione Enter depois de copiar o token")
        $ClipboardText = Get-Clipboard -Raw
        if ([string]::IsNullOrWhiteSpace($ClipboardText)) {
            throw "Clipboard vazio. Copie primeiro o token."
        }
        try {
            $Seguro = ConvertTo-SecureString -String $ClipboardText.Trim() -AsPlainText -Force
        } finally {
            $ClipboardText = $null
            try {
                Set-Clipboard -Value " " -ErrorAction Stop
            } catch {
                Write-Warning "Nao foi possivel limpar o clipboard; substitua o token manualmente."
            }
        }
    } else {
        $Seguro = Read-Host "Token de API Cloudflare (nao sera exibido nem salvo)" -AsSecureString
    }
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
        $Uri = "https://api.cloudflare.com/client/v4/accounts/$Account/workers/domains?hostname=api-staging.maltworks.com.br"
        $Resposta = Invoke-RestMethod -Method Get -Uri $Uri -ErrorAction Stop -Headers @{
            Authorization = ("Bearer " + $ApiToken)
        }
        if ($Resposta.success -ne $true) {
            throw "API nao confirmou sucesso."
        }
        $Dominios = @($Resposta.result | Where-Object {
            $_.hostname -ceq "api-staging.maltworks.com.br"
        })
        if ($Dominios.Count -ne 1 -or
            $Dominios[0].service -cne $Worker -or
            $Dominios[0].zone_name -cne "maltworks.com.br" -or
            $Dominios[0].enabled -ne $true -or
            $Dominios[0].previews_enabled -eq $true) {
            throw "Custom Domain nao corresponde ao Worker de staging isolado e ativo."
        }
    } catch {
        # Never echo HTTP diagnostics with credentials.
        throw "Auditoria do Custom Domain falhou. Confira Account ID, token Workers Scripts Read e dominio do Worker; envio bloqueado."
    } finally {
        $ApiToken = $null
        $Seguro = $null
    }
    Write-Host ("Custom Domain ativo confirmado: api-staging.maltworks.com.br -> " + $Worker) -ForegroundColor Green
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
    # Custom Domains do not appear in Wrangler routes. Check the actual account
    # mapping and the exact D1 UUID; never modify the staging or production D1.
    if ($Config.d1_databases.Count -ne 1 -or
        $Config.d1_databases[0].database_id -cne
        "26b9ecab-1aaa-4120-93a5-1c409555d28b") {
        throw "D1 de staging incorreto. Envio bloqueado."
    }
    Conferir-Dominio-No-Painel -Account $AccountId -Worker $Config.name -FromClipboard:$TokenFromClipboard

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