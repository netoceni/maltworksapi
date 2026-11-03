# Maltworks 5.19 - staging-only WebSocket / RealtimeHub homologation.
# Checar: validates identity and Access GET /health, no WS connection.
# TestarUm: opens one authenticated device socket, checks ready, ping/pong, heartbeat/ack.
# TestarDez: opens ten sockets and checks 3 heartbeats/device at a measured 30s cadence.
# NEVER deploys, migrates, writes D1 directly, or touches production endpoints.
[CmdletBinding()]
param(
    [ValidateSet("Checar", "TestarUm", "TestarDez")]
    [string] $Etapa = "Checar"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$Root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$Branch = "test/staging-history-lab-free10-20261028"
$WorkerName = "maltworks-api-lab-staging"
$DbId = "26b9ecab-1aaa-4120-93a5-1c409555d28b"
$AccountId = "4e8c08f70722d344cf39c362a110d706"
$AccessTokenId = "9b64b50b-5d45-472e-abdf-ac9d51e427bc"
$HostName = "api-staging.maltworks.com.br"
$WsEndpoint = [uri]"wss://api-staging.maltworks.com.br/v1/device/realtime"
$VaultDir = Join-Path ([Environment]::GetFolderPath("LocalApplicationData")) "Maltworks"
$AccessVault = Join-Path $VaultDir "lab-access-client.dpapi.json"
$DeviceVault = Join-Path $VaultDir "lab-staging-ten-tokens.dpapi"
$ConfigPath = Join-Path $Root "wrangler.lab-staging.jsonc"

function Desproteger-Valor([string] $CipherText) {
    $Secure = ConvertTo-SecureString -String $CipherText
    $Handle = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Secure)
    try {
        return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($Handle)
    } finally {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($Handle)
        $Secure.Dispose()
    }
}

function Receber-Evento([System.Net.WebSockets.ClientWebSocket] $Socket) {
    $Buffer = New-Object byte[] 4096
    $Part = [System.ArraySegment[byte]]::new($Buffer)
    $Data = [System.IO.MemoryStream]::new()
    $Cancel = [System.Threading.CancellationTokenSource]::new(12000)
    try {
        do {
            $Received = $Socket.ReceiveAsync($Part, $Cancel.Token).GetAwaiter().GetResult()
            if ($Received.MessageType -ne [System.Net.WebSockets.WebSocketMessageType]::Text) {
                throw "WebSocket nao retornou evento de texto."
            }
            $Data.Write($Buffer, 0, $Received.Count)
            if ($Data.Length -gt 4096) {
                throw "Evento WebSocket maior que 4096 bytes."
            }
        } until ($Received.EndOfMessage)

        $Payload = [System.Text.Encoding]::UTF8.GetString($Data.ToArray())
        $Event = ConvertFrom-Json -InputObject $Payload
        if ($null -eq $Event -or -not $Event.PSObject.Properties["type"]) {
            throw "Evento WebSocket sem campo type."
        }
        return $Event
    } finally {
        $Cancel.Dispose()
        $Data.Dispose()
    }
}

function Aguardar-Evento(
    [System.Net.WebSockets.ClientWebSocket] $Socket,
    [string] $Tipo
) {
    # Pending commands may arrive before ready. Never ACK or execute them.
    for ($Attempt = 0; $Attempt -lt 6; $Attempt++) {
        $Event = Receber-Evento $Socket
        if ($Event.type -ceq $Tipo) { return $Event }
        if ($Event.type -ceq "command") {
            [void]($script:ComandosPendentes++)
            continue
        }
        throw ("Evento inesperado no WebSocket: " + [string]$Event.type)
    }
    throw ("Nao recebemos o evento esperado: " + $Tipo)
}

function Enviar-Evento(
    [System.Net.WebSockets.ClientWebSocket] $Socket,
    [string] $Json
) {
    $Bytes = [System.Text.Encoding]::UTF8.GetBytes($Json)
    $Segment = [System.ArraySegment[byte]]::new($Bytes)
    $Cancel = [System.Threading.CancellationTokenSource]::new(12000)
    try {
        $Socket.SendAsync(
            $Segment,
            [System.Net.WebSockets.WebSocketMessageType]::Text,
            $true,
            $Cancel.Token
        ).GetAwaiter().GetResult()
    } finally {
        $Cancel.Dispose()
    }
}

