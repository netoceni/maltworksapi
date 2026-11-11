# Staging completo de Admin + Cloud + API — preparação de 10/11/2026

Status: API, Admin e Cloud de staging publicados privadamente. A API usa três secrets e namespace DO
SQLite exclusivos, D1/R2 isolados e migrations 0001–0018 previamente validadas.
Workers.dev, previews, routes e custom domains continuam desativados para a nova API.
Admin/Cloud usam Workers estáticos exclusivos, sem bindings de dados; a main continua sem merge.
O staging completo será o ambiente de homologação consolidado. Lab e hostname
`api-staging` permanecem intactos até a transferência protegida e o aceite integrado.
Execução local, preparação dos simuladores e pendências remotas:
[validação integrada](staging-integrated-validation.md).
API/Admin partem de `integration/development-20261110`; Cloud usa o repositório
`netoceni/maltworkspanel`. As branches `prepare/full-staging-20261110` não alteram a main.

## Inventário e próximas etapas

| Componente | Recurso exclusivo | Situação / ação futura |
| --- | --- | --- |
| API completa | Worker `maltworks-api-staging` | Publicado privadamente; versão `7a78a58f-842d-4524-981f-70bfd65374f8` |
| Banco | D1 `maltworks-app-staging` | `5151e251-52c1-4406-8ae9-c6d38961d124`; 0001–0018 aplicadas e schema validado |
| Tempo real | DO SQLite `RealtimeHub` do novo Worker | Namespace exclusivo `a7eef169f38d4a2d850c4bbed602f043`; tag `v1-realtime-app-staging` |
| Firmware de teste | R2 privado `maltworks-staging-firmware` | Criado, zero objetos, r2.dev desativado e nenhum custom domain |
| Anexos de lotes | R2 privado `maltworks-staging-batch-files` | Criado, zero objetos, r2.dev desativado e nenhum custom domain |
| Admin | Worker estático `maltworks-admin-site-staging` | Publicado privadamente; versão `494d4f56-4d11-4b60-ba67-5678118b0cb3` |
| Cloud do cliente | Worker estático `maltworks-cloud-site-staging` | Publicado privadamente; versão `e69b60de-04f9-470c-b322-ee27f70168ad` |
| Acesso | Access nos três hostnames exatos | Auditar configuração existente e preparar política de testadores e simuladores |
| Endereços | `admin-staging`, `app-staging`, `api-staging.maltworks.com.br` | Criar os dois primeiros custom domains; planejar transferência do terceiro |

Todos os recursos ficam na mesma conta Cloudflare já usada pelo projeto
(`4e8c08f70722d344cf39c362a110d706`). O isolamento é de recursos, credenciais e dados;
faturamento, cotas da conta e permissões dos operadores continuam compartilhados.
Não copiar dados pessoais, firmware publicado, senhas, sessões ou credenciais de produção.

Inventário verificado: [staging-resources-20261110.json](staging-resources-20261110.json).
Conta e nomes foram conferidos antes de cada criação; o novo UUID não existia no
inventário anterior. D1 e buckets ficaram em ENAM; R2 usa classe Standard, e a
replicação de leitura D1 está desativada. Na verificação da criação, o banco tinha
somente `_cf_KV`, sem schema da aplicação ou migrations. Os buckets foram confirmados
vazios e privados por metadados, r2.dev e lista de domínios; não foram alterados na
etapa posterior de migrations.

As migrations 0001–0018 foram aplicadas após nova autorização específica. Conta,
permissão D1, nome/UUID e os hashes dos 18 arquivos foram conferidos imediatamente
antes da operação. Foi usada somente a config privada e o banco `maltworks-app-staging`
na conta `4e8c08f70722d344cf39c362a110d706`; não foi usado o script npm remoto de produção.
Não há migrations pendentes. A validação comparou o DDL de todas as 36 tabelas de
aplicação e 40 índices explícitos com o schema produzido pelos mesmos arquivos em
SQLite local, incluindo colunas, PK/FK/CHECK/UNIQUE e predicados de índices parciais:
nenhuma divergência, objeto ausente ou objeto inesperado. `PRAGMA quick_check=ok`,
`foreign_key_check` sem violações e zero registros em todas as tabelas da aplicação.
As consultas de validação tiveram `rows_written=0`.

