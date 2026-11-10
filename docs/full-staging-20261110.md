# Staging completo de Admin + Cloud + API — preparação de 10/11/2026

Status: proposta pronta para revisão e validação local. Nenhum recurso foi criado,
nenhuma migração remota foi aplicada e nenhum Worker foi publicado nesta preparação.
API/Admin partem de `integration/development-20261110`; Cloud usa o repositório
`netoceni/maltworkspanel`. As branches `prepare/full-staging-20261110` não alteram a main.

## Recursos propostos

| Componente | Recurso exclusivo | Situação / ação futura |
| --- | --- | --- |
| API completa | Worker `maltworks-api-staging` | Publicar código da integração com config própria |
| Banco | D1 `maltworks-app-staging` | Criar vazio, registrar UUID real e aplicar 0001–0018 |
| Tempo real | DO SQLite `RealtimeHub` do novo Worker | Criado na primeira publicação pela migration `v1-realtime-app-staging` |
| Firmware de teste | R2 privado `maltworks-staging-firmware` | Criar vazio, sem domínio público ou acesso direto de navegador |
| Anexos de lotes | R2 privado `maltworks-staging-batch-files` | Criar vazio; acesso pelo Worker e autenticação da aplicação |
| Admin | Worker estático `maltworks-admin-site-staging` | Publicar assets de `netoceni/maltworksadmin` |
| Cloud do cliente | Worker estático `maltworks-cloud-site-staging` | Publicar assets de `netoceni/maltworkspanel` |
| Acesso | Access nos três hostnames exatos | Auditar configuração existente e preparar política de testadores e simuladores |
| Endereços | `admin-staging`, `app-staging`, `api-staging.maltworks.com.br` | Criar os dois primeiros custom domains; planejar transferência do terceiro |

Todos os recursos ficam na mesma conta Cloudflare já usada pelo projeto
(`4e8c08f70722d344cf39c362a110d706`). O isolamento é de recursos, credenciais e dados;
faturamento, cotas da conta e permissões dos operadores continuam compartilhados.
Não copiar dados pessoais, firmware publicado, senhas, sessões ou credenciais de produção.

O Cloud de produção continua no Pages `maltworks-cloud-app`. Apenas o novo staging
usa Static Assets em um Worker, para manter nomes, URLs e etapas de publicação explícitos.
Nenhum comando npm de produção foi redirecionado para staging.
Uma consulta adicional somente de leitura com `wrangler pages project list --json`
mostrou `Git Provider: No` para `maltworks-cloud-app` e `maltworks-admin`.
Isso confirma ausência de integração Git nesses projetos Pages consultados, sem
substituir a auditoria de Workers Builds e dos workflows de cada repositório.

## O que existe hoje e não deve ser confundido com a nova pilha

Na verificação somente de leitura de 10/11, `api-staging.maltworks.com.br` apontava
para `maltworks-api-lab-staging`, com D1 `maltworks-lab-staging`
(`26b9ecab-1aaa-4120-93a5-1c409555d28b`) e namespace DO
`70f543b57d9747c1870e728977a3bc64`. Era um Lab de histórico, sem R2 ou EMAIL.
As migrations 0001–0018 estavam registradas nesse banco; isso **não** aplica
migrations ao futuro `maltworks-app-staging` nem prova que o código integrado foi publicado.

Admin e Cloud de staging não tinham DNS resolvido. O Worker Admin de staging retornou
404 na consulta de metadados. A API exigia Access (302 anônimo, 200 no health com
service token), mas a credencial disponível não permitiu auditar integralmente DNS
e Access da zona (403). Lista de aplicações vazia em outro escopo não prova ausência
de proteção. Repetir a auditoria com leitura autorizada antes de configurar domínios.

O novo banco rejeita, no gerador local, tanto o UUID do Lab quanto o UUID de produção
`a1bf5a75-1bec-4437-92fa-64e69c3da081`. Os dois buckets de produção
`maltworks-firmware` e `maltworks-batch-files` também não são aceitos.
Um UUID com formato válido ainda precisa ser conferido na conta: o gerador não faz
consulta remota nem comprova propriedade, existência ou isolamento do recurso.

## Configurações preparadas

