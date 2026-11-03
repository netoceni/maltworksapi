# Maltworks Lab: 30-minute integrated 10-device WS+HTTP staging soak.
# Checar: preflight only. Executar30Min: explicit confirmation.
# Fixed outage at ticks 30..34 for device zero in BOTH protocols.
# Never deploys, migrates or targets production.
[CmdletBinding()]
param(
    [ValidateSet("Checar", "Executar30Min")]
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
        $null = $Socket.SendAsync(
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
            $null = $Socket.ConnectAsync($WsEndpoint, $Cancel.Token).GetAwaiter().GetResult()
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
        # ConnectAsync task results (VoidTaskResult) must not leak into the
        # function output; only the ClientWebSocket handle is returned.
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
                $null = $Socket.CloseAsync(
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



function Obter-D1 {
    $Raw = & npx.cmd wrangler d1 info maltworks-lab-staging --config $ConfigPath --json
    if ($LASTEXITCODE -ne 0) { throw "Consulta de metadados D1 falhou." }
    $Info = ($Raw | Out-String) | ConvertFrom-Json
    if ($Info.uuid -cne $DbId -or $Info.name -cne "maltworks-lab-staging") {
        throw "Identidade D1 inesperada."
    }
    return $Info
}

function Campo($Object, [string] $Name) {
    $P = $Object.PSObject.Properties[$Name]
    if ($null -eq $P) { return $null }
    return $P.Value
}

function Ler-Estados([long] $FromUtc) {
    # One SQL SELECT only. No --file import, no DML or hidden parameters.
    $Sql = "SELECT d.id AS id, COALESCE(ns.active,0) AS offline, COALESCE(s.sequence,0) AS seq, (SELECT COUNT(*) FROM notifications n WHERE n.device_id=d.id AND n.type='device_online' AND n.created_at >= $FromUtc) AS online_events, (SELECT COUNT(*) FROM notifications n WHERE n.device_id=d.id AND n.type='device_offline' AND n.created_at >= $FromUtc) AS offline_events, (SELECT COUNT(*) FROM telemetry t WHERE t.device_id=d.id AND t.received_at >= $FromUtc) AS raw_samples FROM devices d LEFT JOIN notification_states ns ON ns.device_id=d.id AND ns.type='offline' LEFT JOIN device_latest_state s ON s.device_id=d.id WHERE d.id BETWEEN 'MW-C00000000000' AND 'MW-C00000000009' ORDER BY d.id;"
    $Raw = & npx.cmd wrangler d1 execute maltworks-lab-staging --remote --config $ConfigPath --json --command $Sql
    if ($LASTEXITCODE -ne 0) { throw "Consulta D1 de estados falhou. Nao repetir o ensaio." }
    $Reply = @(($Raw | Out-String | ConvertFrom-Json))
    if ($Reply.Count -ne 1 -or $Reply[0].success -ne $true) {
        throw "Resposta JSON do D1 inesperada."
    }
    $Rows = @($Reply[0].results)
    if ($Rows.Count -ne 10) { throw "D1 nao retornou 10 dispositivos." }
    for ($i = 0; $i -lt 10; $i++) {
        if ($Rows[$i].id -cne [string]::Format("MW-C{0:D11}", $i)) {
            throw "Identidade de controlador inesperada na consulta."
        }
    }
    return $Rows
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
        $Cfg.d1_databases[0].binding -cne "DB" -or
        $Cfg.workers_dev -ne $false -or
        $Cfg.preview_urls -ne $false -or
        $Cfg.vars.TELEMETRY_PERSIST_INTERVAL_SECONDS -cne "180" -or
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

    $null = Obter-D1
    Write-Host "Preflight integrado: staging, Access, API 5.19.0 e D1 aprovados." -ForegroundColor Green
    if ($Etapa -ceq "Checar") {
        Write-Host "Checagem concluida, sem WS e sem telemetria HTTP."
        return
    }


    $PlainTokens = Desproteger-Valor ((Get-Content -LiteralPath $DeviceVault -Raw).Trim())
    $Tokens = ConvertFrom-Json -InputObject $PlainTokens
    $DeviceTokens = [ordered]@{}
    $Seen = New-Object 'System.Collections.Generic.HashSet[string]'
    for ($i = 0; $i -lt 10; $i++) {
        $Id = [string]::Format("MW-C{0:D11}", $i)
        $Prop = $Tokens.PSObject.Properties[$Id]
        if ($null -eq $Prop -or [string]$Prop.Value -notmatch '^[a-fA-F0-9]{64}$') {
            throw "Token de controlador ausente ou invalido."
        }
        $Token = ([string]$Prop.Value).ToLowerInvariant()
        if (-not $Seen.Add($Token)) { throw "Tokens duplicados." }
        $DeviceTokens[$Id] = $Token
        $Token = $null
    }

    Write-Host "Integrado: 10 WS + 10 HTTP, 60 ticks de 30 segundos." -ForegroundColor Yellow
    Write-Host "Falha controlada: dispositivo 00 sem WS/HTTP nos ticks 30..34."
    Write-Host "Previsao: 595 heartbeats confirmados, 595 HTTP aceitos, 5 omissoes em cada canal."
    Write-Host "Nao executar outra simulacao em paralelo. Nao repetir automaticamente em caso de erro."
    $Confirm = Read-Host "Digite exatamente EXECUTAR 30MIN WS HTTP LAB"
    if ($Confirm -cne "EXECUTAR 30MIN WS HTTP LAB") {
        throw "Ensaio cancelado sem conexoes WebSocket."
    }

    $BeforeInfo = Obter-D1
    $Start = [DateTimeOffset]::UtcNow
    $FromUtc = [long]($Start.ToUnixTimeSeconds() - 2)
    $Before = @(Ler-Estados $FromUtc)
    $Mid = $null
    $Recovered = $null
    $After = $null
    $AfterInfo = $null
    $HttpReport = $null
    $HttpExitCode = $null
    $HttpLastProgress = $null
    $HttpLastStarted = $null
    $HttpFailureSummary = $null
    $HttpErrorLog = $null
    $HttpOutputLog = $null
    $Process = $null
    $Timer = $null
    $AckCount = 0
    $OmittedWS = 0
    $LagMax = 0.0
    $GapMin = [double]::PositiveInfinity
    $GapMax = 0.0
    $GapSum = 0.0
    $Previous = $null
    $CadenceOk = $true
    $RunStatus = "failed"
    $RunId = [guid]::NewGuid().ToString("N")
    $OutputFile = Join-Path $env:TEMP ("maltworks-soak-" + $RunId + ".out")
    $ErrorFile = Join-Path $env:TEMP ("maltworks-soak-" + $RunId + ".err")
    $ReportFile = Join-Path $VaultDir "lab-soak-30min-last.json"

    try {
        foreach ($Id in $DeviceTokens.Keys) {
            $Opened = @(Abrir-Dispositivo $Id $DeviceTokens[$Id] $ClientId $ClientSecret)
            if ($Opened.Count -ne 1 -or $Opened[0] -isnot [System.Net.WebSockets.ClientWebSocket]) {
                throw "WebSocket nao retornou um socket valido."
            }
            $Connections.Add($Id, [System.Net.WebSockets.ClientWebSocket]$Opened[0])
        }

        # Inherited environment is process-local; no credentials on command line.
        $Names = @("MALTWORKS_LAB_STAGING_TOKENS_JSON", "CF_ACCESS_CLIENT_ID", "CF_ACCESS_CLIENT_SECRET")
        $Saved = @{}
        foreach ($Name in $Names) {
            $Saved[$Name] = [Environment]::GetEnvironmentVariable($Name, "Process")
        }
        try {
            $env:MALTWORKS_LAB_STAGING_TOKENS_JSON = ConvertTo-Json -InputObject $DeviceTokens -Compress
            $env:CF_ACCESS_CLIENT_ID = $ClientId
            $env:CF_ACCESS_CLIENT_SECRET = $ClientSecret
            $NodeFile = Join-Path $Root "scripts\maltworks-lab-staging.mjs"
            $NodeArgs = @(
                ('"' + $NodeFile + '"'),
                "--send", "--endpoint", "https://api-staging.maltworks.com.br/v1/telemetry",
                "--devices", "10", "--ticks", "60", "--scenario", "normal",
                "--pace-ms", "30000", "--soak-outage"
            )
            $NodePath = (Get-Command node -ErrorAction Stop).Source
            $Process = Start-Process -FilePath $NodePath -ArgumentList $NodeArgs -WorkingDirectory $Root -RedirectStandardOutput $OutputFile -RedirectStandardError $ErrorFile -PassThru -NoNewWindow
            if ($null -eq $Process -or $Process.Id -le 0) { throw "Emissor HTTP nao iniciou." }
        } finally {
            foreach ($Name in $Names) {
                [Environment]::SetEnvironmentVariable($Name, $Saved[$Name], "Process")
            }
            $PlainTokens = $null
            $Tokens = $null
            $DeviceTokens = $null
        }

        $Timer = [System.Diagnostics.Stopwatch]::StartNew()
        for ($Tick = 0; $Tick -lt 60; $Tick++) {
            if ($Tick -gt 0) {
                $Remain = [int][Math]::Ceiling($Tick * 30000 - $Timer.Elapsed.TotalMilliseconds)
                if ($Remain -gt 0) { Start-Sleep -Milliseconds $Remain }
            }
            if ($Process.HasExited -and $Tick -lt 59) {
                throw "Emissor HTTP encerrou prematuramente. Nao reiniciar."
            }
            $AtMs = $Timer.Elapsed.TotalMilliseconds
            $Lag = [Math]::Max(0, $AtMs - $Tick * 30000)
            $LagMax = [Math]::Max($LagMax, $Lag)
            if ($Lag -gt 2000) { $CadenceOk = $false }
            if ($null -ne $Previous) {
                $Gap = $AtMs - $Previous
                $GapMin = [Math]::Min($GapMin, $Gap)
                $GapMax = [Math]::Max($GapMax, $Gap)
                $GapSum += $Gap
                if ([Math]::Abs($Gap - 30000) -gt 2000) { $CadenceOk = $false }
            }
            $Previous = $AtMs

            foreach ($Entry in $Connections.GetEnumerator()) {
                if ($Entry.Key -ceq "MW-C00000000000" -and $Tick -ge 30 -and $Tick -le 34) {
                    $OmittedWS++
                    continue
                }
                Enviar-Evento $Entry.Value '{"type":"heartbeat"}'
            }
            foreach ($Entry in $Connections.GetEnumerator()) {
                if ($Entry.Key -ceq "MW-C00000000000" -and $Tick -ge 30 -and $Tick -le 34) { continue }
                $Ack = Aguardar-Evento $Entry.Value "heartbeat_ack"
                $AckCount++
            }
            if ($Tick -eq 34) {
                $Mid = @(Ler-Estados $FromUtc)
                if ([int]$Mid[0].offline -ne 1 -or [int]$Mid[0].offline_events -ne 1) {
                    throw "Alarme offline do controlador 00 nao foi detectado."
                }
                for ($i = 1; $i -lt 10; $i++) {
                    if ([int]$Mid[$i].offline -ne 0 -or [int]$Mid[$i].offline_events -ne 0) {
                        throw "Um dos nove controladores normais apresentou falso offline."
                    }
                }
                Write-Host "Tick 35/60: um offline confirmado, outros nove continuam online."
            }
            if ($Tick -eq 36) {
                $Recovered = @(Ler-Estados $FromUtc)
                if ([int]$Recovered[0].offline -ne 0 -or
                    [int]$Recovered[0].online_events -ne ([int]$Mid[0].online_events + 1)) {
                    throw "Recuperacao unica do controlador 00 nao foi comprovada."
                }
                for ($i = 1; $i -lt 10; $i++) {
                    if ([int]$Recovered[$i].offline -ne 0 -or [int]$Recovered[$i].offline_events -ne 0) {
                        throw "Presenca de outro dispositivo ficou instavel."
                    }
                }
                Write-Host "Tick 37/60: controlador 00 recuperado com um evento online."
            }
            if ($Tick -in @(0, 9, 19, 29, 39, 49, 59)) {
                Write-Host ("Progresso " + ($Tick + 1) + "/60; ACK WS=" + $AckCount)
            }
        }

        if (-not $Process.WaitForExit(20000)) { throw "HTTP nao concluiu; nao repetir sem auditoria." }
        $HttpExitCode = $Process.ExitCode
        if ($HttpExitCode -ne 0) {
            throw ("Emissor HTTP falhou (codigo " + $HttpExitCode + "); nao repetir sem auditoria.")
        }
        $HttpReport = (Get-Content -LiteralPath $OutputFile -Raw) | ConvertFrom-Json
        if ($HttpReport.environment -cne "staging" -or
            $HttpReport.delivered -ne 595 -or $HttpReport.omitted -ne 5 -or
            $HttpReport.soakOutage -ne $true -or $HttpReport.timingValid -ne $true) {
            throw "Entrega/cadencia HTTP reprovada."
        }
        if ($AckCount -ne 595 -or $OmittedWS -ne 5 -or -not $CadenceOk -or
            $script:ComandosPendentes -ne 0) { throw "WS, cadencia ou comandos reprovados." }

        $Remaining = [int][Math]::Ceiling(1800000 - $Timer.Elapsed.TotalMilliseconds)
        if ($Remaining -gt 0) { Start-Sleep -Milliseconds $Remaining }
        $Timer.Stop()
        $After = @(Ler-Estados $FromUtc)
        $AfterInfo = Obter-D1
        for ($i = 0; $i -lt 10; $i++) {
            # Selective D1 persistence can leave final sequence below 60.
            if ([int]$After[$i].offline -ne 0 -or
                [int]$After[$i].seq -le 0 -or [int]$After[$i].raw_samples -le 0) {
                throw "Estado D1 final offline ou sem snapshot deste ensaio."
            }
            $ExpectedOffline = if ($i -eq 0) { 1 } else { 0 }
            if ([int]$After[$i].offline_events -ne $ExpectedOffline) {
                throw "Evento offline indevido no ensaio."
            }
        }
        $RunStatus = "passed"
        Write-Host "Estabilidade 30min aprovada: 595 HTTP, 595 WS, um offline e uma recuperacao." -ForegroundColor Green
    } catch {
        Write-Warning "Execucao pode ter produzido dados parciais: NAO repetir automaticamente."
        throw
    } finally {
        if ($null -ne $Process) {
            try {
                if (-not $Process.HasExited) {
                    $Process.Kill()
                    $null = $Process.WaitForExit(5000)
                }
                if ($Process.HasExited) { $HttpExitCode = $Process.ExitCode }
            } catch {}
            $Process.Dispose()
        }
        if ($null -ne $Timer -and $Timer.IsRunning) { $Timer.Stop() }

        # Never echo raw stderr; only allow known simulator messages.
        if (Test-Path -LiteralPath $ErrorFile -PathType Leaf) {
            $Lines = @(Get-Content -LiteralPath $ErrorFile -ErrorAction SilentlyContinue)
            foreach ($Line in $Lines) {
                if ($Line -match '^Maltworks Lab start: tick=[0-9]{1,2}/60$') {
                    $HttpLastStarted = $Line
                }
                if ($Line -match '^Maltworks Lab progress: tick=[0-9]{1,2}/60 delivered=[0-9]{1,3} omitted=[0-5]$') {
                    $HttpLastProgress = $Line
                }
                if ($Line -match '^Maltworks Lab: Lab staging HTTP batch failed at tick [0-9]{1,2}/60, device MW-C[0-9]{11}: (Lab staging request failed [(](timeout|aborted|network-or-redirect|network-(ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|UND_ERR_CONNECT_TIMEOUT|UND_ERR_HEADERS_TIMEOUT|UND_ERR_SOCKET))[)]; stopping safely|Staging telemetry rejected [(]HTTP [1-5][0-9]{2}[)]|Staging device is pending; claim it in the staging organization first|Lab staging did not confirm an active test device)$') {
                    $HttpFailureSummary = $Line
                }
            }
        }

        # Attempt a final read-only D1 audit on a failed run as well.
        if ($RunStatus -cne "passed" -and $null -eq $After) {
            try {
                $After = @(Ler-Estados $FromUtc)
                $AfterInfo = Obter-D1
            } catch {
                Write-Warning "Auditoria final D1 indisponivel. Nao repetir o ensaio."
            }
        }

        # Preserve child process logs under the Windows user profile on failure.
        # Raw logs remain LOCAL and MUST NOT be uploaded/shared before review.
        if ($RunStatus -cne "passed") {
            if (Test-Path -LiteralPath $ErrorFile -PathType Leaf) {
                $HttpErrorLog = Join-Path $VaultDir ("lab-soak-" + $RunId + ".stderr.log")
                Move-Item -LiteralPath $ErrorFile -Destination $HttpErrorLog -ErrorAction Stop
            }
            if (Test-Path -LiteralPath $OutputFile -PathType Leaf) {
                $HttpOutputLog = Join-Path $VaultDir ("lab-soak-" + $RunId + ".stdout.log")
                Move-Item -LiteralPath $OutputFile -Destination $HttpOutputLog -ErrorAction Stop
            }
        }

        $Report = [ordered]@{
            result = $RunStatus
            environment = "staging"
            started_at_utc = $Start.ToString("o")
            finished_at_utc = [DateTimeOffset]::UtcNow.ToString("o")
            controllers = 10
            ticks = 60
            outage_device = "MW-C00000000000"
            outage_ticks = "30..34"
            ws_acks = $AckCount
            ws_omitted = $OmittedWS
            ws_cadence_valid = $CadenceOk
            ws_min_tick_ms = $(if ([double]::IsPositiveInfinity($GapMin)) { $null } else { [int][Math]::Round($GapMin) })
            ws_max_tick_ms = [int][Math]::Round($GapMax)
            ws_avg_tick_ms = [int][Math]::Round($GapSum / 59)
            ws_max_lag_ms = [int][Math]::Round($LagMax)
            pending_commands = $script:ComandosPendentes
            http = $HttpReport
            http_exit_code = $HttpExitCode
            http_last_progress = $HttpLastProgress
            http_last_started = $HttpLastStarted
            http_failure_summary = $HttpFailureSummary
            http_stderr_log_local = $HttpErrorLog
            http_stdout_log_local = $HttpOutputLog
            d1_size_before = (Campo $BeforeInfo "database_size")
            d1_size_after = $(if ($null -eq $AfterInfo) { $null } else { Campo $AfterInfo "database_size" })
            d1_read_queries_24h_before = (Campo $BeforeInfo "read_queries_24h")
            d1_read_queries_24h_after = $(if ($null -eq $AfterInfo) { $null } else { Campo $AfterInfo "read_queries_24h" })
            d1_write_queries_24h_before = (Campo $BeforeInfo "write_queries_24h")
            d1_write_queries_24h_after = $(if ($null -eq $AfterInfo) { $null } else { Campo $AfterInfo "write_queries_24h" })
            d1_before = $Before
            d1_outage = $Mid
            d1_recovered = $Recovered
            d1_final = $After
        }
        [System.IO.File]::WriteAllText($ReportFile, (($Report | ConvertTo-Json -Depth 8) + [Environment]::NewLine), [System.Text.UTF8Encoding]::new($false))
        Write-Host ("Relatorio local sem credenciais: " + $ReportFile)
        if ($RunStatus -cne "passed") {
            Write-Host ("Emissor HTTP, codigo de saida: " + $HttpExitCode)
            if ($HttpLastStarted) { Write-Host $HttpLastStarted }
            if ($HttpLastProgress) { Write-Host $HttpLastProgress }
            if ($HttpFailureSummary) { Write-Host $HttpFailureSummary }
            Write-Host "Logs locais preservados (nao compartilhe logs brutos sem revisar)."
        }
        Write-Host "Consultas D1 24h sao metricas de janela movel, nao linhas faturaveis. DO Analytics requer painel."
        foreach ($Path in @($OutputFile, $ErrorFile)) {
            Remove-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
        }
    }
} finally {
    foreach ($Socket in $Connections.Values) {
        if ($Socket -is [System.Net.WebSockets.ClientWebSocket]) { Fechar-Socket $Socket }
    }
    $ClientId = $null
    $ClientSecret = $null
    $PlainTokens = $null
    $DeviceTokens = $null
    Pop-Location
}
