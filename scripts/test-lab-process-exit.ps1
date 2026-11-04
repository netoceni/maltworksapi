# Real Windows PowerShell regression for redirected child exit status.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$Tokens = $null
$Errors = $null
$Ast = [Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot '07-estabilidade-integrada-lab.ps1'), [ref]$Tokens, [ref]$Errors)
if (@($Errors).Count -ne 0) { throw 'Lab script syntax failed' }
$Function = $Ast.Find({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Iniciar-EmissorHttp'}, $true)
if ($null -eq $Function) { throw 'HTTP process helper missing' }
Invoke-Expression $Function.Extent.Text
$Scratch = Join-Path ([IO.Path]::GetTempPath()) ('maltworks-exit-test-' + [guid]::NewGuid().ToString('N'))
$null = [IO.Directory]::CreateDirectory($Scratch)
try {
    foreach ($Expected in @(0,7)) {
        $OutFile = Join-Path $Scratch ('exit-' + $Expected + '.out')
        $ErrFile = Join-Path $Scratch ('exit-' + $Expected + '.err')
        $Arguments = @(('"' + (Join-Path $Root 'test/fixtures/lab-exit-code.mjs') + '"'), [string]$Expected)
        $Child = Iniciar-EmissorHttp -NodePath (Get-Command node).Source -NodeArgs $Arguments -Root $Root -OutputFile $OutFile -ErrorFile $ErrFile
        try {
            # Exercise the same repeated HasExited polling as the soak loop.
            for ($Poll = 0; $Poll -lt 4; $Poll++) { $null = $Child.HasExited; Start-Sleep -Milliseconds 100 }
            if (-not $Child.WaitForExit(5000)) { throw 'Local child did not finish' }
            if ($null -eq $Child.ExitCode -or $Child.ExitCode -ne $Expected) { throw ('Lost or wrong exit code; expected ' + $Expected) }
            if ((Get-Content -LiteralPath $OutFile -Raw | ConvertFrom-Json).completed -ne $true) { throw 'Missing child output' }
            Write-Host ('HTTP child exit code ' + $Expected + ' preserved after polling and redirection.')
        } finally {
            if (-not $Child.HasExited) { $Child.Kill(); $null = $Child.WaitForExit(5000) }
            $Child.Dispose()
            foreach ($File in @($OutFile,$ErrFile)) { if (Test-Path -LiteralPath $File) { Remove-Item -LiteralPath $File -Force } }
        }
    }
} finally { Remove-Item -LiteralPath $Scratch -Force }