Evidências: [staging-migrations-0001-0018.json](staging-migrations-0001-0018.json), com
hashes, nomes e horários das 18 migrations, comparação e contagens. Consultas de
contagem com UNION ALL foram recusadas pelo D1 (7500); contagens simples e PRAGMAs
separados passaram. O Wrangler/Node no Windows também apresentou uma falha ao encerrar
após esses erros de consulta. As migrations não foram reaplicadas, e nenhum desses
erros de leitura alterou schema/dados. Nenhum usuário, administrador ou dispositivo
foi cadastrado; esse estado inicial ainda precisa ser preparado em etapa autorizada.

A primeira tentativa do bucket de anexos retornou erro interno Cloudflare 10001.
Uma nova listagem confirmou que ele não existia; uma única repetição criou o bucket.
Os recursos anteriores foram preservados. Atenção ao nome: a configuração de
produção usa `maltworks-recovery-20261027` (UUID `a1bf5a75-1bec-4437-92fa-64e69c3da081`);
também existe um banco legado chamado `maltworks-production`, com UUID distinto.
Nenhum deles nem o Lab foi reutilizado. Os novos recursos estão vinculados somente
ao Worker privado `maltworks-api-staging` nesta publicação.

Foi gerado localmente `wrangler.app-staging.jsonc`, ignorado pelo Git, com o UUID
novo e bindings `DB`, `FIRMWARE`, `BATCH_FILES`. A configuração aplicada continua sem routes,
workers.dev, preview URLs ou EMAIL. O template
versionado mantém seu placeholder. Os quatro testes do gerador passaram novamente.

Primeira publicação privada: código do commit `e9606f45c237ae38ac22c49ade252c0d7201457f`,
versão `7a78a58f-842d-4524-981f-70bfd65374f8`, deployment
`28f2a228-f6df-4226-9358-73c566c8b721`. O inventário remoto confirmou os três bindings
`secret_text`, o novo DO com `use_sqlite=true`, o D1 e os dois buckets esperados.
Produção/Lab tiveram settings, schedules e deployments comparados antes/depois, sem
mudanças. Todos os custom domains e routes da zona permaneceram idênticos;
`api-staging.maltworks.com.br` continua no Lab antigo. Cron inicial de rollup a cada
cinco minutos ativo, manutenção e retenções desativadas. Nenhum usuário/dispositivo
foi cadastrado. Não foi aberto endpoint público para testar health/HTTP/WebSocket.
Evidências e limites em [staging-private-publication.json](staging-private-publication.json).

Admin e Cloud foram publicados posteriormente com suas configurações privadas,
usando os commits `02fa706bbe3e68b2e5fba87d4a0123483da39984` e
`0c69022299433b4830a88a18eb90fae39c72e7bd`. Versões remotas confirmaram assets
diretos, cabeçalhos e nenhum binding; workers.dev/previews desativados, sem routes,
custom domains ou schedules. Inventários de Workers existentes, DOs, Pages e suas
publicações de produção, domínios e rotas foram comparados antes/depois, sem mudança.
Não houve nova publicação da API, acesso ao cofre ou criação de dados de teste.
Evidências: [staging-static-publication.json](staging-static-publication.json).
Logging/traces dos frontends estáticos não foram comprovados pelos metadados,
apesar da configuração declarada; verificar na futura etapa de acesso.

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
migrations ao novo `maltworks-app-staging` nem prova que o código integrado foi publicado.

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

- API: `wrangler.app-staging.example.jsonc` mantém o placeholder de UUID para outros
  ambientes. A config privada local já contém o UUID do inventário. O gerador
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

**Preparação local concluída:** `PASSWORD_PEPPER`, `PASSWORD_RESET_SECRET` e
`BOOTSTRAP_SECRET` novos, distintos e exclusivos da API de staging. Cada valor tem
256 bits de aleatoriedade criptográfica, protegido por DPAPI CurrentUser fora dos
repositórios, com ACL privada e validação de recuperação. Nenhum valor foi exibido,
versionado, exportado em texto ou enviado ao Cloudflare. O helper local verifica
também a ausência dos valores no índice Git e não rotaciona um cofre existente.

**Cadastro remoto concluído na publicação privada autorizada:** `wrangler deploy`
com a config privada e `--secrets-file` enviou os três valores junto ao código e à
migration inicial do DO. Foi usado um JSON temporário fora do Git, em diretório com
ACL privada; arquivo e logs temporários foram removidos ao final. Os valores não
foram exibidos/versionados nem rotacionados. O cofre DPAPI permanece preservado.
O remoto confirma os nomes como `secret_text`, sem permitir leitura dos valores.
O Worker não existia antes (10007); agora tem versão base. Para futuras alterações
não ativadas, `versions secret bulk` continua disponível. Não usar scripts do Lab.

