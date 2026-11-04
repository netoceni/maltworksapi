# Regression: a peer that never acknowledges close must not hang the Lab.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$Source = Join-Path $PSScriptRoot '07-estabilidade-integrada-lab.ps1'
$Tokens = $null
$Errors = $null
$Ast = [System.Management.Automation.Language.Parser]::ParseFile($Source, [ref]$Tokens, [ref]$Errors)
if (@($Errors).Count -gt 0) { throw 'Lab script syntax failed' }
$CloseFunction = $Ast.Find({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Fechar-Socket' }, $true)
if ($null -eq $CloseFunction) { throw 'Lab socket cleanup function missing' }
Invoke-Expression $CloseFunction.Extent.Text

$Peer = [System.Diagnostics.Process]::new()
$Socket = [System.Net.WebSockets.ClientWebSocket]::new()
try {
    $Peer.StartInfo.FileName = (Get-Command node -ErrorAction Stop).Source
    $Peer.StartInfo.Arguments = '"' + (Join-Path $Root 'test/fixtures/lab-hanging-peer.mjs') + '"'
    $Peer.StartInfo.UseShellExecute = $false
    $Peer.StartInfo.CreateNoWindow = $true
    $Peer.StartInfo.RedirectStandardOutput = $true
    if (-not $Peer.Start()) { throw 'Local fixture failed to start' }
    $Line = $Peer.StandardOutput.ReadLineAsync()
    if (-not $Line.Wait(5000)) { throw 'Local fixture start timed out' }
    $Port = [int](ConvertFrom-Json $Line.Result).port
    if ($Port -lt 1 -or $Port -gt 65535) { throw 'Invalid local fixture port' }
    $Cancel = [Threading.CancellationTokenSource]::new(5000)
    try {
        $null = $Socket.ConnectAsync([uri]("ws://127.0.0.1:" + $Port), $Cancel.Token).GetAwaiter().GetResult()
    } finally { $Cancel.Dispose() }
    $Timer = [Diagnostics.Stopwatch]::StartNew()
    Fechar-Socket $Socket
    $Timer.Stop()
    if ($Timer.ElapsedMilliseconds -gt 2500) { throw 'Lab cleanup waited for an unresponsive close handshake' }
    Write-Host ('Lab socket cleanup passed in ' + $Timer.ElapsedMilliseconds + 'ms against an unresponsive local peer.')
} finally {
    $Socket.Abort()
    $Socket.Dispose()
    if ($Peer.Id -gt 0 -and -not $Peer.HasExited) { $Peer.Kill(); $null = $Peer.WaitForExit(5000) }
    $Peer.Dispose()
}