function Abrir-Dispositivo(
    [string] $DeviceId,
    [string] $DeviceToken,
    [string] $ClientId,
    [string] $ClientSecret
) {
    $Socket = [System.Net.WebSockets.ClientWebSocket]::new()
    try {
        $Socket.Options.SetRequestHeader("CF-Access-Client-Id", $ClientId)
        $Socket.Options.SetRequestHeader("CF-Access-Client-Secret", $ClientSecret)
        $Socket.Options.SetRequestHeader("Authorization", ("Bearer " + $DeviceToken))
        $Socket.Options.SetRequestHeader("X-Maltworks-Device-ID", $DeviceId)
        $Socket.Options.SetRequestHeader("X-Maltworks-Firmware", "5.5.2-lab")
        $Cancel = [System.Threading.CancellationTokenSource]::new(15000)
        try {
            $Socket.ConnectAsync($WsEndpoint, $Cancel.Token).GetAwaiter().GetResult()
        } finally {
            $Cancel.Dispose()
        }
        if ($Socket.State -ne [System.Net.WebSockets.WebSocketState]::Open) {
            throw "WebSocket nao foi aberto."
        }
        $Ready = Aguardar-Evento $Socket "ready"
        if ($Ready.role -cne "device" -or
            [int]$Ready.offlineAfterSeconds -ne 90) {
            throw "Resposta ready nao corresponde ao protocolo esperado."
        }
        # Suppress any incidental pipeline output: return exactly one handle.
        Write-Output -NoEnumerate -InputObject $Socket
    } catch {
        $Socket.Dispose()
        throw ("Falha no upgrade WebSocket/autenticacao de " + $DeviceId + ". Sem envio de telemetria.")
    }
}

function Fechar-Socket([System.Net.WebSockets.ClientWebSocket] $Socket) {
    if ($null -eq $Socket) { return }
    try {
        if ($Socket.State -eq [System.Net.WebSockets.WebSocketState]::Open) {
            $Cancel = [System.Threading.CancellationTokenSource]::new(3000)
            try {
                $Socket.CloseAsync(
                    [System.Net.WebSockets.WebSocketCloseStatus]::NormalClosure,
                    "Lab test complete",
                    $Cancel.Token
                ).GetAwaiter().GetResult()
            } finally {
                $Cancel.Dispose()
            }
        }
    } catch {
        # Always dispose, including if the close handshake timed out.
    } finally {
        $Socket.Dispose()
    }
}

