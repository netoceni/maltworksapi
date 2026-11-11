param([switch] $VerifyOnly)

# Local preparation only. No network, Wrangler, uploads, or deployment commands.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$VerbosePreference = 'SilentlyContinue'
$DebugPreference = 'SilentlyContinue'

$AccountId = '4e8c08f70722d344cf39c362a110d706'
$WorkerName = 'maltworks-api-staging'
$DatabaseId = '5151e251-52c1-4406-8ae9-c6d38961d124'
$Names = @('PASSWORD_PEPPER', 'PASSWORD_RESET_SECRET', 'BOOTSTRAP_SECRET')
$Format = 'maltworks-app-staging-secrets-dpapi-v1'
$ConfigFile = Join-Path (Split-Path -Parent $PSScriptRoot) 'wrangler.app-staging.jsonc'
$VaultDir = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Maltworks\api-staging'
$VaultFile = Join-Path $VaultDir 'api-staging-secrets.dpapi.json'
$PlainBytes = $null
$RoundTripBytes = $null
$Secrets = $null
$Created = $false

function Assert-PrivateAcl([string] $Path, [string] $UserSid) {
    $Acl = Get-Acl -LiteralPath $Path
    $Owner = $Acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
    if ($Owner -ne $UserSid) { throw 'Vault owner does not match the Windows user.' }
    foreach ($Rule in $Acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) {
        if ($Rule.AccessControlType -eq 'Allow' -and $Rule.IdentityReference.Value -notin @($UserSid, 'S-1-5-18')) {
            throw 'Vault ACL grants access to an unexpected identity.'
        }
    }
}

