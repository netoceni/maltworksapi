# Validação integrada do staging completo

## Estado confirmado

API, Admin e Cloud foram publicados privadamente na conta
`4e8c08f70722d344cf39c362a110d706`. Workers.dev, previews e rotas dos três
estão desativados. Publicar os assets não conectou os navegadores à nova API:
`api-staging.maltworks.com.br` ainda atende o Lab antigo.
DNS e Access foram conferidos pelo painel autenticado. O
[plano de acesso protegido, transferência e rollback](staging-access-cutover.md)
preserva o único testador e IdP já existentes, prevê token novo somente na API,
CORS/OPTIONS e cookies entre os três hosts. Nenhuma configuração foi aplicada.

| Componente | Código publicado | Versão ativa |
| --- | --- | --- |
| API `maltworks-api-staging` | `e9606f45c237ae38ac22c49ade252c0d7201457f` | `7a78a58f-842d-4524-981f-70bfd65374f8` |
| Admin `maltworks-admin-site-staging` | `02fa706bbe3e68b2e5fba87d4a0123483da39984` | `494d4f56-4d11-4b60-ba67-5678118b0cb3` |
| Cloud `maltworks-cloud-site-staging` | `0c69022299433b4830a88a18eb90fae39c72e7bd` | `e69b60de-04f9-470c-b322-ee27f70168ad` |

D1: `5151e251-52c1-4406-8ae9-c6d38961d124`; DO SQLite:
`a7eef169f38d4a2d850c4bbed602f043`; R2:
`maltworks-staging-firmware` e `maltworks-staging-batch-files`.
Migrations 0001–0018 já aplicadas; três secrets exclusivos cadastrados na API.
Cron somente rollup, retenção/manutenção/e-mail desativados.

Evidências: [API](staging-private-publication.json) e
[publicação Admin/Cloud](staging-static-publication.json), incluindo hashes dos assets,
versões, ausência de bindings de dados, cabeçalhos registrados na versão remota
e comparação dos recursos existentes antes/depois. Commits documentais posteriores
não foram republicados. Nenhum merge na main ou deploy de produção.

## Validação local executada

Na API, com dependências do lockfile já instaladas:

```powershell
npm run check
npm test
node --test scripts/dependency-compatibility.spec.mjs scripts/full-staging-config.spec.mjs scripts/maltworks-lab*.spec.mjs
```

Resultado: TypeScript, 84 testes Workers/D1/DO e 38 testes Node aprovados.
Em Admin e Cloud: `npm run check`, nove testes aprovados em cada repositório,
mais `wrangler deploy --config wrangler.staging.private.jsonc --dry-run`.
Os testes iniciais de loopback tiveram EACCES pela restrição de execução; a repetição
com rede local permitida passou sem alterar código. Nenhum teste foi omitido.

O teste `test/development-integration-fleet.spec.ts` usa o entrypoint da API com
D1 local e dez controladores: Essencial 1, Plus 2, Pro 5 e outra organização Plus 2.
Confere sessões, claims concorrentes, quatro controladores excedentes recusados,
telemetria, isolamento, receitas, lotes/densidade, downgrade e Admin. As suítes de
planos cobrem a disputa pela última vaga em cada plano, mudança de plano durante
claims, histórico bruto e operação/ACK após downgrade. A suíte realtime cobre DO/WS.
Admin/Cloud verificam assets, cabeçalhos e seleção das URLs de staging.

São testes locais da aplicação; não comprovam navegador, Access, R2 remoto ou
execução das versões publicadas. Não foram usados secrets ou dados remotos.

## Preparação da próxima execução remota

1. Reconfirmar conta, três versões, D1/DO/R2 e configurações privadas. Atualizar o
   snapshot DNS/Access conforme a auditoria e o plano de retorno e revisar identidades dos
   testadores e credenciais exclusivas do simulador. Definir acesso privado ou
   protegido e revisar rollback antes de qualquer alteração de acesso.
2. Se forem usados os hostnames de staging, proteger os três antes de ativá-los.
   A transferência de `api-staging` deve apontar explicitamente ao Worker completo,
   não ao Lab. Comparar novamente bindings e versões antes de enviar dados. Esta
   etapa de publicação privada não ativou domínios nem autorizou sua transferência.
3. Preparar primeiro o superadmin de teste: `/v1/auth/bootstrap` exige zero usuários
   no banco; signup anterior impediria bootstrap. Obter a credencial do cofre somente
   em memória, sem registrar header, senha ou cookie. Depois criar quatro contas QA
   e organizações separadas, com nomes/identidades de teste aprovados.
