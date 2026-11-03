# Maltworks Lab ONLY: encrypted move of existing DPAPI vaults across Windows PCs.
# Exportar: decrypt DPAPI locally -> AES-256-GCM encrypted bundle.
# Importar: authenticate and decrypt bundle -> NEW DPAPI vaults for this Windows user.
# No uploads, deployments, Cloudflare writes, plaintext files or printed tokens.
[CmdletBinding()]
param(
    [ValidateSet('Checar','Exportar','Importar')]
    [string] $Etapa = 'Checar',
    [string] $Arquivo
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$VaultDir = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Maltworks'
$AccessVault = Join-Path $VaultDir 'lab-access-client.dpapi.json'
$DeviceVault = Join-Path $VaultDir 'lab-staging-ten-tokens.dpapi'
$CryptoFile = Join-Path $PSScriptRoot 'maltworks-lab-vault-crypto.mjs'
$ExpectedBranch = 'test/staging-history-lab-free10-20261028'
$ExpectedAccount = '4e8c08f70722d344cf39c362a110d706'
$ExpectedServiceToken = '9b64b50b-5d45-472e-abdf-ac9d51e427bc'
$ExpectedHost = 'api-staging.maltworks.com.br'

function Read-Plain([Security.SecureString] $Secure) {
    $Ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Secure)
    try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($Ptr) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($Ptr) }
}

function Decode-DPAPI([string] $Cipher) {
    $Secure = ConvertTo-SecureString -String $Cipher
    try { return Read-Plain $Secure }
    finally { $Secure.Dispose() }
}

function Encode-DPAPI([string] $Plain) {
    $Secure = ConvertTo-SecureString -String $Plain -AsPlainText -Force
    try { return ConvertFrom-SecureString -SecureString $Secure }
    finally { $Secure.Dispose() }
}

function Validate-Bundle($Data) {
    if ($null -eq $Data -or
        $Data.account_id -cne $ExpectedAccount -or
        $Data.hostname -cne $ExpectedHost -or
        $Data.service_token_id -cne $ExpectedServiceToken -or
        $Data.client_id -notmatch '^[A-Za-z0-9.-]{12,255}\.access(\.[A-Za-z0-9.-]+)?$' -or
        $Data.client_secret -notmatch '^(cfast_[A-Za-z0-9]{48}|[A-Fa-f0-9]{64})$' -or
        $Data.admin_email -notmatch '^[^@\s]+@[^@\s]+\.[^@\s]+$') {
        throw 'Credencial de Access nao corresponde ao simulador isolado aprovado.'
    }
    $Props = @($Data.tokens.PSObject.Properties)
    if ($Props.Count -ne 10) { throw 'O pacote nao possui dez controladores.' }
    $Seen = New-Object 'System.Collections.Generic.HashSet[string]'
    for ($Index = 0; $Index -lt 10; $Index++) {
        $Id = [string]::Format('MW-C{0:D11}', $Index)
        $Prop = $Data.tokens.PSObject.Properties[$Id]
        if ($null -eq $Prop -or [string]$Prop.Value -notmatch '^[a-fA-F0-9]{64}$') {
            throw 'Token do Lab ausente ou invalido.'
        }
        if (-not $Seen.Add(([string]$Prop.Value).ToLowerInvariant())) {
            throw 'Tokens de controladores duplicados.'
        }
    }
}

function Read-Password([bool] $Confirm) {
    $Secure = Read-Host 'Senha forte de transferencia (20+ caracteres ASCII sem espacos)' -AsSecureString
    try { $Value = Read-Plain $Secure }
    finally { $Secure.Dispose() }
    if ($Value -cnotmatch '^[\x21-\x7E]{20,128}$') {
        throw 'Senha precisa ter 20-128 caracteres ASCII imprimiveis sem espacos.'
    }
    if ($Confirm) {
        $AgainSecure = Read-Host 'Repita a senha de transferencia' -AsSecureString
        try { $Again = Read-Plain $AgainSecure }
        finally { $AgainSecure.Dispose() }
        if ($Value -cne $Again) { throw 'Senhas nao coincidem.' }
        $Again = $null
    }
    return $Value
}

function Invoke-Crypto($Data) {
    $Json = ConvertTo-Json -InputObject $Data -Compress -Depth 10
    $Output = $Json | & node $CryptoFile
    if ($LASTEXITCODE -ne 0 -or -not $Output) {
        throw 'Falha de criptografia. Nenhum segredo foi exibido.'
    }
    return (($Output | Out-String) | ConvertFrom-Json)
}

