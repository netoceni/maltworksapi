# DNS, Access e transferência do staging completo — preparado, não aplicado

A verificação foi de leitura. Nenhum registro, aplicação/política Access, token,
domínio ou Worker foi criado, alterado, publicado ou removido nesta etapa.
Não houve merge na main. O endereço existente continua no Lab; os três Workers
do staging completo continuam privados.

## O que foi confirmado

Conta `4e8c08f70722d344cf39c362a110d706`; zona `maltworks.com.br`, ID
`108c035cd334643e7bb933bffe3050e4`, ativa. A conta foi reconferida pelo Wrangler
local 4.118.0 e no painel autenticado. Como o projeto tem configuração Wrangler,
foram usados Wrangler e leituras GET para os metadados que ele não oferece.

| Item | Estado observado |
| --- | --- |
| `api-staging.maltworks.com.br` | Registro gerenciado tipo Worker, proxied, TTL Auto, associado a `maltworks-api-lab-staging` |
| `admin-staging` e `app-staging` | Sem registros na tabela completa da zona; NXDOMAIN em Cloudflare e Google para A/AAAA/CNAME |
| DNS da zona | Dez registros; nenhum wildcard; produção e e-mail mantidos |
| HTTPS anônimo na API atual | `/` e `/health` retornam 302 para `sweet-violet-7f81.cloudflareaccess.com`; TLS validado, sem seguir redirect |
| Aplicações Access | Uma: `api-staging`, ID `f5e112f8-df81-42f0-91c7-f0c4cda3da97`, hostname exato, sem path, sessão 24h |
| Acesso humano | Política `5824fe44-76ed-42f4-bb06-07b617589d4f`, Allow para um e-mail explícito, sem Require/Exclude; endereço omitido deste registro |
| Login | Um provedor One-time PIN, ID `36e8b7b4-8513-4615-b35b-26d7a6bcce40`; aplicação aceita todos os provedores disponíveis |
| Simuladores antigos | Política Service Auth `f83d31ed-c98d-4edb-8fde-df184abdf42b`, com os tokens `Maltworks Lab Staging CLI` e `Maltworks Lab Simulator Local`, habilitados, expiração exibida 30/10/2027 |
| CORS no Access | OPTIONS para origem desativado; origens/métodos não configurados e allow-credentials desativado |
| Cookies Access | HttpOnly e binding cookie desativados; eager redirect ativo; SameSite não selecionado |
| Admin/Cloud no Access | Nenhuma aplicação para os dois novos hostnames |

Não havia Bypass entre as duas políticas anexadas à aplicação da API. Os valores
dos tokens e do cofre não foram abertos. O flag API `reusable` das políticas atuais
não foi comprovado; não presumir migração ou reaproveitamento automático.

**Divergência de visibilidade:** a credencial OAuth existente recebeu 403 para DNS
e Access da zona. As coleções Access da conta retornaram 200 com listas vazias,
inclusive apps, políticas, provedores e tokens. O painel autenticado mostrou os
objetos acima. A causa da divergência não foi determinada; lista vazia dessa leitura
não prova ausência de Access. O painel permitiu concluir a leitura dos campos
visíveis. Não foram ampliadas permissões, extraídas credenciais do navegador nem
exportados JSONs integrais das aplicações/políticas. Antes de aplicar mudanças,
reconfirmar o estado completo pelo painel ou por credencial de leitura adequada.

Evidência consolidada: [staging-access-cutover-plan.json](staging-access-cutover-plan.json).

## Configuração proposta para revisão

Manter três aplicações de hostname exato. Preservar a aplicação existente da API,
seu audience e a regra humana com o mesmo único testador; criar aplicações separadas
para Admin e Cloud. Assim, o Service Auth do simulador fica somente na API.
Não anexar o token a uma aplicação multidomínio que também permita os frontends.
Usar o mesmo provedor de PIN por e-mail já existente, explicitamente selecionado,
e sessão humana de 24h, sem adicionar testadores ou assumir grupos sincronizados.

