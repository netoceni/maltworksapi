# Maltworks Lab: local DPAPI vault for a DEDICATED simulator-only Access token.
# Never creates, rotates or revokes tokens; never deploys or modifies D1.
# PowerShell 5.1+: save uses visible Read-Host because hidden input is blocked
# in this console. No secrets on command line, in git, or in output.
[CmdletBinding()]
param(
    [ValidateSet("Guardar", "Conferir", "Testar")]
    [string] $Etapa = "Conferir"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$AccountId = "4e8c08f70722d344cf39c362a110d706"
$ExpectedHostname = "api-staging.maltworks.com.br"
$OldTokenId = "58d6a273-b961-4936-b444-482700608202"
$ExpectedD1Id = "26b9ecab-1aaa-4120-93a5-1c409555d28b"
$ExpectedBranch = "test/staging-history-lab-free10-20261028"
$Root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$VaultDir = Join-Path ([Environment]::GetFolderPath("LocalApplicationData")) "Maltworks"
$VaultFile = Join-Path $VaultDir "lab-access-client.dpapi.json"

function Proteger-Valor([string] $Valor) {
    $S = ConvertTo-SecureString -String $Valor -AsPlainText -Force
    try { return ConvertFrom-SecureString -SecureString $S }
    finally { $S.Dispose() }
}

function Desproteger-Valor([string] $Cifrado) {
    $S = ConvertTo-SecureString -String $Cifrado
    $P = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($S)
    try {
        return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($P)
    } finally {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($P)
        $S.Dispose()
    }
}

function Validar-Credencial([string] $TokenId, [string] $ClientId, [string] $ClientSecret) {
    if ($TokenId -notmatch '^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$' -or
        $TokenId -eq $OldTokenId) {
        throw "Use o UUID de um NOVO Service Token exclusivo do simulador, nao do token atual."
    }
    if ($ClientId -notmatch '^[A-Za-z0-9.-]{12,255}$' -or
        $ClientId -notmatch '\.access(\.[A-Za-z0-9.-]+)?$') {
        throw "Client ID invalido. Copie apenas o campo Client ID do NOVO token."
    }
    # Since Aug 2026, Cloudflare issues cfast_ secrets. Older tokens use 64 hex.
    if ($ClientSecret -notmatch '^(cfast_[A-Za-z0-9]{48}|[A-Fa-f0-9]{64})$') {
        throw "Client Secret fora dos formatos Cloudflare esperados. Nao salvei nada."
    }
}

Push-Location $Root
try {
    if ((& git branch --show-current | Out-String).Trim() -ne $ExpectedBranch) {
        throw "Branch diferente da homologacao. Nada foi alterado."
    }
    if ($Etapa -eq "Guardar") {
        if (Test-Path -LiteralPath $VaultFile) {
            throw "O cofre Access ja existe. Este script nao sobrescreve credenciais."
        }
        Write-Host "Guarde apenas um NOVO Service Token, exclusivo do simulador." -ForegroundColor Yellow
        Write-Host "ATENCAO: Read-Host comum mostra os caracteres colados. Evite gravar a tela."
        Write-Host "As credenciais nao entram no historico de comandos nem em arquivos de texto."
        $TokenId = Read-Host "UUID do novo Service Token (visivel, nao e segredo)"
        $ClientId = Read-Host "Client ID do novo Service Token (visivel)"
        $ClientSecret = Read-Host "Client Secret do novo Service Token (visivel)"
        $AdminEmail = Read-Host "E-mail autorizado no Access (visivel)"
        try {
            $TokenId = $TokenId.Trim()
            $ClientId = $ClientId.Trim()
            $ClientSecret = $ClientSecret.Trim()
            Validar-Credencial $TokenId $ClientId $ClientSecret
            if ($AdminEmail -notmatch '^[^@\s]+@[^@\s]+\.[^@\s]+$') {
                throw "E-mail de administrador invalido."
            }
            $ProtectedId = Proteger-Valor $ClientId
            $ProtectedSecret = Proteger-Valor $ClientSecret
            if ((Desproteger-Valor $ProtectedId) -cne $ClientId -or
                (Desproteger-Valor $ProtectedSecret) -cne $ClientSecret) {
                throw "Autoteste DPAPI falhou. Credenciais nao salvas."
            }
            $Vault = [ordered]@{
                account_id = $AccountId
                hostname = $ExpectedHostname
                service_token_id = $TokenId
                admin_email = $AdminEmail
                client_id_dpapi = $ProtectedId
                client_secret_dpapi = $ProtectedSecret
            }
            if (-not (Test-Path -LiteralPath $VaultDir)) {
                New-Item -ItemType Directory -Path $VaultDir -Force | Out-Null
            }
            [IO.File]::WriteAllText(
                $VaultFile,
                ((ConvertTo-Json -InputObject $Vault -Depth 8) + [Environment]::NewLine),
                (New-Object System.Text.UTF8Encoding($false))
            )
            Write-Host "Cofre Access DPAPI criado no perfil local. Nenhum token foi exibido novamente." -ForegroundColor Green
        } finally {
            $ClientSecret = $null
            $ClientId = $null
            $ProtectedSecret = $null
            $ProtectedId = $null
        }
        return
    }

    if (-not (Test-Path -LiteralPath $VaultFile)) {
        throw "Cofre Access inexistente. Crie e guarde primeiro um novo Service Token."
    }
    $Vault = Get-Content -LiteralPath $VaultFile -Raw | ConvertFrom-Json
    if ($Vault.account_id -cne $AccountId -or
        $Vault.hostname -cne $ExpectedHostname -or
        $Vault.service_token_id -eq $OldTokenId) {
        throw "Cofre Access nao pertence ao ambiente de staging esperado."
    }
    $ClientId = $null
    $ClientSecret = $null
    try {
        $ClientId = Desproteger-Valor $Vault.client_id_dpapi
        $ClientSecret = Desproteger-Valor $Vault.client_secret_dpapi
        Validar-Credencial $Vault.service_token_id $ClientId $ClientSecret
        Write-Host "Cofre DPAPI legivel e credencial do simulador estruturalmente valida." -ForegroundColor Green

        if ($Etapa -eq "Testar") {
            & node (Join-Path $Root "scripts\maltworks-lab-stage-preflight.mjs") (Join-Path $Root "wrangler.lab-staging.jsonc")
            if ($LASTEXITCODE -ne 0) { throw "Preflight staging falhou." }
            $Cfg = Get-Content -LiteralPath (Join-Path $Root "wrangler.lab-staging.jsonc") -Raw | ConvertFrom-Json
            if ($Cfg.name -cne "maltworks-api-lab-staging" -or
                $Cfg.d1_databases.Count -ne 1 -or
                $Cfg.d1_databases[0].database_id -cne $ExpectedD1Id -or
                $Cfg.vars.LAB_STAGING_ROLLUP_ONLY -cne "true") {
                throw "O staging nao corresponde ao ambiente isolado esperado."
            }
            Write-Host "Testando apenas GET /health do staging; sem dados e sem redirecionamentos."
            $Headers = @{
                "CF-Access-Client-Id" = $ClientId
                "CF-Access-Client-Secret" = $ClientSecret
            }
            try {
                $Response = Invoke-RestMethod -Uri ("https://" + $ExpectedHostname + "/health") -Method Get -Headers $Headers -MaximumRedirection 0 -TimeoutSec 15 -ErrorAction Stop
            } catch {
                throw "Autenticacao Access nao confirmada. Verifique a policy Service Auth do novo token. Nenhuma telemetria enviada."
            } finally {
                $Headers = $null
            }
            if ($Response.ok -ne $true -or [string]::IsNullOrWhiteSpace($Response.version)) {
                throw "Resposta /health inesperada. Nenhuma telemetria enviada."
            }
            Write-Host ("Acesso validado: Worker staging respondeu /health, versao " + $Response.version) -ForegroundColor Green
        }
    } finally {
        $ClientSecret = $null
        $ClientId = $null
    }
} finally {
    Pop-Location
}
