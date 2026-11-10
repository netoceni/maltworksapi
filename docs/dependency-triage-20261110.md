# Triagem de dependências — 10/11/2026

Escopo: branch `fix/dependency-advisories-20261110`, sobre a integração da API
`260c97f3b562801cad86e56d544da60eb7e5c7eb` (PR #28). Desenvolvimento com dispositivos
simulados; nenhum merge na main, deploy ou migração remota.

## Resultado e exposição

Auditoria completa, incluindo dependências de desenvolvimento: **11 registros
(9 high, 2 moderate) antes; zero alertas conhecidos após a correção**. Auditoria
atualizada nesta data. O [resumo verificável](dependency-triage-20261110.json) contém
cada pacote, severidade, versões e os links dos avisos que originaram a avaliação.
Não são 11 falhas independentes: Wrangler, Miniflare e o pool também herdam alertas
de dependências. O resultado zero não prova ausência de falhas desconhecidas.

Os pacotes afetados estão em `devDependencies`/transitivas: ferramentas locais,
servidores de desenvolvimento, emulador e CI. A árvore `npm ls --omit=dev` está
vazia e a auditoria `--omit=dev` também retorna zero. Isso não justificava ignorá-los:
HTTP/WebSocket, imagens nativas e validação de configuração são usados nas
ferramentas. Não foi demonstrada exploração em um Worker publicado, nem realizada
análise de incidente. O código da API não recebeu uma correção de negócio nesta tarefa.

## Decisões de atualização

| Registros afetados | Decisão |
| --- | --- |
| Vitest / @vitest/mocker | 4.1.10 -> 4.1.12; patch do conjunto de testes |
| Vite | 8.2.0 -> 8.2.4; override na mesma linha 8.2 |
| Undici | override 7.29.0 -> 7.30.1 |
| Sharp | 0.35.2 -> 0.35.5; binários nativos/libvips correspondentes atualizados |
| Zod | 4.4.3 -> 4.6.6; mantém API major 4 |
| nanoid | 3.3.16 -> 3.3.20, por resolução compatível do lockfile |
| source-map-js | 1.2.1 -> 1.2.2, por resolução compatível do lockfile |
| Miniflare / Wrangler / pool Workers | Versões mantidas; alertas herdados eliminados pelos patches acima |

Wrangler 4.118.0, pool 0.20.1, Miniflare 5.20260730.0-alpha, workerd, TypeScript,
types e compatibility_date não foram trocados. A recomendação automática do audit
incluía voltar o pool para 0.12.21, com mudança potencialmente incompatível. O pool
latest consultado (0.23.0) ainda declarava Zod 4.4.3 e outro Miniflare alpha; não era
uma solução direta para todos os alertas e alteraria o runtime. Foi escolhida uma
árvore corrigida com overrides explícitos e validação de compatibilidade.

Sharp/Undici/Zod são fixados por versões exatas porque os pais ainda prendem
versões afetadas. Vite é fixado para não introduzir uma atualização 8.3 nesta
correção. nanoid/source-map-js ficam resolvidos pelo lockfile, sem overrides extras.
O lockfile também atualiza dependências compatíveis do conjunto Vitest/Vite/PostCSS
(como rolldown e seus binários de plataforma). Não foi executado `npm audit fix --force`.
Node 22/24 continuam sendo as versões de CI; Vite 8.2.4 requer Node >=22.12 na linha 22.

Referências primárias consultadas: [Vitest/mocker](https://github.com/advisories/GHSA-qxg6-89mg-rqv8),
[Sharp/librsvg](https://github.com/advisories/GHSA-wq5f-xc86-pv6w),
[Zod](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5),
[Undici/TLS](https://github.com/advisories/GHSA-2m5v-pch6-74hx), além dos avisos
Vite/nanoid/source-map-js e demais Undici listados no JSON. Versões, engines e
peer dependencies foram conferidos nos metadados oficiais do registro npm.

## Validação reproduzível

- Instalação pelo lockfile com `npm ci --ignore-scripts`, seguida de `npm ls --all`:
  árvore consistente. CI usa `npm ci` normal e verifica os binários Linux/Windows.
- `npm run check`: TypeScript aprovado.
- `npm test`: 82 testes (81 core + 1 realtime), incluindo ensaio integrado de dez
  controladores simulados em quatro organizações, D1/R2, planos, históricos,
  receitas, lotes, densidade e preservação de telemetria/controle.
- Lab: 31 testes aprovados.
- Três testes Node novos de compatibilidade: Sharp decodifica/redimensiona/recodifica
  uma imagem criada em memória; Undici consome gzip de servidor loopback e fecha a
  conexão; Zod mantém validação usada por configurações do pool. Não são provas de
  exploração ou testes destrutivos de DoS.
- `npm audit` completo: zero; `npm audit --omit=dev`: zero.
- Workflow de PR agora exige `npm audit --audit-level=moderate` no Linux e executa
  os novos testes nativos no Linux e no Windows Node 22/24, junto das regressões
  existentes. O resultado e SHA final do CI são registrados na descrição do PR.

## Admin e continuidade

O Admin integrado foi auditado separadamente: quatro registros high (Sharp,
Undici e os pais Miniflare/Wrangler), corrigidos na branch de mesmo nome do outro
repositório com os mesmos dois patches, sem alterar Wrangler. Tem PR próprio por
ser outro repositório. Não se soma esse quatro ao número original de 11 da API.

As integrações #28 e Admin #6 permanecem intactas; estes patches precisam de revisão
e incorporação posterior, sem presumir publicação. Guardar este diagnóstico como
snapshot; executar novas auditorias ao atualizar o lockfile. Remover os overrides
somente quando versões compatíveis dos pais resolverem os pacotes corrigidos e
passarem novamente pela auditoria e testes. Não silenciar alertas nem diminuir a
severidade exigida no CI para contornar falhas futuras.

Permanecem as validações remotas de staging do relatório de integração: recursos,
Access, navegador, migrações aplicadas, ensaio remoto e custos reais. Auditoria npm
não verifica firmware, configuração da conta, falhas lógicas ou dependências
embutidas no binário Node/workerd fora dos avisos do registro npm. Nenhum ajuste
em endpoints, regras de plano, credenciais, migrações ou workflow de deploy foi feito.