- API: `wrangler.app-staging.example.jsonc`, com UUID pendente. O gerador
  `scripts/full-staging-config.mjs` exige UUID novo, confere bindings/variáveis e
  gera `wrangler.app-staging.jsonc` ignorado pelo Git. `--with-maintenance` prepara
  também o cron completo (offline/monitor D1), mantendo retenções em zero.
  Sem `--write`, imprime somente
  a configuração; com `--write`, recusa sobrescrever arquivo existente.
- Admin/Cloud: `wrangler.staging.private.jsonc` sem routes; depois
  `wrangler.staging.jsonc` com o custom domain exato. Mesmo Worker nas duas fases.
- Todos desabilitam `workers.dev` e preview URLs. Logs e traces habilitados;
  amostragem de traces 100% para o pequeno ambiente de teste. Revisar custo/volume
  antes de aumentar carga e não registrar tokens ou payloads sensíveis.
- API usa `APP_ORIGIN=https://app-staging.maltworks.com.br`,
  `ADMIN_ORIGIN=https://admin-staging.maltworks.com.br` e sessão de um dia.
  Admin e Cloud já selecionam a API de staging pelo hostname; Cloud também seleciona
  `wss://api-staging.maltworks.com.br` e o Admin de staging.
- Link de notificação agora usa `APP_ORIGIN`, em vez de abrir produção. Regressão
  com D1 local e serviço de e-mail falso cobre os dois ambientes.
- API mantém a compatibility date da integração (2026-08-06), Admin mantém
  2026-08-12; o novo Worker estático Cloud usa 2026-11-10. Não houve atualização
  silenciosa do runtime da aplicação existente.

Exemplo **somente local**, após obter e conferir o UUID real do novo D1:

```powershell
node scripts/full-staging-config.mjs <UUID-REAL-DO-NOVO-D1> --write
```

Os sinais `<...>` são instruções a substituir, não valores utilizáveis nem sintaxe
pronta para colar no PowerShell. A etapa não cria banco nem publica nada.
O gerador recusa recursos conhecidos de produção/Lab, URLs de preview, origens de
produção, DO ligado a outro Worker, bindings extras e retenção destrutiva.
Não usar o arquivo `.example` para publicação.

## Política inicial de Access (proposta, não aplicada)

Preparar aplicação self-hosted para os três hostnames **exatos**, ou políticas
equivalentes revisadas nas aplicações existentes. Não criar wildcard para todo
`maltworks.com.br` nem substituir a aplicação que já protege o Lab sem auditar escopo,
precedência, políticas herdadas, audience e service tokens.

Identidades ainda precisam ser escolhidas: lista explícita de testadores, IdP
autorizado e service token exclusivo de staging para simuladores. Não há IDs,
e-mails ou segredos inventados em um payload executável. A política humana deve
permitir apenas a lista aprovada; a política Service Auth deve aceitar apenas o token
de staging. Sem Everyone, bypass geral ou credenciais de produção. Access complementa
a sessão Maltworks: token Access não concede login, superadmin ou controle de dispositivo.

Para SPA e API em domínios diferentes, validar hidratação do cookie Access para os
hostnames exatos antes do primeiro fetch/WebSocket. Uma aplicação multidomínio pode
usar o fluxo de redirecionamentos de autenticação da Cloudflare. Testar também
preflight OPTIONS e CORS com credenciais, permitido apenas a Admin/Cloud de staging.
Se for necessário permitir OPTIONS no Access, restringir a resposta CORS às origens,
métodos e headers necessários; requisições reais seguem autenticadas. Não usar
bypass de `/v1/*`, de WebSocket ou de toda a API para contornar falhas de login.
Não colocar service token no JavaScript do Admin/Cloud. No simulador, usar armazenamento
local protegido e headers Access, além da credencial do dispositivo simulado.

## Segredos e estado inicial

Gerar valores novos e exclusivos de `PASSWORD_PEPPER`, `PASSWORD_RESET_SECRET` e
`BOOTSTRAP_SECRET`. Armazenar no gerenciador seguro e no Worker de staging em etapa
posterior autorizada. Nunca versionar valores ou copiá-los da produção/Lab.
`wrangler secret put` publica versão imediatamente; não usá-lo durante esta preparação.
Planejar entrada de secrets via versões não publicadas e publicação privada coordenada.
Arquivos locais de segredos não são enviados automaticamente para o Worker.