4. Preparar grants Essencial/Plus/Pro e os downgrades no servidor. Ainda não há
   endpoint administrativo de assinatura/alteração de plano; a política consulta
   `organization_history_plans`. Um seed mínimo de QA deve ser revisado e limitado
   ao UUID de staging e aos IDs recém-criados, com leitura antes/depois. Não executar
   migrations novamente nem atribuir plano pelo corpo enviado pelo cliente.
5. Gerar dez credenciais novas de dispositivos simulados, guardar fora do Git e
   registrar/vincular 1 + 2 + 5 + 2 às organizações. Separar um excedente por
   organização. Os tokens determinísticos das fixtures locais não são credenciais
   remotas. Não copiar tokens, sessões ou dados do Lab/produção.
6. Executar a matriz abaixo e salvar somente resultados, IDs de teste, versões e
   horários. Revogar sessões/tokens e planejar a limpeza específica dos fixtures ao
   terminar; não apagar banco, buckets ou Lab como parte automática dos testes.

O CLI `scripts/maltworks-lab-staging.mjs` fica em dry-run sem `--send`.
**Não executar envio remoto para o endereço atual**: sua allow-list valida o hostname,
mas não identifica qual Worker está associado a ele. Após confirmar a transferência,
o envio exige endpoint explícito, mapa de tokens e credenciais Access; aceita 1–10
dispositivos. Primeiro registrar e vincular os simulados: resposta 202 significa
pendente, não sucesso da execução ativa. O soak longo é etapa posterior ao smoke.

## Matriz de aceite remoto

| Área | Ação e resultado esperado |
| --- | --- |
| Acesso | Anônimo e identidade não aprovada bloqueados; testador autorizado e simulador autorizado entram; TLS e cookies Access corretos |
| Sessão | Bootstrap antes de signup; login/logout; cookies host-only, Secure/HttpOnly/SameSite=Strict; CORS/OPTIONS apenas nas origens aprovadas |
| Admin/Cloud | Superadmin QA acessa Admin; conta comum recebe 403; Cloud vê apenas sua organização; nenhum request para API de produção |
| Limites | Essencial 1, Plus 2, Pro 5; excedente 403; duas disputas simultâneas pela última vaga admitem exatamente uma; plano do cliente ignorado |
| Planos | Receitas Plus/Pro; lotes/densidade Pro; histórico bruto limitado a 7/90/365 dias; viewer e outra organização não ganham acesso |
| Downgrade | Pro com cinco vinculados desce para Essencial: dispositivos/dados preservados, novas vagas e funções premium bloqueadas, telemetria, comandos e ACK continuam |
| Tempo real | Estado latest, alarmes, perda de sensor, reboot, WS/reconexão, comandos e ACK; nenhum evento entre organizações |
| R2 | Anexo e firmware fictícios, upload/download autenticados, negação entre organizações e sem acesso aos buckets de produção |
| Cron | Rollup observado, retenção zero; nenhum dado expirado; monitor/offline completo e e-mail continuam pendentes de habilitação específica |
| Operação | Conferir versões/logs/erros e recursos após teste; rollback de código/domínio não reverte dados ou migrations |

## Limites conhecidos e consolidação

- O Admin reconhece staging somente no hostname exato `admin-staging.maltworks.com.br`.
  Em localhost ou alias arbitrário ele seleciona produção. Não abrir a interface
  nesse endereço para teste integrado. Cloud aceita localhost para API local, mas
  aliases arbitrários também selecionam produção. A seleção do hostname correto
  passou nos testes estáticos; navegador real continua pendente.
- Admin/Cloud são assets-only, sem handlers ou bindings. A versão remota confirmou
  `serve_directly=true` e os cabeçalhos; os metadados não retornaram observability,
  apesar da declaração nos arquivos de configuração. Não considerar logs/traces
  desses frontends comprovados. Validar observabilidade de requisições na etapa de
  acesso; não adicionar um Worker intermediário só para contornar isso.
- Sem endpoint privado/protegido preparado, nenhum HTTP/WS/navegador remoto foi
  executado. Nenhuma conta ou credencial de simulador remoto foi criada nesta etapa.
  A auditoria de DNS/Access foi somente leitura; não é execução da matriz remota.
- A decisão é usar o staging completo como único ambiente de homologação. O Lab
  antigo permanece intacto até o aceite integrado e um plano específico de retirada.
  Nenhum novo ambiente foi criado além dos dois frontends já previstos.