try {
    Add-Type -AssemblyName System.Security
    $Config = Get-Content -LiteralPath $ConfigFile -Raw | ConvertFrom-Json
    if ($Config.account_id -ne $AccountId -or $Config.name -ne $WorkerName -or
        @($Config.d1_databases).Count -ne 1 -or $Config.d1_databases[0].database_id -ne $DatabaseId -or
        $Config.d1_databases[0].database_name -ne 'maltworks-app-staging' -or
        $Config.workers_dev -ne $false -or $Config.preview_urls -ne $false -or @($Config.routes).Count -ne 0) {
        throw 'Private staging target did not pass validation.'
    }
    $User = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
    $Entropy = [Text.Encoding]::UTF8.GetBytes("$Format|$AccountId|$WorkerName|$DatabaseId")
    $BaseDir = Split-Path -Parent $VaultDir
    foreach ($Path in @($BaseDir, $VaultDir, $VaultFile)) {
        if ((Test-Path -LiteralPath $Path) -and
            ((Get-Item -LiteralPath $Path).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            throw 'Refusing a redirected vault path.'
        }
    }
    if (-not (Test-Path -LiteralPath $VaultFile)) {
        if ($VerifyOnly) { throw 'Vault is not prepared.' }
        [void](New-Item -ItemType Directory -Path $VaultDir -Force)
        $Acl = New-Object System.Security.AccessControl.DirectorySecurity
        $Acl.SetAccessRuleProtection($true, $false)
        $Acl.SetOwner($User)
        foreach ($Sid in @($User, (New-Object System.Security.Principal.SecurityIdentifier('S-1-5-18')))) {
            $Rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
                $Sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
            [void]$Acl.AddAccessRule($Rule)
        }
        Set-Acl -LiteralPath $VaultDir -AclObject $Acl
        Assert-PrivateAcl $VaultDir $User.Value
        $Rng = [Security.Cryptography.RandomNumberGenerator]::Create()
        try {
            $Secrets = [ordered]@{}
            foreach ($Name in $Names) {
                $Buffer = New-Object byte[] 32
                try {
                    $Rng.GetBytes($Buffer)
                    $Secrets[$Name] = [Convert]::ToBase64String($Buffer).TrimEnd('=').Replace('+', '-').Replace('/', '_')
                } finally { [Array]::Clear($Buffer, 0, $Buffer.Length) }
            }
        } finally { $Rng.Dispose() }
        $PlainBytes = [Text.Encoding]::UTF8.GetBytes(($Secrets | ConvertTo-Json -Compress))
        $Cipher = [Security.Cryptography.ProtectedData]::Protect(
            $PlainBytes, $Entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)
        $Envelope = [ordered]@{
            format = $Format
            account_id = $AccountId
            worker_name = $WorkerName
            database_id = $DatabaseId
            created_at = [DateTime]::UtcNow.ToString('o')
            protection = 'Windows DPAPI CurrentUser'
            secret_names = $Names
            encrypted_payload = [Convert]::ToBase64String($Cipher)
        }
        $EnvelopeBytes = [Text.Encoding]::UTF8.GetBytes(($Envelope | ConvertTo-Json -Depth 4))
        $Stream = [IO.File]::Open($VaultFile, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
        try { $Stream.Write($EnvelopeBytes, 0, $EnvelopeBytes.Length) } finally { $Stream.Dispose() }
        $Created = $true
    }
    Assert-PrivateAcl $VaultDir $User.Value
    Assert-PrivateAcl $VaultFile $User.Value
    $Envelope = Get-Content -LiteralPath $VaultFile -Raw | ConvertFrom-Json
    if ($Envelope.format -ne $Format -or $Envelope.account_id -ne $AccountId -or
        $Envelope.worker_name -ne $WorkerName -or $Envelope.database_id -ne $DatabaseId -or
        $Envelope.protection -ne 'Windows DPAPI CurrentUser' -or
        (@($Envelope.secret_names) -join ',') -cne ($Names -join ',')) {
        throw 'Encrypted vault metadata did not pass validation.'
    }
    $RoundTripBytes = [Security.Cryptography.ProtectedData]::Unprotect(
        [Convert]::FromBase64String($Envelope.encrypted_payload), $Entropy,
        [Security.Cryptography.DataProtectionScope]::CurrentUser)
    if ($null -ne $PlainBytes) {
        if ($PlainBytes.Length -ne $RoundTripBytes.Length) { throw 'Round-trip failed.' }
        $Difference = 0
        for ($Index = 0; $Index -lt $PlainBytes.Length; $Index++) {
            $Difference = $Difference -bor ($PlainBytes[$Index] -bxor $RoundTripBytes[$Index])
        }
        if ($Difference -ne 0) { throw 'Round-trip failed.' }
    }
    $Payload = [Text.Encoding]::UTF8.GetString($RoundTripBytes) | ConvertFrom-Json
    if ((@($Payload.PSObject.Properties.Name | Sort-Object) -join ',') -cne (@($Names | Sort-Object) -join ',')) {
        throw 'Unexpected secret keys.'
    }
    $Values = @($Names | ForEach-Object { [string]$Payload.$_ })
    if (@($Values | Where-Object { $_ -cnotmatch '^[A-Za-z0-9_-]{43}$' }).Count -ne 0 -or
        @($Values | Sort-Object -Unique).Count -ne 3) { throw 'Secret validation failed.' }
    # Compare in memory. Never put secret values in command arguments or messages.
    $Repo = Split-Path -Parent $PSScriptRoot
    $StagedDiff = (& git -C $Repo diff --cached --no-ext-diff --no-textconv --text -- | Out-String)
    if ($LASTEXITCODE -ne 0) { throw 'Could not inspect the Git index safely.' }
    foreach ($Value in $Values) {
        if ($StagedDiff.Contains($Value)) { throw 'Secret material detected in the Git index.' }
    }
    [pscustomobject]@{
        created_now = $Created
        validated = $true
        account_id = $AccountId
        worker_name = $WorkerName
        database_id = $DatabaseId
        created_at = $Envelope.created_at
        secret_names = $Names
        independent_random_bits_per_secret = 256
        protection = 'Windows DPAPI CurrentUser'
        private_acl_verified = $true
        decrypt_round_trip_verified = $true
        code_minimum_lengths_met = $true
        plaintext_file_written = $false
        values_displayed = $false
        cloudflare_upload_performed = $false
        git_index_secret_scan_passed = $true
        vault_reference = '%LOCALAPPDATA%\Maltworks\api-staging\api-staging-secrets.dpapi.json'
    } | ConvertTo-Json -Depth 4
} catch {
    # Never include exception payloads: JSON parsing errors can contain secret text.
    throw 'Staging secret preparation/verification failed. No values were displayed. Do not rotate or overwrite an existing vault.'
} finally {
    if ($null -ne $PlainBytes) { [Array]::Clear($PlainBytes, 0, $PlainBytes.Length) }
    if ($null -ne $RoundTripBytes) { [Array]::Clear($RoundTripBytes, 0, $RoundTripBytes.Length) }
    $Secrets = $null; $Payload = $null; $Values = $null
}