Após as migrations no novo banco: cadastrar contas de teste e organização de cada
plano; promover somente o administrador de teste pelo fluxo bootstrap existente;
registrar controladores exclusivamente simulados e usar novos tokens. Verificar o
comportamento de bootstrap e suas condições no código antes de chamar a rota.
Não existe dispositivo físico em operação segundo o usuário. Ainda assim, não reutilizar
IDs/tokens nem mudar o Lab existente. O plano de organização atual usa
`organization_history_plans`; atribuições de teste precisam seguir esse esquema,
não inventar uma nova tabela de assinatura.

## E-mail e tarefas agendadas

Padrão: sem binding EMAIL e sem variáveis de remetente/destinatário; nenhuma mensagem
externa é enviada. Leads podem ser gravados, e-mail fica desligado. Para homologar envio
posteriormente, configurar domínio remetente separado `staging.maltworks.com.br`,
verificar um inbox de teste real e gerar config com `--email-to=<INBOX-APROVADO>`.
O gerador limita o binding EMAIL a esse único destinatário externo e usa
`notificacoes@staging.maltworks.com.br`. Não usar os endereços fictícios dos testes.
Essa opção não redireciona mensagens: criar o usuário opt-in com o inbox aprovado;
outros destinatários serão recusados pelo serviço. Validar envio, link de staging e
recusa de destinatário fora da lista somente após autorização.

O cron inicial roda a cada cinco minutos apenas rollup, com persistência a 180s,
retenções em zero e manutenção destrutiva desabilitada. A aplicação completa tem
auth, planos, R2 e DO; o cron reduzido é uma decisão inicial de homologação, não
equivalência integral com a operação de produção. A geração com `--with-maintenance`
habilita o cron a cada minuto, scans offline e monitor diário D1 no banco novo,
mantendo as três retenções em zero (sem expiração). Essa é a opção preparada para
a homologação completa após o primeiro smoke test. Alertas externos continuam off
até habilitar o e-mail. A variável `D1_BILLING_PLAN=paid` não muda o plano da conta.
Retenção com expiração exige revisão separada e não é aceita pelo gerador.
Sem expiração, o banco cresce: acompanhar uso e volume dos simuladores.
Não desligar os limites de segurança dos scripts antigos do Lab para fazê-los
aceitar a nova pilha.

## Sequência futura — nenhuma etapa remota executada aqui

1. Revisar PRs e CI, reconciliar código de integração e registrar SHAs aprovados.
   Auditar no painel eventuais Workers Builds/Git integrations que possam publicar
   branches automaticamente, além dos workflows GitHub conhecidos.
2. Com acesso de leitura adequado, confirmar conta, DNS, Access, nomes livres,
   recursos de produção/Lab e permissões mínimas. Aprovar identidades de teste,
   políticas, custo/cota e transferência de `api-staging`.
3. Criar **um novo D1 e dois novos buckets privados**; salvar inventário dos IDs.
   Gerar e revisar config privada da API com o UUID real confirmado. Conferir a
   conta explicitamente antes de cada operação. Não confiar no nome da config como
   única proteção contra credenciais apontando para outra conta.
4. Aplicar as 18 migrations somente ao novo `DB`, usando explicitamente a config
   `wrangler.app-staging.jsonc`; consultar a lista aplicada nesse banco. Nunca usar
   o script npm `db:migrate:remote` padrão (seleciona produção).
5. Preparar novos secrets e publicar os três Workers com configs privadas;
   a primeira publicação da API cria o namespace DO próprio. Não executar scripts
   npm `deploy` padrão. Confirmar metadados e ausência de URLs públicas.
6. Configurar/auditar Access antes de ativar hostnames. Criar os custom domains
   `app-staging` e `admin-staging`, com certificado válido e DNS gerenciado pelo
   fluxo de custom domain. Não inventar CNAME para `workers.dev` desativado.