Push-Location $Root
$Connections = [System.Collections.Generic.Dictionary[string,System.Net.WebSockets.ClientWebSocket]]::new()
$DeviceTokens = $null
$PlainTokens = $null
$ClientId = $null
$ClientSecret = $null
$script:ComandosPendentes = 0
try {
    $CurrentBranch = (& git branch --show-current | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or $CurrentBranch -cne $Branch) {
        throw "Branch nao corresponde a homologacao. Nenhum WS aberto."
    }

    if (-not (Test-Path -LiteralPath $ConfigPath)) {
        throw "Configuracao de staging nao encontrada."
    }
    & node (Join-Path $Root "scripts\maltworks-lab-stage-preflight.mjs") $ConfigPath
    if ($LASTEXITCODE -ne 0) { throw "Preflight de isolamento reprovado." }
    $Cfg = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
    if ($Cfg.name -cne $WorkerName -or
        $Cfg.d1_databases.Count -ne 1 -or
        $Cfg.d1_databases[0].database_id -cne $DbId -or
        $Cfg.d1_databases[0].database_name -cne "maltworks-lab-staging" -or
        $Cfg.vars.LAB_STAGING_ROLLUP_ONLY -cne "true" -or
        $Cfg.vars.TELEMETRY_RETENTION_DAYS -cne "0" -or
        $Cfg.vars.HISTORY_5MIN_RETENTION_DAYS -cne "0" -or
        $Cfg.vars.HISTORY_HOURLY_RETENTION_DAYS -cne "0") {
        throw "Staging incorreto ou retencao ativa. Nenhum WS aberto."
    }
    if (-not (Test-Path -LiteralPath $AccessVault) -or
        -not (Test-Path -LiteralPath $DeviceVault)) {
        throw "Credenciais DPAPI locais indisponiveis."
    }

    $Vault = Get-Content -LiteralPath $AccessVault -Raw | ConvertFrom-Json
    if ($Vault.account_id -cne $AccountId -or
        $Vault.hostname -cne $HostName -or
        $Vault.service_token_id -cne $AccessTokenId) {
        throw "Service Token nao e o aprovado para staging."
    }
    $ClientId = Desproteger-Valor $Vault.client_id_dpapi
    $ClientSecret = Desproteger-Valor $Vault.client_secret_dpapi
    if ($ClientId -notmatch '^[A-Za-z0-9.-]{12,255}\.access(\.[A-Za-z0-9.-]+)?$' -or
        $ClientSecret -notmatch '^(cfast_[A-Za-z0-9]{48}|[A-Fa-f0-9]{64})$') {
        throw "Credencial Access invalida."
    }

    $Headers = @{
        "CF-Access-Client-Id" = $ClientId
        "CF-Access-Client-Secret" = $ClientSecret
    }
    try {
        $Health = Invoke-RestMethod -Uri ("https://" + $HostName + "/health") -Method Get -Headers $Headers -MaximumRedirection 0 -TimeoutSec 15 -ErrorAction Stop
    } catch {
        throw "Autenticacao Access /health nao confirmada."
    } finally {
        $Headers = $null
    }
    if ($Health.ok -ne $true -or $Health.version -cne "5.19.0") {
        throw "Worker ou versao nao corresponde ao ambiente de teste."
    }

    Write-Host "Preflight WS: staging isolado, Access e API 5.19.0 aprovados." -ForegroundColor Green
    if ($Etapa -ceq "Checar") {
        Write-Host "Sem conexoes WebSocket abertas; nenhuma telemetria transmitida."
        return
    }

    $PlainTokens = Desproteger-Valor ((Get-Content -LiteralPath $DeviceVault -Raw).Trim())
    $Tokens = ConvertFrom-Json -InputObject $PlainTokens
    $DeviceCount = if ($Etapa -ceq "TestarDez") { 10 } else { 1 }
    $DeviceTokens = [ordered]@{}
    $Seen = New-Object 'System.Collections.Generic.HashSet[string]'
    for ($Index = 0; $Index -lt $DeviceCount; $Index++) {
        $Id = [string]::Format("MW-C{0:D11}", $Index)
        $Property = $Tokens.PSObject.Properties[$Id]
        if ($null -eq $Property -or
            [string]$Property.Value -notmatch '^[a-fA-F0-9]{64}$') {
            throw "Token de dispositivo faltando ou invalido."
        }
        $Token = ([string]$Property.Value).ToLowerInvariant()
        if (-not $Seen.Add($Token)) { throw "Tokens duplicados." }
        $DeviceTokens[$Id] = $Token
        $Token = $null
    }

    $ConfirmText = if ($Etapa -ceq "TestarDez") { "ABRIR 10 WS LAB" } else { "ABRIR 1 WS LAB" }
    Write-Host "Destino exclusivo: $WsEndpoint"
    Write-Host "O upgrade autentica cada dispositivo e atualiza a presenca no DO de staging."
    Write-Host "TestarDez: 10 conexoes simultaneas e 3 heartbeats/dispositivo, a cada 30s."
    $Confirm = Read-Host ("Digite exatamente " + $ConfirmText)
    if ($Confirm -cne $ConfirmText) {
        throw "Operacao cancelada sem abrir WebSocket."
    }

    foreach ($Id in $DeviceTokens.Keys) {
        $Opened = @(Abrir-Dispositivo $Id $DeviceTokens[$Id] $ClientId $ClientSecret)
        if ($Opened.Count -ne 1 -or
            $Opened[0] -isnot [System.Net.WebSockets.ClientWebSocket]) {
            # No secret values or headers in diagnostic output.
            $Types = (@($Opened | ForEach-Object {
                if ($null -eq $_) { "null" } else { $_.GetType().Name }
            })) -join ","
            foreach ($Value in $Opened) {
                if ($Value -is [System.Net.WebSockets.ClientWebSocket]) {
                    Fechar-Socket $Value
                }
            }
            throw ("Abertura retornou formato inesperado de " + $Id +
                ": quantidade=" + $Opened.Count + "; tipos=" + $Types)
        }
        $Connections.Add($Id, [System.Net.WebSockets.ClientWebSocket]$Opened[0])
    }
    $PlainTokens = $null
    $Tokens = $null
    $DeviceTokens = $null

    if ($Etapa -ceq "TestarUm") {
        [System.Net.WebSockets.ClientWebSocket]$Socket = $Connections["MW-C00000000000"]
        Enviar-Evento $Socket '{"type":"ping"}'
        $Pong = Aguardar-Evento $Socket "pong"
        Enviar-Evento $Socket '{"type":"heartbeat"}'
        $Ack = Aguardar-Evento $Socket "heartbeat_ack"
        $Report = [ordered]@{
            environment = "staging"
            devices = 1
            opened = 1
            ready = 1
            pongs = 1
            heartbeat_acks = 1
            offline_after_seconds = 90
            result = "passed"
        }
    } else {
        $Clock = [System.Diagnostics.Stopwatch]::StartNew()
        $TickStarts = New-Object 'System.Collections.Generic.List[double]'
        $AckCount = 0

        for ($Tick = 0; $Tick -lt 3; $Tick++) {
            $WaitMs = [int][Math]::Ceiling(($Tick * 30000) - $Clock.Elapsed.TotalMilliseconds)
            if ($WaitMs -gt 0) { Start-Sleep -Milliseconds $WaitMs }

            $TickStarts.Add($Clock.Elapsed.TotalMilliseconds)
            foreach ($Socket in $Connections.Values) {
                Enviar-Evento $Socket '{"type":"heartbeat"}'
            }
            foreach ($Socket in $Connections.Values) {
                $Ack = Aguardar-Evento $Socket "heartbeat_ack"
                $AckCount++
            }
        }
        $Clock.Stop()
        $FirstGap = $TickStarts[1] - $TickStarts[0]
        $SecondGap = $TickStarts[2] - $TickStarts[1]
        $Minimum = [Math]::Min($FirstGap, $SecondGap)
        $Maximum = [Math]::Max($FirstGap, $SecondGap)
        $CadenceOk = ($Minimum -ge 28000 -and $Maximum -le 32000)

        $Report = [ordered]@{
            environment = "staging"
            devices = 10
            opened = $Connections.Count
            ready = $Connections.Count
            heartbeat_acks = $AckCount
            elapsed_ms = [int][Math]::Round($Clock.Elapsed.TotalMilliseconds)
            tick_interval_average_ms = [int][Math]::Round(($FirstGap + $SecondGap) / 2)
            tick_interval_min_ms = [int][Math]::Round($Minimum)
            tick_interval_max_ms = [int][Math]::Round($Maximum)
            cadence_valid = $CadenceOk
            pending_commands_seen = $script:ComandosPendentes
            result = if ($AckCount -eq 30 -and $CadenceOk) { "passed" } else { "failed" }
        }
    }

    $Json = $Report | ConvertTo-Json -Depth 5
    Write-Host $Json
    $LocalReport = Join-Path $VaultDir "lab-websocket-last.json"
    [System.IO.File]::WriteAllText(
        $LocalReport,
        ($Json + [Environment]::NewLine),
        (New-Object System.Text.UTF8Encoding($false))
    )
    Write-Host ("Relatorio local: " + $LocalReport) -ForegroundColor Green
    if ($Report.result -cne "passed") { throw "Critérios WS nao atendidos." }

} finally {
    foreach ($Socket in $Connections.Values) {
        if ($Socket -is [System.Net.WebSockets.ClientWebSocket]) {
            Fechar-Socket $Socket
        }
    }
    $ClientId = $null
    $ClientSecret = $null
    $PlainTokens = $null
    $DeviceTokens = $null
    Pop-Location
}
