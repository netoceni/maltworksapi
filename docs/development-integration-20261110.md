# Integração de desenvolvimento — 10/11/2026

Estado: validação local concluída; CI dos PRs de integração registrado nas descrições
correspondentes. **Não constitui autorização de publicação.** Não há dispositivos
reais rodando; todos os controladores deste relatório são simulados.

## Composição reproduzível

Branch `integration/development-20261110` em ambos os repositórios, partindo das
respectivas `main`. A API incorpora a cadeia até #27 e, separadamente, #22 por
merge local sem conflitos. O Admin incorpora #4. A ancestralidade de cada commit
abaixo foi verificada; nenhum PR original foi alterado, fechado ou mesclado na main.

| Repositório / PR | Commit incorporado |
| --- | --- |
| API main de partida | a2e4bfd0794d6bfc2d4defa788973fcd1f509750 |
| API #21 — Lab portável | cb7854c985ec8d5199844003b4c473693d583a93 |
| API #22 — D1 Paid | 8f2899e9bb09a173fbec521e6bf1ac91d02810a0 |
| API #24 — política e cota atômica | b509a9050cc3e85e0b13aaa187aa506f0d38a702 |
| API #25 — histórico bruto | 8b3dcf664d95f2a1caa10024c1b0a32ae6a01420 |
| API #26 — receitas | 4730c947c4dbaa3384f0821bac0294ce4c152738 |
| API #27 — lotes/densidade | a9373b0aeb3c988370e85f94ae24b3432eb4620d |
| Admin main de partida | 2620a25ff085e287cbd8f836bcecf5f3892748ca |
| Admin #4 — isolamento staging | d2f915d38bfd687682f657f7093d33b944b7ef14 |

A integração adiciona somente teste e documentação ao código já proposto nesses
PRs. Não modifica workflows, lockfiles ou migrações. O #22 altera a configuração
proposta da API para D1 Paid; isso foi incorporado, mas não publicado.

## Validações locais concluídas

Windows Node 24.18.1, versões fixadas pelo projeto:

| Verificação | Resultado |
| --- | --- |
| TypeScript da API | Aprovado |
| `npm test` API completa | 82 testes: 81 core + 1 realtime |
| `node --test scripts/maltworks-lab*.spec.mjs` | 31 testes aprovados |
| `npm run check` Admin integrado | 6 testes aprovados |
| `test-staging-ps-syntax.ps1` | Sintaxe e guardas de staging aprovadas; não provisiona recursos |
| `test-lab-socket-cleanup.ps1` | Ambos os scripts 06/07 aprovados contra peer local sem resposta |
| `test-lab-process-exit.ps1` | Códigos 0/7 preservados e relatório sem metadados de filesystem |
| Simulador SQLite de capacidade 1/5/10 dispositivos | Mesmas asserções do CI aprovadas |

O simulador usa HTTP/heartbeat de 30 s, persistência de 180 s e eventos assumidos
em 2%. Para 10 dispositivos, estima 28.800 requisições HTTP/dia, 57.600 requisições
DO/dia, 50.304 escritas D1/dia e 90,2 MB estabilizados, sem crescimento projetado da
fila de retenção. São hipóteses/estimativas e SQL local, **não** faturamento, latência
ou capacidade comprovada no Cloudflare. Uma primeira execução esbarrou na restrição
do diretório temporário do desktop; passou ao usar um temporário dentro do workspace,
sem alteração do simulador.

## Novo ensaio integrado reproduzido no CI

`test/development-integration-fleet.spec.ts` chama o entrypoint HTTP real com
bindings locais. Usa cadastro de usuário/sessão verdadeiro, cookies com
HttpOnly/Secure/SameSite=Strict e concessões de plano somente no D1 de teste.
Não faz requisições de rede aos domínios usados como URLs das requisições.

- Quatro organizações: Essencial 1, Plus 2, Pro 5, Plus 2 = 10 vinculados.
- Dez dispositivos iniciam pendentes e são vinculados concorrentemente. Quatro
  dispositivos adicionais ficam pendentes após rejeição por cota; total final 14,
  dos quais 10 vinculados/online e 4 pendentes. Campos de plano na requisição não
  ultrapassam a cota.
- Telemetria simultânea, transições de alarme/recuperação, persistência de amostras,
  últimas leituras, listagens isoladas por organização e histórico bruto.
