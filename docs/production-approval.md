# Aprovação manual para produção

Proposta preparada em 11/11/2026, sobre `main` em
`a2e4bfd0794d6bfc2d4defa788973fcd1f509750`. O workflow proposto não foi integrado nem executado.

## Comportamento proposto

- Push em `main`: instala dependências e executa a validação, sem acessar credenciais Cloudflare.
- Publicação: somente por `workflow_dispatch`, selecionando `main` e marcando a confirmação de produção.
- Após os testes, o job de produção espera a aprovação do ambiente GitHub `production`.
- Antes das migrações e novamente antes do deploy, a trava consulta somente metadados do GitHub.
  Exige revisores configurados, aprovação humana registrada para o ID desse ambiente e o mesmo
  commit ainda na ponta de `main`. Erros de consulta bloqueiam a operação.
- Reexecuções são bloqueadas para impedir reutilizar uma aprovação antiga. Se uma etapa falhar,
  investigar o estado do D1/Worker antes de iniciar outra execução manual e obter nova aprovação.
- Migração e deploy usam o mesmo commit validado; há uma aprovação para a sequência inteira.
  A concorrência de produção continua serializada e sem cancelamento automático.

## Configuração do ambiente

Estado confirmado em 11/11/2026 no GitHub e por consulta somente leitura:

- Ambiente **production**, ID `26973307828`, criado e configurado.
- **Required reviewers** habilitado com o usuário `netoceni`.
- Bypass de regras por administradores desabilitado, conferido na tela salva.
- **Selected branches and tags** com uma regra do tipo branch para `main` e nenhuma tag.
- **Prevent self-review** desabilitado: o único aprovador pode iniciar e aprovar a execução
  em duas ações explícitas. Exigir outra pessoa depende de cadastrar outro aprovador.
- Nenhum segredo ou variável cadastrado no ambiente. Os segredos existentes do repositório
  não foram movidos, alterados nem revelados; sua governança permanece pendente.

Para revisar ou reproduzir a configuração em Settings → Environments → **production**:

1. Ativar **Required reviewers** e escolher explicitamente quem aprovará as publicações.
2. Desativar **Allow administrators to bypass configured protection rules**.
3. Em **Deployment branches and tags**, usar **Selected branches and tags** e permitir apenas a
   branch `main`, sem tags. A branch atual não é protegida; a opção genérica de branches protegidas
   não substitui a seleção explícita.
4. Se houver outro responsável habilitado, ativar **Prevent self-review** para aprovação por outra
   pessoa. Não ativar essa opção com um único aprovador que também inicia a execução, pois bloqueará
   a operação. O requisito mínimo desta proposta é uma aprovação humana explícita.
5. Colocar `CLOUDFLARE_API_TOKEN` e `CLOUDFLARE_ACCOUNT_ID` no ambiente `production`. Conferir que
   o token de escrita existente possui somente o escopo operacional necessário para a API e seu D1.
   O token somente leitura do painel não serve para esta finalidade. Não registrar valores no Git.
   Após inventariar os demais consumidores, retirar eventuais cópias dos segredos de produção no nível
   do repositório para evitar que outros workflows os usem fora do ambiente aprovado.

Na consulta inicial do mesmo dia havia zero ambientes; esse estado foi substituído pela
configuração acima. A trava continua bloqueando migração/deploy se faltarem regras ou aprovação
humana registrada. Criar o ambiente não protege o workflow antigo que ainda não o referencia:
a proteção deste fluxo só será vinculada após a integração futura e autorizada do PR #31.

## Integração e validação futura

Revisar esta alteração antes das promoções dos PRs #28/#30. O workflow antigo de `main` continua
ativo enquanto a proposta não for integrada. Não promover os PRs para produção contando com uma
proteção que ainda não está ativa. A proposta não altera os comandos nem o alvo de produção definido
no Wrangler: Worker `maltworks-api`, binding `DB` → `maltworks-recovery-20261027`.

Para comprovar a espera e a recusa sem afetar recursos, preparar futuramente um ensaio separado que
termine em uma etapa sem efeito. **Não usar o workflow real de produção como teste**, pois aprová-lo
autoriza as migrações e o deploy. Nenhuma execução desse workflow foi iniciada nesta preparação.

Os testes locais `node --test scripts/production-approval.spec.mjs` usam respostas simuladas, sem
rede, token real, D1 ou Worker. Eles cobrem ausência de regras/aprovação, bot, rejeição,
mudança de SHA, reexecução e falhas do GitHub. Não substituem o ensaio futuro do ambiente protegido.

Se `main` mudar entre a migração e o deploy, a segunda trava bloqueia o deploy. Nesse caso o banco
pode já ter sido migrado: investigar e decidir a recuperação manualmente. Não há rollback automático
de D1 nem garantia de atomicidade entre banco e Worker. Revisar compatibilidade das migrações antes
da aprovação. A proteção aplica-se a este workflow; permissões para publicar diretamente pela
Cloudflare/Wrangler precisam de governança própria.

## Referências oficiais

- [Ambientes e revisores obrigatórios](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments)
- [Consulta do ambiente](https://docs.github.com/en/rest/deployments/environments#get-an-environment)
- [Histórico de aprovação da execução](https://docs.github.com/en/rest/actions/workflow-runs#get-the-review-history-for-a-workflow-run)