Para os frontends, preparar uma política **nova e reutilizável** com a mesma lista
humana, obtida da política existente na hora da aplicação. Não salvar o e-mail
em Git. Para a API, preparar outro Service Auth reutilizável e token novo
`Maltworks Full Staging Simulator`, validade proposta 168h. O ID e o segredo ainda
não existem. Guardar a credencial nova em armazenamento privado, fora do Git, sem
logs e sem colocá-la no JavaScript. Não reutilizar nem revogar os tokens do Lab
durante esta preparação. Access não substitui sessão Maltworks ou token do dispositivo.

Proposta CORS: encaminhar **somente OPTIONS** à API completa, que já valida as
origens exatas de Admin/Cloud, devolve 204 com credentials e rejeita origem estranha
com 403. GET/POST/PUT/DELETE/WS continuam passando pelo Access e pela autorização
da aplicação. Não adicionar política Bypass geral, Everyone, wildcard, exceção de
`/health` ou de `/v1/*`. Não usar o header Authorization para o token Access: ele
continua reservado à aplicação/dispositivo; usar o par de headers CF-Access no CLI.

Habilitar HttpOnly do cookie Access na configuração proposta. Os três hostnames
terão aplicações separadas: visitar cada um em navegação de topo e autenticar antes
do primeiro fetch/WS; eager redirect não garante cookie em outra aplicação.
Revisar Lax/None do cookie Access com os redirects reais. O cookie Maltworks
`mw_session` permanece host-only, Secure, HttpOnly e SameSite=Strict.
Não alterar políticas globais da conta ou o navegador para contornar falhas.

## Sequência futura da transferência

Esta sequência ainda precisa de autorização para aplicação/ativação protegida.
As quatro configurações candidatas de triggers estão no inventário JSON e passaram
apenas pelo `triggers deploy --dry-run`. Não executar a variante sem dry-run agora.

1. Reconfirmar identidade do operador, conta/zona, snapshots completos do Access,
   DNS gerenciado, custom domain e versões/recursos abaixo. Qualquer divergência
   interrompe a operação. Conferir escopos específicos de DNS/Access caso se use API;
   os escopos atuais não bastam para automatizar essa auditoria de forma confiável.
2. Pausar simuladores do Lab. Preparar as duas aplicações Access dos frontends,
   sem DNS/custom domains, e políticas reutilizáveis revisadas. Criar e guardar o
   token exclusivo; não enviar tráfego com ele antes de confirmar a nova associação.
3. Na aplicação Access **existente** da API, preservar a regra humana; preparar
   HttpOnly/CORS e trocar a associação Service Auth antiga pela nova, sem apagar
   a política/tokens antigos. Isso impede que as duas credenciais Lab alcancem a
   API completa após a transferência. O Lab pode ficar sem acesso de serviço
   durante a janela; não há hardware real em operação. Manter proteção em toda a janela.
4. Transferir **só** `api-staging` ao Worker `maltworks-api-staging`. Não apagar o
   registro primeiro nem criar CNAME manual ou rota wildcard. Revisar a diferença
   de um único hostname e conservar cron `*/5 * * * *`, workers.dev/previews off,
   versão, secrets e bindings existentes. Nenhum deploy de código é necessário
   para a associação proposta; a opção de triggers deve ser revista pelo operador.
5. Conferir associação, versão, D1/DO/R2 e negação anônima. Com o token novo,
   health deve responder; sem sessão Maltworks, rotas autenticadas continuam 401.
   Tokens antigos devem ser negados. Testar OPTIONS das duas origens e de uma
   origem estranha. Não usar só o texto/version de `/health` para identificar o
   Worker: Lab e API completa têm versão de aplicação 5.19.0. Usar metadados e IDs.
6. Somente após esse smoke aprovado, associar `admin-staging` e `app-staging` aos
   respectivos Workers já privados, mantendo Access previamente aplicado. Validar
   DNS/TLS, anônimo/identidade não autorizada, cookies dos três hosts, CORS e WS.
   **Não executar esses passos de ativação nesta preparação.**
7. Preparar bootstrap/contas/grants/credenciais QA e executar a
   [matriz integrada](staging-integrated-validation.md). Registrar evidências sem
   credenciais. O Lab só será retirado após aceite e plano separado.

