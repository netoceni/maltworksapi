# Maltworks Lab: cria aplicacao Access SEM criar DNS ou rota publica.
# PowerShell 5.1+ / Windows. Autenticacao API solicitada via SecureString.
# Checar e Inspecionar exigem apenas permissoes de leitura; Criar exige escrita.
[CmdletBinding()]
param(
    [ValidateSet("Checar","Inspecionar","Criar","Auditar")]
    [string] $Etapa = "Checar",
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[a-fA-F0-9]{32}$')]
    [string] $AccountId,
    [string] $AdminEmail = "",
    [switch] $TokenFromClipboard
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$Root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$WorkerConfig = Join-Path $Root "wrangler.lab-staging.jsonc"
$Preflight = Join-Path $Root "scripts\maltworks-lab-stage-preflight.mjs"
$HostName = "api-staging.maltworks.com.br"
$AppName = "Maltworks Lab Staging - Internal Only"
$ServiceTokenName = "Maltworks Lab Staging CLI"
$BranchExpected = "test/staging-history-lab-free10-20261028"
$VaultDir = Join-Path ([Environment]::GetFolderPath("LocalApplicationData")) "Maltworks"
$VaultFile = Join-Path $VaultDir "lab-access-client.dpapi.json"
$ApiBase = "https://api.cloudflare.com/client/v4/accounts/$AccountId/access"
$script:ApiToken = $null

function Encriptar([string] $Plaintext) {
    if ([string]::IsNullOrWhiteSpace($Plaintext)) { throw "Segredo vazio nao pode ser cifrado." }
    return ConvertFrom-SecureString (ConvertTo-SecureString -String $Plaintext -AsPlainText -Force)
}

function Requisicao-Access([string] $Metodo, [string] $Path, $Corpo = $null) {
    $Headers = @{ Authorization = ("Bearer " + $script:ApiToken) }
    $Args = @{ Uri = ($script:ApiBase + $Path); Method = $Metodo; Headers = $Headers; ErrorAction = "Stop" }
    if ($null -ne $Corpo) {
        $Args.ContentType = "application/json"
        $Args.Body = ConvertTo-Json -InputObject $Corpo -Depth 30 -Compress
    }
    try {
        $R = Invoke-RestMethod @Args
    } catch {
        $Status = "sem status HTTP"
        if ($null -ne $_.Exception.Response) {
            try { $Status = [string][int]$_.Exception.Response.StatusCode } catch {}
        }
        throw ("Cloudflare Access " + $Metodo + " falhou (HTTP " + $Status +
            "). Verifique o token (Access Apps and Policies Edit / Service Tokens Edit) e a ativacao do Zero Trust. Nao ha rota publica.")
    }
    if ($R.success -ne $true) {
        throw ("Cloudflare Access nao confirmou sucesso em " + $Metodo + " " + $Path + ".")
    }
    return $R
}

function Listar-Aplicacoes {
    $Todos = @()
    for ($Pagina = 1; $Pagina -le 20; $Pagina++) {
        $Resposta = Requisicao-Access "GET" ("/apps?per_page=100&page=" + $Pagina)
        $Lote = @($Resposta.result)
        $Todos += $Lote
        $Total = 0
        if (($Resposta.PSObject.Properties.Name -contains 'result_info') -and
            $null -ne $Resposta.result_info -and
            ($Resposta.result_info.PSObject.Properties.Name -contains 'total_count')) {
            $Total = [int]$Resposta.result_info.total_count
        }
        if ($Lote.Count -lt 100 -or ($Total -gt 0 -and $Todos.Count -ge $Total)) {
            return $Todos
        }
    }
    throw "Paginacao de Access excedeu o limite de verificacao: abortado."
}

function Selecionar-Aplicacao($Todas) {
    $Encontradas = @($Todas | Where-Object {
        (($_.PSObject.Properties.Name -contains 'domain') -and $_.domain -eq $HostName) -or
        (($_.PSObject.Properties.Name -contains 'name') -and $_.name -eq $AppName)
    })
    if ($Encontradas.Count -gt 1) {
        throw "Ha varias aplicacoes Access que correspondem ao staging. Revisar pelo painel antes de prosseguir."
    }
    return $Encontradas
}

function Carregar-Vault {
    if (-not (Test-Path -LiteralPath $VaultFile)) { return $null }
    $V = Get-Content -LiteralPath $VaultFile -Raw | ConvertFrom-Json
    if ($V.account_id -ne $AccountId -or $V.hostname -ne $HostName -or
        [string]::IsNullOrWhiteSpace($V.service_token_id) -or
        [string]::IsNullOrWhiteSpace($V.client_id_dpapi) -or
        [string]::IsNullOrWhiteSpace($V.client_secret_dpapi)) {
        throw "Arquivo DPAPI de Access nao corresponde ao staging esperado."
    }
    return $V
}

function Verificar-Aplicacao($Aplicacao, $TokenId, [string] $Email) {
    if ($Aplicacao.type -ne "self_hosted" -or $Aplicacao.domain -ne $HostName) {
        throw "Access existente nao protege o hostname exato de staging."
    }
    if ($Aplicacao.app_launcher_visible -eq $true) {
        throw "Access esta visivel no App Launcher, revise se este comportamento e desejado."
    }
    $Policies = (Requisicao-Access "GET" ("/apps/" + $Aplicacao.id + "/policies")).result
    $Servico = @($Policies | Where-Object {
        $_.decision -eq "non_identity" -and @($_.include | Where-Object {
            ($_.PSObject.Properties.Name -contains 'service_token') -and
            $null -ne $_.service_token -and $_.service_token.token_id -eq $TokenId
        }).Count -gt 0
    })
    $Pessoa = @($Policies | Where-Object {
        $_.decision -eq "allow" -and @($_.include | Where-Object {
            ($_.PSObject.Properties.Name -contains 'email') -and
            $null -ne $_.email -and $_.email.email -eq $Email
        }).Count -gt 0
    })
    $Inseguras = @($Policies | Where-Object {
        $_.decision -eq "bypass" -or @($_.include | Where-Object {
            ($_.PSObject.Properties.Name -contains 'everyone') -or
            ($_.PSObject.Properties.Name -contains 'any_valid_service_token')
        }).Count -gt 0
    })
    if ($Servico.Count -ne 1 -or $Pessoa.Count -ne 1 -or $Inseguras.Count -gt 0) {
        throw "Politicas Access nao foram verificadas: nao habilite routes/DNS."
    }
    Write-Host "Access verificado: hostname privado + e-mail especifico + token de servico especifico." -ForegroundColor Green
    Write-Host ("Aplicacao Access: " + $Aplicacao.id)
}

Push-Location $Root
try {
    $Branch = (& git branch --show-current | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or $Branch -ne $BranchExpected) {
        throw "Branch incorreta: use exclusivamente a homologacao PR #18."
    }
    if (-not (Test-Path -LiteralPath $WorkerConfig)) {
        throw "Configuracao local de staging nao encontrada."
    }
    & node $Preflight $WorkerConfig
    if ($LASTEXITCODE -ne 0) { throw "Preflight de isolamento falhou." }
    $Cfg = Get-Content -LiteralPath $WorkerConfig -Raw | ConvertFrom-Json
    if (($Cfg.PSObject.Properties.Name -contains "routes") -and
        @($Cfg.routes).Count -gt 0) {
        throw "A rota ja existe na configuracao local. Audite antes de continuar."
    }
    if ($Etapa -eq "Criar" -and ($AdminEmail -notmatch '^[^@\s]+@[^@\s]+\.[^@\s]+$')) {
        throw "Para criar Access, informe -AdminEmail com um endereco de e-mail valido."
    }

    Write-Host ("Etapa: " + $Etapa + " / Host: " + $HostName + " / Conta: " + $AccountId)
    Write-Host "O token da API sera lido sem eco e NAO sera salvo."
    if ($TokenFromClipboard) {
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
        $Seguro = Read-Host "Cole seu API Token Cloudflare com permissoes Access" -AsSecureString
    }
    $Ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Seguro)
    try {
        $script:ApiToken = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($Ptr)
    } finally {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($Ptr)
    }
    if ([string]::IsNullOrWhiteSpace($script:ApiToken)) { throw "Token API vazio." }

    $Apps = @(Listar-Aplicacoes)
    $Encontradas = @(Selecionar-Aplicacao $Apps)
    $Vault = Carregar-Vault

    if ($Etapa -eq "Checar") {
        [void](Requisicao-Access "GET" "/service_tokens?per_page=1")
        Write-Host "Permissoes de LEITURA Access confirmadas. A criacao exige permissoes de escrita." -ForegroundColor Green
        if ($Encontradas.Count -eq 0) {
            Write-Host ("Nenhuma aplicacao Access encontrada para " + $HostName)
        } else {
            Write-Host ("Aplicacao Access existente: " + $Encontradas[0].id)
        }
        if ($null -ne $Vault) { Write-Host "Credencial de Lab ja armazenada em DPAPI." }
    } elseif ($Etapa -eq "Inspecionar") {
        # Independent read-only audit for an existing Access application.
        # Do not require a local service-token vault and do not modify policies.
        if ($Encontradas.Count -ne 1) {
            throw "Aplicacao Access nao encontrada unicamente. Nenhuma alteracao realizada."
        }
        $Detalhe = (Requisicao-Access "GET" ("/apps/" + $Encontradas[0].id)).result
        if ($Detalhe.id -ne $Encontradas[0].id -or
            $Detalhe.type -ne "self_hosted" -or
            $Detalhe.domain -ne $HostName) {
            throw "Aplicacao Access nao corresponde ao hostname exato do staging."
        }
        if ($Detalhe.app_launcher_visible -eq $true) {
            Write-Warning "A aplicacao esta visivel no App Launcher."
        }
        Write-Host ("Aplicacao confirmada: " + $Detalhe.id)
        Write-Host ("Hostname confirmado: " + $Detalhe.domain)
        $Politicas = @((Requisicao-Access "GET" ("/apps/" + $Detalhe.id + "/policies")).result)
        $Servico = 0
        $Email = 0
        $Inseguras = 0
        Write-Host ("Numero de politicas: " + $Politicas.Count)
        foreach ($Politica in $Politicas) {
            $Regras = @($Politica.include)
            $ComTokenEspecifico = @($Regras | Where-Object {
                $_.PSObject.Properties.Name -contains "service_token" -and
                $null -ne $_.service_token -and
                -not [string]::IsNullOrWhiteSpace($_.service_token.token_id)
            }).Count -gt 0
            $ComEmailEspecifico = @($Regras | Where-Object {
                $_.PSObject.Properties.Name -contains "email" -and
                $null -ne $_.email -and
                -not [string]::IsNullOrWhiteSpace($_.email.email)
            }).Count -gt 0
            $AmplamentePermissiva = $Politica.decision -eq "bypass" -or
                @($Regras | Where-Object {
                    $_.PSObject.Properties.Name -contains "everyone" -or
                    $_.PSObject.Properties.Name -contains "any_valid_service_token"
                }).Count -gt 0
            if ($Politica.decision -eq "non_identity" -and $ComTokenEspecifico) { $Servico++ }
            if ($Politica.decision -eq "allow" -and $ComEmailEspecifico) { $Email++ }
            if ($AmplamentePermissiva) { $Inseguras++ }
            Write-Host ("Politica: " + $Politica.name + " | decisao=" + $Politica.decision +
                " | token_especifico=" + $ComTokenEspecifico +
                " | email_especifico=" + $ComEmailEspecifico +
                " | permissiva=" + $AmplamentePermissiva)
        }
        Write-Host ("Resumo: service_auth=" + $Servico +
            " | email_restrito=" + $Email + " | politicas_permissivas=" + $Inseguras)
        if ($Inseguras -gt 0) {
            throw "Politicas Access potencialmente permissivas: revisar no painel. Nenhuma alteracao realizada."
        }
        if ($Servico -eq 0) {
            Write-Warning "Nenhuma politica de token de servico especifico encontrada. Envio remoto NAO autorizado."
        }
        if ($Email -eq 0) {
            Write-Warning "Nenhuma politica de e-mail especifico encontrada; revisar acesso humano."
        }
        if ($null -eq $Vault) {
            Write-Host "Credencial DPAPI do token de servico AUSENTE: nao e possivel autenticar o simulador ainda."
        } else {
            Write-Host "Credencial DPAPI existe. Identidade do token ainda exige auditoria estrita."
        }
        Write-Host "Inspecao somente leitura concluida. Nenhum envio remoto autorizado por esta verificacao."
    } elseif ($Etapa -eq "Criar") {
        if ($Encontradas.Count -gt 0) {
            throw "Access ja existe neste hostname/nome; nada sera sobrescrito. Use -Etapa Auditar."
        }
        $TokenId = ""
        if ($null -eq $Vault) {
            # Validate Windows DPAPI and local write permissions before remote mutation.
            [void](Encriptar "lab-staging-dpapi-selftest")
            if (-not (Test-Path -LiteralPath $VaultDir)) {
                New-Item -ItemType Directory -Path $VaultDir -Force | Out-Null
            }
            $TesteLocal = Join-Path $VaultDir "lab-access-write-test.tmp"
            try { [IO.File]::WriteAllText($TesteLocal,"ok") } finally {
                if (Test-Path -LiteralPath $TesteLocal) { Remove-Item -LiteralPath $TesteLocal -Force }
            }
            Write-Host "Proposta: gerar token de servico com validade de 30 dias e Access para e-mail individual."
            Write-Host "Nao cria nem altera DNS, Workers, D1 ou rotas."
            $Confirm = Read-Host "Digite CRIAR ACCESS para autorizar"
            if ($Confirm -cne "CRIAR ACCESS") { throw "Operacao cancelada." }
            $T = (Requisicao-Access "POST" "/service_tokens" @{
                name = $ServiceTokenName
                duration = "720h"
                enabled = $true
            }).result
            if ([string]::IsNullOrWhiteSpace($T.id) -or
                [string]::IsNullOrWhiteSpace($T.client_id) -or
                [string]::IsNullOrWhiteSpace($T.client_secret)) {
                throw "Resposta de Service Token incompleta. Nao crie a rota."
            }
            $TokenId = $T.id
            # Store client secret immediately: Cloudflare exposes it only once.
            $Guardado = [ordered]@{
                account_id = $AccountId
                hostname = $HostName
                service_token_id = $TokenId
                admin_email = $AdminEmail
                client_id_dpapi = (Encriptar $T.client_id)
                client_secret_dpapi = (Encriptar $T.client_secret)
            } | ConvertTo-Json -Depth 10
            [IO.File]::WriteAllText(
                $VaultFile, $Guardado, (New-Object System.Text.UTF8Encoding($false))
            )
            $T = $null
            Write-Host ("Service Token criado. Credenciais DPAPI: " + $VaultFile) -ForegroundColor Green
        } else {
            if ($Vault.admin_email -ne $AdminEmail) {
                throw "E-mail autorizado difere daquele registrado no vault DPAPI."
            }
            $TokenId = $Vault.service_token_id
            Write-Host "Recuperacao: reusando token de servico ja guardado (sem nova rotacao)."
        }

        $Payload = @{
            name = $AppName
            type = "self_hosted"
            domain = $HostName
            app_launcher_visible = $false
            session_duration = "8h"
            policies = @(
                @{
                    name = "Lab API - Service Auth"
                    precedence = 1
                    decision = "non_identity"
                    include = @(@{ service_token = @{ token_id = $TokenId } })
                },
                @{
                    name = "Lab API - Developer Email"
                    precedence = 2
                    decision = "allow"
                    include = @(@{ email = @{ email = $AdminEmail } })
                }
            )
        }
        $NovaApp = (Requisicao-Access "POST" "/apps" $Payload).result
        if ([string]::IsNullOrWhiteSpace($NovaApp.id)) {
            throw "Aplicacao criada sem ID de resposta: audite pelo painel, nao habilite rota."
        }
        Write-Host ("Access criado; ID: " + $NovaApp.id) -ForegroundColor Green
        $AppDetalhe = (Requisicao-Access "GET" ("/apps/" + $NovaApp.id)).result
        Verificar-Aplicacao $AppDetalhe $TokenId $AdminEmail
        Write-Host "PROTECAO CONFIGURADA. A rota/DNS continua desativada." -ForegroundColor Green
    } elseif ($Etapa -eq "Auditar") {
        if ($Encontradas.Count -ne 1 -or $null -eq $Vault) {
            throw "Aplicacao ou credenciais DPAPI ausentes; nao habilite rota."
        }
        $Detalhe = (Requisicao-Access "GET" ("/apps/" + $Encontradas[0].id)).result
        Verificar-Aplicacao $Detalhe $Vault.service_token_id $Vault.admin_email
    }
} finally {
    $script:ApiToken = $null
    Pop-Location
}