Push-Location $Root
try {
    $CurrentBranch = (& git branch --show-current | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or $CurrentBranch -cne $ExpectedBranch) {
        throw 'Operacao permitida apenas na branch de homologacao do Maltworks Lab.'
    }
    if (-not (Test-Path -LiteralPath $CryptoFile)) {
        throw 'Modulo de criptografia do Lab nao encontrado.'
    }
    $VaultsExist = (Test-Path -LiteralPath $AccessVault) -and
                   (Test-Path -LiteralPath $DeviceVault)
    $VaultsMissing = (-not (Test-Path -LiteralPath $AccessVault)) -and
                     (-not (Test-Path -LiteralPath $DeviceVault))
    if ($Etapa -ceq 'Checar') {
        Write-Host ('Cofres DPAPI locais: ' + $(if ($VaultsExist) { 'ambos presentes' } elseif ($VaultsMissing) { 'ambos ausentes' } else { 'incompletos' }))
        Write-Host 'Checagem local concluida. Nenhuma credencial foi exportada ou alterada.'
        return
    }
    if ([string]::IsNullOrWhiteSpace($Arquivo)) { throw 'Informe -Arquivo com caminho completo do arquivo criptografado.' }
    $Full = [IO.Path]::GetFullPath($Arquivo)
    if ($Full.StartsWith(($Root.TrimEnd('\') + '\'), [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Nao grave bundles nem segredos dentro do repositorio Git.'
    }
    $Passphrase = $null
    $PlainPayload = $null
    $CryptoReply = $null
    try {
        if ($Etapa -ceq 'Exportar') {
            if (-not $VaultsExist) { throw 'Cofres DPAPI nao encontrados neste notebook. Nao ha o que exportar.' }
            if (Test-Path -LiteralPath $Full) { throw 'Arquivo de destino ja existe. Nao sobrescrever.' }
            $Access = Get-Content -LiteralPath $AccessVault -Raw | ConvertFrom-Json
            $PlainPayload = [pscustomobject]@{
                account_id = $Access.account_id
                hostname = $Access.hostname
                service_token_id = $Access.service_token_id
                admin_email = $Access.admin_email
                client_id = Decode-DPAPI $Access.client_id_dpapi
                client_secret = Decode-DPAPI $Access.client_secret_dpapi
                tokens = (Decode-DPAPI ((Get-Content -LiteralPath $DeviceVault -Raw).Trim()) | ConvertFrom-Json)
            }
            Validate-Bundle $PlainPayload
            $Passphrase = Read-Password $true
            $CryptoReply = Invoke-Crypto ([ordered]@{
                mode = 'seal'; passphrase = $Passphrase; payload = $PlainPayload
            })
            if ($CryptoReply.format -cne 'MALTWORKS_LAB_STAGING_PORTABLE_V1') {
                throw 'Envelope criptografado invalido.'
            }
            [IO.File]::WriteAllText($Full, ((ConvertTo-Json -InputObject $CryptoReply -Depth 5) + [Environment]::NewLine), [Text.UTF8Encoding]::new($false))
            Write-Host ('Arquivo criptografado criado: ' + $Full) -ForegroundColor Green
            Write-Host 'Leve-o ao desktop por USB ou armazenamento privado. Leve a senha por canal separado.'
        } elseif ($Etapa -ceq 'Importar') {
            if (-not $VaultsMissing) { throw 'Cofres ja existentes ou incompletos. Nao sobrescrever; audite antes.' }
            if (-not (Test-Path -LiteralPath $Full -PathType Leaf)) { throw 'Bundle criptografado nao encontrado.' }
            if ((Get-Item -LiteralPath $Full).Length -gt 65536) { throw 'Bundle criptografado muito grande.' }
            $Envelope = Get-Content -LiteralPath $Full -Raw | ConvertFrom-Json
            $Passphrase = Read-Password $false
            $PlainPayload = Invoke-Crypto ([ordered]@{
                mode = 'unseal'; passphrase = $Passphrase; envelope = $Envelope
            })
            Validate-Bundle $PlainPayload
            $ProtectedAccess = [ordered]@{
                account_id = $PlainPayload.account_id
                hostname = $PlainPayload.hostname
                service_token_id = $PlainPayload.service_token_id
                admin_email = $PlainPayload.admin_email
                client_id_dpapi = Encode-DPAPI $PlainPayload.client_id
                client_secret_dpapi = Encode-DPAPI $PlainPayload.client_secret
            }
            $ProtectedTokens = Encode-DPAPI (ConvertTo-Json -InputObject $PlainPayload.tokens -Compress -Depth 5)
            [void][IO.Directory]::CreateDirectory($VaultDir)
            $TempAccess = $AccessVault + '.tmp-' + [guid]::NewGuid().ToString('N')
            $TempDevices = $DeviceVault + '.tmp-' + [guid]::NewGuid().ToString('N')
            $WroteAccess = $false
            try {
                [IO.File]::WriteAllText($TempAccess, ((ConvertTo-Json -InputObject $ProtectedAccess -Depth 5) + [Environment]::NewLine), [Text.UTF8Encoding]::new($false))
                [IO.File]::WriteAllText($TempDevices, ($ProtectedTokens + [Environment]::NewLine), [Text.UTF8Encoding]::new($false))
                Move-Item -LiteralPath $TempAccess -Destination $AccessVault -ErrorAction Stop
                $WroteAccess = $true
                Move-Item -LiteralPath $TempDevices -Destination $DeviceVault -ErrorAction Stop
            } catch {
                if ($WroteAccess) { Remove-Item -LiteralPath $AccessVault -Force -ErrorAction SilentlyContinue }
                throw
            } finally {
                Remove-Item -LiteralPath $TempAccess, $TempDevices -Force -ErrorAction SilentlyContinue
            }
            Write-Host 'Dois cofres DPAPI recriados para este usuario do desktop.' -ForegroundColor Green
            Write-Host 'O pacote criptografado deve ser apagado apos confirmar o teste de acesso.'
        }
    } finally {
        $Passphrase = $null
        $PlainPayload = $null
        $CryptoReply = $null
    }
} finally {
    Pop-Location
}
