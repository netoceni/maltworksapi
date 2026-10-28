# Maltworks Lab - staging privado pela linha de comando (PowerShell 5.1+)
# Execute SOMENTE no checkout da branch test/staging-history-lab-free10-20261028.
# Nenhuma etapa tem comandos de delete, backup/restore ou D1 de producao.
[CmdletBinding()]
param(
    [ValidateSet("Preparar","Migrar","PublicarPrivado","Segredos")]
    [string] $Etapa = "Preparar"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$Root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$ConfigName = "wrangler.lab-staging.jsonc"
$ConfigFile = Join-Path $Root $ConfigName
$TemplateFile = Join-Path $Root "wrangler.lab-staging.example.jsonc"
$Preflight = Join-Path $Root "scripts\maltworks-lab-stage-preflight.mjs"
$Wrangler = Join-Path $Root "node_modules\.bin\wrangler.cmd"
$DatabaseName = "maltworks-lab-staging"
$RequiredBranch = "test/staging-history-lab-free10-20261028"
$ProductionD1Uuid = "a1bf5a75-1bec-4437-92fa-64e69c3da081"
$UuidPattern = '^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$'
# Encrypted under the Windows account; never stored in the repository.
$StagingVaultDir = Join-Path ([Environment]::GetFolderPath("LocalApplicationData")) "Maltworks"
$StagingBootstrapVault = Join-Path $StagingVaultDir "lab-staging-bootstrap.dpapi"

function Confirmar-Texto([string] $Mensagem, [string] $Esperado) {
    Write-Host ""
    Write-Host $Mensagem -ForegroundColor Yellow
    $Resposta = Read-Host ("Digite exatamente: " + $Esperado)
    if ($Resposta -cne $Esperado) { throw "Cancelado: confirmacao divergente." }
}

function Executar-Wrangler([string[]] $Parametros) {
    & $script:Wrangler @Parametros
    if ($LASTEXITCODE -ne 0) {
        throw ("Wrangler falhou no comando: " + ($Parametros -join " "))
    }
}

function Listar-D1 {
    $Saida = & $script:Wrangler d1 list --json
    if ($LASTEXITCODE -ne 0) { throw "Nao foi possivel listar o D1 da conta selecionada." }
    $Texto = ($Saida | Out-String).Trim()
    if (-not $Texto) { throw "D1 list retornou resposta vazia." }
    try { $Dados = ConvertFrom-Json -InputObject $Texto } catch {
        throw "D1 list --json nao retornou JSON valido. Verifique a autenticacao e versao Wrangler."
    }
    if ($null -ne $Dados -and $Dados -is [array]) { return $Dados }
    if ($null -ne $Dados -and $Dados.PSObject.Properties.Name -contains "result") {
        return @($Dados.result)
    }
    throw "Formato D1 list inesperado. Nada foi alterado."
}

function Obter-Uuid($Banco) {
    foreach ($Campo in @("uuid","id","database_id")) {
        if ($Banco.PSObject.Properties.Name -contains $Campo) {
            return [string] $Banco.$Campo
        }
    }
    throw "UUID nao encontrado no cadastro de D1."
}

function Conferir-Staging {
    if (-not (Test-Path -LiteralPath $script:ConfigFile)) {
        throw ("Arquivo de configuracao nao existe: " + $script:ConfigName + ". Execute -Etapa Preparar.")
    }
    & node $script:Preflight $script:ConfigFile
    if ($LASTEXITCODE -ne 0) { throw "Preflight rejeitou o arquivo de staging." }
    $Configuracao = Get-Content -LiteralPath $script:ConfigFile -Raw | ConvertFrom-Json
    if ($Configuracao.name -ne "maltworks-api-lab-staging" -or
        $Configuracao.workers_dev -ne $false -or
        $Configuracao.preview_urls -ne $false) {
        throw "Worker de staging nao esta completamente privado."
    }
    if (($Configuracao.PSObject.Properties.Name -contains "routes") -and
        $null -ne $Configuracao.routes -and @($Configuracao.routes).Count -gt 0) {
        throw "Este script so publica Worker SEM routes. Access sera configurado depois."
    }
    $UuidLocal = [string] $Configuracao.d1_databases[0].database_id
    if ($UuidLocal -notmatch $script:UuidPattern -or $UuidLocal -eq $script:ProductionD1Uuid) {
        throw "UUID invalido ou pertencente ao D1 de producao."
    }
    $Registros = @(Listar-D1 | Where-Object { $_.name -eq $script:DatabaseName })
    if ($Registros.Count -ne 1) {
        throw "Staging D1 nao foi encontrado unicamente na conta Cloudflare atual."
    }
    $UuidRemoto = Obter-Uuid $Registros[0]
    if ($UuidLocal -ne $UuidRemoto) {
        throw "PERIGO: UUID local nao coincide com o staging D1 da conta ativa. Abortado."
    }
    Write-Host ("Staging D1 conferido: " + $script:DatabaseName + " / " + $UuidLocal) -ForegroundColor Green
}

function Novo-Segredo {
    $Bytes = New-Object byte[] 48
    $Rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try { $Rng.GetBytes($Bytes) } finally { $Rng.Dispose() }
    return ([BitConverter]::ToString($Bytes)).Replace("-", "").ToLowerInvariant()
}

Push-Location $Root
try {
    if (-not (Test-Path -LiteralPath $Wrangler)) {
        throw "Wrangler nao instalado. Execute npm.cmd ci no diretorio maltworksapi."
    }
    if (-not (Test-Path -LiteralPath $TemplateFile)) {
        throw "Template de staging nao localizado. Confira a branch."
    }
    $Branch = (& git branch --show-current | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or $Branch -ne $RequiredBranch) {
        throw ("Branch incorreta: " + $Branch + ". Necessaria: " + $RequiredBranch)
    }
    Write-Host ("Maltworks Lab / Etapa: " + $Etapa) -ForegroundColor Cyan
    Executar-Wrangler -Parametros @("whoami")

    switch ($Etapa) {
        "Preparar" {
            $Bancos = @(Listar-D1 | Where-Object { $_.name -eq $DatabaseName })
            if ($Bancos.Count -gt 1) { throw "Mais de um banco com o mesmo nome. Abortado." }
            if ($Bancos.Count -eq 1) {
                if (-not (Test-Path -LiteralPath $ConfigFile)) {
                    throw "Ja existe D1 staging nesta conta, mas nao ha config local. Nao sera reutilizado automaticamente."
                }
                Conferir-Staging
                Write-Host "Staging ja preparado. Pode avancar para -Etapa Migrar." -ForegroundColor Green
                break
            }
            if (Test-Path -LiteralPath $ConfigFile) {
                throw "Config staging existe, mas D1 remoto nao foi encontrado. Verifique a conta ativa."
            }
            Confirmar-Texto "Criar novo banco D1 'maltworks-lab-staging' na conta exibida acima?" "CRIAR LAB"
            # Never allow a resource creation command to edit wrangler.jsonc.
            $ProdConfig = Join-Path $Root "wrangler.jsonc"
            $ProdConfigHashBefore = (Get-FileHash -LiteralPath $ProdConfig -Algorithm SHA256).Hash
            Executar-Wrangler -Parametros @("d1","create",$DatabaseName,"--no-update-config")
            $ProdConfigHashAfter = (Get-FileHash -LiteralPath $ProdConfig -Algorithm SHA256).Hash
            if ($ProdConfigHashBefore -ne $ProdConfigHashAfter) {
                throw "ALERTA: wrangler.jsonc de producao foi modificado; revise antes de continuar."
            }
            $Novos = @(Listar-D1 | Where-Object { $_.name -eq $DatabaseName })
            if ($Novos.Count -ne 1) { throw "Banco criado, mas nao apareceu no D1 list. Verifique manualmente." }
            $Uuid = Obter-Uuid $Novos[0]
            if ($Uuid -notmatch $UuidPattern -or $Uuid -eq $ProductionD1Uuid) {
                throw "UUID inseguro. Nenhum arquivo de configuracao foi criado."
            }
            $Cfg = Get-Content -LiteralPath $TemplateFile -Raw | ConvertFrom-Json
            $Cfg.d1_databases[0].database_id = $Uuid
            $Json = ConvertTo-Json -InputObject $Cfg -Depth 30
            [System.IO.File]::WriteAllText(
                $ConfigFile, $Json + [Environment]::NewLine,
                (New-Object System.Text.UTF8Encoding($false))
            )
            Conferir-Staging
            Write-Host "Novo D1 criado; config privada validada. Proximo: -Etapa Migrar." -ForegroundColor Green
        }
        "Migrar" {
            Conferir-Staging
            Write-Host "Apenas migracoes no banco NOVO de homologacao:" -ForegroundColor Yellow
            Executar-Wrangler -Parametros @("d1","migrations","list","DB","--remote","--config",$ConfigName)
            Confirmar-Texto "Aplicar migracoes remotas 0001..0018 SOMENTE em ${DatabaseName}?" "MIGRAR LAB"
            Executar-Wrangler -Parametros @("d1","migrations","apply","DB","--remote","--config",$ConfigName)
            Write-Host "Migracoes de homologacao aplicadas. Proximo: -Etapa PublicarPrivado." -ForegroundColor Green
        }
        "PublicarPrivado" {
            Conferir-Staging
            Confirmar-Texto "Criar/atualizar Worker SEM workers.dev, sem preview URLs, cron ou routes?" "PUBLICAR PRIVADO"
            Executar-Wrangler -Parametros @("deploy","--config",$ConfigName)
            Write-Host "Worker publicado sem rota publica intencional." -ForegroundColor Green
            Write-Host "Proximo: -Etapa Segredos. Nao adicione hostname antes de configurar Access."
        }
        "Segredos" {
            Conferir-Staging
            if (Test-Path -LiteralPath $StagingBootstrapVault) {
                throw ("O BOOTSTRAP_SECRET ja tem backup DPAPI em " + $StagingBootstrapVault +
                    ". Para evitar rotacao acidental, esta etapa nao pode ser repetida sem revisao.")
            }
            # DPAPI is Windows-user bound: validate encryption BEFORE touching Cloudflare.
            $ValorTeste = Novo-Segredo
            $ProtegidoTeste = ConvertFrom-SecureString -SecureString (
                ConvertTo-SecureString -String $ValorTeste -AsPlainText -Force
            )
            if ([string]::IsNullOrWhiteSpace($ProtegidoTeste)) {
                throw "Falha no teste de criptografia DPAPI: nenhuma credencial foi alterada."
            }
            $ValorTeste = $null
            $ProtegidoTeste = $null

            Confirmar-Texto "Criar 3 segredos aleatorios de staging? BOOTSTRAP_SECRET sera salvo com criptografia DPAPI local." "CRIAR SEGREDOS"
            if (-not (Test-Path -LiteralPath $StagingVaultDir)) {
                New-Item -ItemType Directory -Path $StagingVaultDir -Force | Out-Null
            }
            foreach ($Nome in @("BOOTSTRAP_SECRET","PASSWORD_PEPPER","PASSWORD_RESET_SECRET")) {
                $Valor = Novo-Segredo
                $Criptografado = $null
                if ($Nome -eq "BOOTSTRAP_SECRET") {
                    $Criptografado = ConvertFrom-SecureString -SecureString (
                        ConvertTo-SecureString -String $Valor -AsPlainText -Force
                    )
                }
                # No secrets are printed, committed or passed as CLI arguments.
                $Valor | & $Wrangler secret put $Nome --config $ConfigName
                $CodigoSaida = $LASTEXITCODE
                $Valor = $null
                if ($CodigoSaida -ne 0) { throw ("Falha ao gravar o segredo " + $Nome) }
                if ($Nome -eq "BOOTSTRAP_SECRET") {
                    # Persist only after Wrangler acknowledged storing the remote secret.
                    [System.IO.File]::WriteAllText(
                        $StagingBootstrapVault,
                        $Criptografado + [Environment]::NewLine,
                        (New-Object System.Text.UTF8Encoding($false))
                    )
                    $Criptografado = $null
                    Write-Host ("BOOTSTRAP_SECRET salvo localmente com DPAPI em: " +
                        $StagingBootstrapVault) -ForegroundColor Green
                }
                Write-Host ("Segredo de staging enviado: " + $Nome) -ForegroundColor Green
            }
            Write-Host "Staging privado configurado. Nao crie uma rota antes de habilitar Cloudflare Access."
        }
    }
} finally {
    Pop-Location
}