7. Transferir explicitamente `api-staging` do Worker Lab para o novo Worker, com
   janela e rollback aprovados. **Não** tentar simplesmente publicar uma segunda
   associação sobre o domínio já ocupado. Após transferência revisada, gerar config
   com `--with-domain`, revisar o diff e publicar apenas a API de staging.
   Preservar Worker, D1 e DO antigos do Lab. A transferência interrompe as sessões
   e simuladores que usavam o endereço antigo; planejar esse efeito mesmo sem hardware.
8. Executar a matriz abaixo com sessões novas e dados de teste. Registrar SHA,
   IDs de versão, DB UUID, DO namespace, buckets e evidências sem credenciais.
   Nova autorização será necessária para essas publicações e escritas remotas.

O gerador não sobrescreve a config privada para a etapa 7. Para adicionar o domínio,
gere em stdout sem `--write`, revise a saída e substitua manualmente o arquivo local
após a aprovação da transferência. Não automatizar criação de DNS ou Access com
payloads incompletos. Rollback de código/domínio não restaura dados nem desfaz
migrations; manter o novo banco separado evita afetar o Lab ou produção.

## Matriz ainda pendente no ambiente publicado

| Área | Evidência necessária |
| --- | --- |
| DNS/TLS/Access | 3 domínios resolvidos, certificados válidos, anônimo bloqueado, testador aprovado entra, não aprovado negado, tokens e políticas auditados |
| Sessões | Login/logout, cookie de aplicação host-only na API, SameSite/Secure/HttpOnly; cookies Access prontos para fetch/WS nos três domínios |
| Admin | Conta comum negada, superadmin de teste autorizado, consultas no banco novo e ausência de recursos de produção |
| Planos | Essencial 1 / Plus 2 / Pro 5; concorrência por última vaga; downgrade preserva vinculados e bloqueia apenas novas vagas |
| Recursos | Receitas/lotes/densidade conforme plano, histórico bruto filtrado, operação e telemetria dos simulados preservadas |
| Tempo real | Registro/vínculo, HTTP e WebSocket, comandos/ACK, reconexão, ausência de atualização entre organizações |
| R2 | Upload/download autenticados, isolamento por organização, firmware apenas simulado; sem escrita/leitura nos buckets de produção |
| Cron/D1 | Migrations 0001–0018 no banco novo, rollup, retenção inativa, contagens/custos; com `--with-maintenance`, offline e monitor D1 |
| E-mail | Permanece off inicialmente; se habilitado depois, um inbox aprovado, opt-in e destinatário externo à lista negado |
| Recuperação | Retirar domínio/reativar Lab mediante revisão; sessões e dados independentes; rollback não reverte schema/dados |

## Limitações e inconsistências registradas

- O endereço existente era Lab parcial, não staging completo; não reaproveitar seu
  D1/DO como se já contivesse a aplicação integrada.
- Auditar Access/DNS requer mais leitura autorizada; proteção observada via HTTP
  não comprova o escopo de todas as políticas.
- Cloud foi localizado em `maltworkspanel`; não existia config de staging nesse
  repositório. Seu tooling ainda fixa override `undici@7.29.0`, diferente da árvore
  já corrigida da API/Admin. Fazer triagem específica do Cloud antes da publicação;
  esta preparação não altera seu lockfile ou ferramenta de produção.
- Testes locais e CI não validam DNS, certificados, autorização Access, IDs reais,
  secrets, migrações remotas, R2 remoto ou entrega de e-mail.

Validação local desta preparação: TypeScript da API; 84 testes Workers/D1/WS;
38 testes Node (31 Lab, 3 compatibilidade, 4 configurações); 9 testes Admin;
7 testes Cloud. As três configs privadas foram lidas pelo Wrangler 4.118.0 com
geração de tipos fora dos repositórios, sem upload. Os tipos de produção não foram
sobrescritos. A geração lê a estrutura da config, não confirma IDs remotos.

Referências oficiais: [configuração Wrangler](https://developers.cloudflare.com/workers/wrangler/configuration/),
[cookies Access](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/),
[secrets](https://developers.cloudflare.com/workers/configuration/secrets/),
[Email em Workers](https://developers.cloudflare.com/email-service/api/send-emails/workers-api/).