**Comportamento importante do Wrangler 4.118.0:** `triggers deploy` é experimental;
seu dry-run não prova a transferência ou propagação. A implementação instalada de
custom domains habilita `override_existing_origin` e `override_existing_dns_record`
quando stdout não é TTY. Portanto, um comando automatizado pode reassociar um
hostname ocupado **sem perguntar**. A orientação anterior de que simplesmente
publicar a segunda associação seria recusado era insuficiente. Usar prechecks e
revisão explícita do diff; não depender de prompt, não rodar script npm de produção
e não preparar launcher que aplique esses candidatos automaticamente.

## Rollback preparado

| Item preservado | Baseline para retorno |
| --- | --- |
| Worker Lab | `maltworks-api-lab-staging` |
| Versão / deployment Lab | `17cf9e1d-9c5e-4af4-9152-33edfa4a6b05` / `732cae46-3776-4ce1-8b8d-ca47e8f42f37` |
| D1 / DO Lab | `26b9ecab-1aaa-4120-93a5-1c409555d28b` / `70f543b57d9747c1870e728977a3bc64` |
| Aplicação Access | `f5e112f8-df81-42f0-91c7-f0c4cda3da97`, hostname exato |
| Políticas antigas | Humana `5824fe44-76ed-42f4-bb06-07b617589d4f`; Lab Service Auth `f83d31ed-c98d-4edb-8fde-df184abdf42b` |
| Cron e URLs alternativas | `*/5 * * * *`; workers.dev/previews continuam off |

Disparar rollback se qualquer recurso apontar para produção/Lab indevidamente,
Access permitir tráfego não autorizado, os tokens antigos entrarem na nova API,
ou falharem login, CORS, WS ou operações básicas sem correção imediata revisada.
Meta operacional proposta: retorno em até dez minutos; **não foi medido nem ensaiado remotamente**.

1. Parar os simuladores e suspender uso dos frontends. Se houver falha de proteção,
   restabelecer negação no hostname afetado antes de reassociar qualquer serviço;
   manter a aplicação Access, sem regras Allow/Service Auth ativas enquanto se
   investiga. Não retirar Access de um hostname ainda roteado.
2. Reconferir a versão/D1/DO Lab preservados e reassociar apenas `api-staging` ao
   Lab com o candidato de retorno revisado; não republicar código/config de Lab
   a partir desta branch, cujo código é da API completa.
3. Depois de confirmar o hostname no Lab, restaurar a associação à política Service
   Auth antiga e retirar a nova, mantendo a lista humana original. Não reverter
   automaticamente HttpOnly ou outras proteções compatíveis para valores mais fracos.
   Rever CORS conforme o Lab e manter frontends fechados se não estiver validado.
4. Remover somente as novas associações de hostname dos frontends, ou mantê-las
   sob negação exata enquanto houver investigação. Manter Access até confirmar que
   não há endpoint roteado. Não apagar os Workers nem mudar os domínios de produção.
5. Conferir TLS, 302/negação anônima, health autorizado do Lab, política/tokens e
   recursos. Guardar os dados QA da API completa para análise; o retorno ao Lab
   não copia usuários, sessões, telemetria ou anexos entre os ambientes.

O rollback de domínio não desfaz escritas D1/R2/DO ou migrations. Nenhum banco,
bucket, namespace, Worker, segredo ou credencial antiga será removido pelo plano.

## Validação desta preparação e limites

Antes/depois: custom domains, rotas, bindings, versões e flags privadas dos quatro
Workers conferidos, sem mudança; cron idêntico ao inventário anterior. Quatro
dry-runs de triggers aprovados. Reexecutados localmente o cenário integrado de
dez dispositivos (incluindo Admin/CORS) e quatro testes de guardas de configuração.
Não houve testes autenticados remotos, envio de telemetria ou criação de conta/token.
Login humano, cookies, CORS e WS reais continuam pendentes da janela protegida.

Referências oficiais: [políticas Access](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/),
[cookies e eager redirect](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/),
[CORS e OPTIONS](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/cors/),
[service tokens](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/),
[custom domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/),
[comandos de triggers](https://developers.cloudflare.com/workers/wrangler/commands/workers/#triggers-deploy).
