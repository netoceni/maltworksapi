# Ensaio seguro da aprovação manual

Preparado em 11/11/2026. **Não executado.** O PR #31 permanece sem integração.

## Conferência dos segredos

Consulta da tela autenticada de Actions secrets, sem abrir editores ou acessar valores:

| Nome | Escopo observado | Última atualização exibida (Brasília) |
| --- | --- | --- |
| `CLOUDFLARE_API_TOKEN` | Repositório | 04/08/2026 21h19 |
| `CLOUDFLARE_ACCOUNT_ID` | Repositório | 04/08/2026 21h20 |

O ambiente `production` não contém segredos nem variáveis. A presença dos nomes não comprova
valor correto, identidade da conta, validade, expiração ou permissões do token. A idade do
cadastro também não demonstra expiração. Nenhum valor foi lido, copiado, alterado ou revelado.

Os workflows `deploy.yml` e `d1-diagnostics.yml` referenciam esses dois nomes. O diagnóstico
atual utiliza o escopo do repositório e não declara `environment: production`; portanto a regra
de aprovação desse ambiente não limita seu acesso aos segredos. Seu script contém leituras D1,
mas as permissões reais da credencial continuam desconhecidas. Ele não foi executado.

Antes de uma publicação futura, conferir no local seguro de origem os recursos e permissões
da credencial, sem copiar seu valor para logs ou chat. Planejar uma credencial de escrita
restrita ao ambiente de produção e uma credencial de leitura separada para diagnóstico.
Inventariar os consumidores antes de remover ou substituir segredos do repositório. Essa
alteração de credenciais não foi realizada nem é necessária para o ensaio abaixo.

## Fluxo preparado

Arquivo: `.github/workflows/production-approval-rehearsal.yml`.
Nome exibido: **Ensaio seguro de aprovação**.

- Início somente manual, com confirmação marcada, branch `main` e primeira tentativa.
- Job associado ao ambiente `production`, mantendo `netoceni` como revisor obrigatório,
  sem bypass e com a restrição atual a `main`; nenhuma regra foi relaxada para testar.
- `permissions: {}`; nenhuma referência a segredos, token GitHub ou variáveis cadastradas.
- Sem checkout, dependências, ações externas, scripts da aplicação ou comandos Cloudflare.
- Única etapa: `printf` de mensagens fixas no resumo da execução.
- Aprovar esse ensaio libera apenas essa mensagem; não libera o workflow de publicação.

O GitHub exige que um workflow de início manual exista na branch padrão. Como este arquivo
ainda está somente no PR e `production` permite apenas `main`, o ensaio real permanece pendente
de uma futura integração autorizada. Não alterar a lista de branches para contornar essa condição.
O workflow antigo de `main` ainda pode publicar automaticamente; a futura integração deve incluir
a proteção de `deploy.yml` do PR #31, em vez de integrar este ensaio isoladamente.

## Roteiro para execução futura, mediante autorização

1. Conferir o SHA revisado em `main`, o conteúdo do arquivo do ensaio e as regras de `production`.
   Confirmar que a proteção de `deploy.yml` também foi integrada e que não há execução real de
   produção aguardando revisão. Não iniciar **Deploy API** ou **D1 read-only diagnostics**.
2. Em Actions, selecionar exclusivamente **Ensaio seguro de aprovação**, escolher `main` e
   marcar `confirm_rehearsal`. Antes de aprovar, registrar ID/SHA e comprovar a espera por revisão:
   a etapa que registra a mensagem ainda não deve ter iniciado.
3. Primeiro cenário: em **Review deployments**, selecionar `production` e **Reject**.
   A execução deve falhar por rejeição e a etapa da mensagem não deve executar.
4. Segundo cenário: iniciar uma NOVA execução manual do mesmo ensaio. Não reutilizar aprovação
   nem usar rerun. Confirmar nova espera e, nessa execução, aprovar como `netoceni`.
   O botão padrão do GitHub é **Approve and deploy**, mas neste arquivo ele libera apenas o
   `printf`; conferir novamente nome do workflow, ID e SHA antes de clicar.
5. Registrar as duas execuções e o histórico de revisão. No cenário positivo, somente a etapa
   da mensagem deve concluir. Se houver checkout, acesso a segredos, outros comandos ou outro
   workflow, interromper o ensaio e revisar a diferença antes de prosseguir.

Critérios de aceite: espera comprovada antes da decisão, rejeição impede a etapa, nova aprovação
permite somente a mensagem, registros associados ao ambiente correto e ausência de operações
na Maltworks. Execução ignorada por confirmação desmarcada, outra branch ou rerun não comprova
aprovação. O resultado do ensaio não autoriza publicar, migrar, integrar outros PRs ou concluir
a homologação dos dez controladores.

## Referências

- [Segredos no GitHub Actions](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-secrets)
- [Início manual de workflows](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflow_dispatch)
- [Aprovação e rejeição](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/review-deployments)