Procedimento, histórico e validações em [staging-secrets.md](staging-secrets.md) e
[registro sem valores](staging-secrets-preparation.json). A preparação local sozinha
não envia os secrets; nesta etapa houve envio explicitamente autorizado. Preservar
o perfil/chaves DPAPI do usuário.

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

## Sequência de ativação — recursos, migrations e publicação privada concluídos

1. Revisar PRs e CI, reconciliar código de integração e registrar SHAs aprovados.
   Auditar no painel eventuais Workers Builds/Git integrations que possam publicar
   branches automaticamente, além dos workflows GitHub conhecidos.
2. Com acesso de leitura adequado, confirmar conta, DNS, Access, nomes livres,
   recursos de produção/Lab e permissões mínimas. Aprovar identidades de teste,
   políticas, custo/cota e transferência de `api-staging`.
3. **Concluído: novo D1 e dois buckets privados criados**, conforme inventário acima.
   Config privada da API gerada localmente com o UUID real. Reconfirmar conta/IDs
   e revisar essa config antes de qualquer próxima operação. Não recriar recursos
   por seguirem ausentes do Lab ou de uma lista consultada em outra conta.
4. **Concluído: 0001–0018 aplicadas e schema validado** exclusivamente no novo D1
   `5151e251-52c1-4406-8ae9-c6d38961d124`, com `wrangler.app-staging.jsonc`.
   Não reaplicar manualmente nem usar `db:migrate:remote` padrão (seleciona produção).
   Qualquer futura migration fora desse intervalo precisa de autorização própria.
5. **Concluído para API/Admin/Cloud: publicação privada**, com secrets/DO próprios
   na API, sem URLs públicas ou bindings de dados nos frontends. Não executar scripts
   npm `deploy` padrão para staging. Os commits publicados estão registrados acima;
   mudanças posteriores somente documentais não exigem nova publicação.
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
- Cloud foi localizado em `maltworkspanel`; a configuração de staging foi preparada
  no [Cloud #12](https://github.com/netoceni/maltworkspanel/pull/12).
  A pendência de dependências foi resolvida pelo
  [Cloud #13](https://github.com/netoceni/maltworkspanel/pull/13), commit
  `fdfb60da423e6802cee966e62e0ba91ec704c35f`, incorporado à branch do #12 sem
  conflitos: Undici 7.30.1 e Sharp 0.35.5, mantendo Wrangler/Miniflare/workerd.
  No conjunto, instalação limpa, nove testes locais e auditorias completa/produção
  com zero alertas conhecidos. O SHA e CI final ficam no PR #12. A main continua
  sem merge; zero alertas no conjunto não implica encerramento dos alertas na main.
- Testes locais e CI não validam DNS, certificados, autorização Access, IDs reais,
  secrets, migrações remotas, R2 remoto ou entrega de e-mail.

Validação local desta preparação: TypeScript da API; 84 testes Workers/D1/WS;
38 testes Node (31 Lab, 3 compatibilidade, 4 configurações); 9 testes Admin;
9 testes Cloud no conjunto com as correções do #13. As três configs privadas foram lidas pelo Wrangler 4.118.0 com
geração de tipos fora dos repositórios, sem upload. Os tipos de produção não foram
sobrescritos. A geração lê a estrutura da config, não confirma IDs remotos.

Após a incorporação do Cloud #13 ao #12, a pendência de dependências deixa de
bloquear a preparação desse conjunto. A criação do D1/R2 também foi concluída.
As migrations 0001–0018 no banco novo também estão concluídas e validadas.
Os três secrets estão preparados localmente e cadastrados na API publicada privadamente,
com DO SQLite exclusivo. Continuam pendentes auditoria DNS/Access e contas de teste,
proteção/ativação dos domínios e
transferência de `api-staging`, seguida de validação com controladores simulados.
API, Admin e Cloud de staging já foram publicados privadamente. Não houve merge na
main, publicação de produção/Lab ou alteração de domínios/Access. O checklist
do Cloud está em [staging.md](https://github.com/netoceni/maltworkspanel/blob/prepare/full-staging-20261110/docs/staging.md).

Referências oficiais: [configuração Wrangler](https://developers.cloudflare.com/workers/wrangler/configuration/),
[cookies Access](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/),
[secrets](https://developers.cloudflare.com/workers/configuration/secrets/),
[Email em Workers](https://developers.cloudflare.com/email-service/api/send-emails/workers-api/).