- Receitas no Plus/Pro; lotes/densidade somente Pro; downgrade do Pro mantém os
  cinco dispositivos autenticando/enviando enquanto bloqueia acesso premium.
- Preflight/CORS com origem administrativa de staging em bindings locais, rejeição
  da origem de produção nesse cenário e 401/403/200 conforme sessão/função de sistema.
  O overview e a listagem administrativa refletem os dez dispositivos; a listagem
  não expõe os e-mails de cadastro.
- Monitor D1 Paid executado no mesmo cenário, com snapshot diário e sem alterar
  as amostras de telemetria. Os demais testes cobrem os limites Free/Paid e backlog.

Os testes anteriores continuam cobrindo concorrência da última vaga, histórico
7/90/365 dias, tentativas de acesso por outra organização/viewer, CRUD, anexos R2,
downgrade/revogação, restauração de acesso e comandos simulados.

## Pendências antes de publicar em ambiente remoto

1. **Ambiente e recursos:** confirmar Worker/domínios/DNS, TLS e Access reais;
   verificar que API, D1, Durable Objects e R2 de staging estão isolados. O arquivo
   `wrangler.lab-staging.example.jsonc` é um modelo com D1 placeholder e guardas
   restritas ao Lab; não comprova um backend administrativo completo. R2 de anexos,
   firmware e política de e-mail exigem configuração própria de staging.
2. **Credenciais e permissões:** verificar segredos, credencial Access do Lab e
   usuário administrador de teste no ambiente remoto, sem copiar credenciais de
   produção nem expô-las em relatórios.
3. **Migrações:** comparar as migrações existentes no repositório com as realmente
   aplicadas no D1 de staging e no destino da futura publicação. Esta integração
   não adiciona SQL de migração, mas isso não prova que os bancos já estão atualizados.
4. **Fluxo no navegador:** validar Cloud + Admin + API reais, login/logout, cookies,
   CORS/CSP sob Access e mensagens de plano/downgrade. O frontend Cloud não faz parte
   dos dois repositórios inspecionados. O Admin teve validação estática; o ensaio
   administrativo da API não equivale a navegar no Admin publicado.
5. **Ensaio remoto controlado:** reproduzir dez controladores em quatro organizações,
   com confirmação de rotas/recursos antes de enviar. Exercitar WebSocket, reconexão,
   retries, alarmes, cotas, históricos, receitas, lotes, densidade e anexos; registrar
   duração/cadência/perdas. O ensaio local curto não é um soak remoto de 30 minutos.
6. **Agendamentos/serviços:** confirmar cron, rollups, retenção, snapshots diários,
   políticas de notificação/e-mail e métricas reais da conta D1 Paid. A medição por
   banco e a simulação não substituem custos/limites reais da conta.
7. **Preparação da publicação:** revisar recuperação do D1 e reversão da API; o
   rollback de código não desfaz migrações/dados automaticamente. O workflow de push
   na main ainda executa migrações remotas e deploy. Não fazer merges individuais
   que publiquem versões intermediárias. A decisão de publicação segue pendente.

## Inconsistências e trabalho separado

- Auditoria atual do lockfile: 11 entradas afetadas (9 high, 2 moderate, 0 critical),
  incluindo ferramentas diretas Wrangler/Vitest/pool Workers e transitivas. Resultado
  não é uma contagem de falhas independentes nem prova de exploração em produção.
  Parte das sugestões automáticas altera versões major do pool; não executar correção
  automática sem revisão de compatibilidade. Triagem/correção e revalidação seguem
  pendentes; nenhum lockfile foi atualizado nesta tarefa.
- A API usa concessões manuais sem assinatura/expiração/cobrança. Exportações,
  notificações e alinhamento comercial/UI ainda têm trabalho na issue API #23.
- Frontend Admin continua com pacote/README 5.18 e indicação da API 5.19. Isso não
  impede o teste estático, mas precisa de decisão sobre identificação de versões.
- Os PRs anteriores ficam abertos. Os PRs de integração apresentam o conjunto contra
  main; evitar publicar duplicadamente os PRs originais e os de integração. Estratégia
  final de merge depende de revisão e autorização posterior.
- Segurança e testes físicos de firmware permanecem no acompanhamento privado,
  necessários antes de piloto físico/comercial. Não foram validados nesta integração.

Nenhum deploy (incluindo staging), migração/SQL remoto, provisionamento, modificação
da main ou envio real de e-mail foi feito. O binding de e-mail nos testes é simulado.
