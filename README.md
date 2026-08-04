# Maltworks Cloud API 5.4.0

## Novidades 5.4.0

- acompanhamento manual da fermentação por controlador;
- OG, data de início, leituras de densidade e observações salvas no D1;
- exclusão de leituras incorretas e encerramento do acompanhamento;
- preservação da última curva encerrada até o início de um novo lote;
- cálculo de atenuação e ABV realizado pelo painel a partir dos dados cloud.

## Novidades 5.3.0

- configuração cloud-first versionada por controlador;
- comando único para histerese, proteção do compressor, calibração e alarmes;
- confirmação ou rejeição explícita pelo ESP32 e registro de auditoria;
- reconhecimento remoto dos alarmes ativos;
- compatibilidade de telemetria com o firmware 5.1.0 durante a atualização.

## Novidades 5.2.0

- biblioteca de receitas por organizacao;
- ate oito etapas por receita, persistidas no D1;
- comandos de iniciar, pausar, retomar e interromper perfis;
- entrega de uma copia completa ao ESP32 para execucao offline;
- auditoria de criacao, edicao, exclusao e execucao;

## Mantido da 5.1.3

- fila autenticada de comandos por controlador;
- primeiro comando remoto seguro: alteracao do setpoint;
- entrega na resposta da telemetria, sem uma segunda consulta periodica;
- expiracao automatica em 120 segundos;
- estados `pending`, `delivered`, `applied`, `rejected` e `expired`;
- confirmacao idempotente pelo ESP32 e registro no log de auditoria;
- bloqueio para dispositivo offline, perfil ativo e usuario `viewer`.

Primeiro servidor cloud do Maltworks Controller, feito para Cloudflare Workers + D1.

## O que esta versao entrega

- recebimento autenticado de telemetria do firmware 5.0.0;
- cadastro automatico do ESP32 como dispositivo pendente;
- armazenamento somente do hash do token do dispositivo;
- banco multitenant com organizacoes, usuarios, dispositivos e historico;
- criacao segura do primeiro usuario administrador;
- senhas protegidas com PBKDF2-SHA256 e um segredo independente do banco;
- login com cookie `HttpOnly`, `Secure` e `SameSite=Strict`;
- recuperacao administrativa temporaria de senha, protegida por segredo;
- vinculo por Device ID + codigo de oito caracteres;
- consulta de dispositivos, estado atual e historico;
- isolamento das consultas por organizacao;
- testes de integracao executados no runtime local da Cloudflare.

## Endpoints iniciais

| Metodo | Rota | Funcao |
| --- | --- | --- |
| GET | `/health` | Saude da API e do D1 |
| POST | `/v1/telemetry` | Telemetria do ESP32 |
| POST | `/v1/auth/bootstrap` | Cria o primeiro proprietario, uma unica vez |
| POST | `/v1/auth/login` | Login do painel |
| POST | `/v1/auth/recovery/reset-password` | Redefinicao temporaria protegida por segredo |
| POST | `/v1/auth/logout` | Encerra a sessao |
| GET | `/v1/me` | Usuario e organizacoes atuais |
| POST | `/v1/devices/claim` | Vincula um ESP32 pendente |
| GET | `/v1/devices` | Lista controladores da organizacao |
| GET | `/v1/devices/:id/latest` | Estado mais recente |
| GET | `/v1/devices/:id/telemetry` | Historico paginado |
| POST | `/v1/devices/:id/commands/setpoint` | Solicita novo setpoint remoto |
| GET | `/v1/recipes` | Lista receitas da organizacao |
| POST | `/v1/recipes` | Cria uma receita |
| PUT | `/v1/recipes/:id` | Atualiza uma receita |
| DELETE | `/v1/recipes/:id` | Exclui uma receita |
| POST | `/v1/devices/:id/commands/profile` | Inicia, pausa, retoma ou interrompe perfil |
| POST | `/v1/devices/:id/commands/configuration` | Atualiza controle, calibração e alarmes |
| POST | `/v1/devices/:id/commands/alarms` | Reconhece os alarmes atuais |
| GET | `/v1/devices/:id/fermentation` | Obtém o acompanhamento atual ou mais recente |
| POST | `/v1/devices/:id/fermentation` | Inicia acompanhamento com a OG |
| POST | `/v1/devices/:id/fermentation/readings` | Adiciona uma leitura manual |
| DELETE | `/v1/devices/:id/fermentation/readings/:readingId` | Exclui uma leitura manual |
| POST | `/v1/devices/:id/fermentation/finish` | Encerra o acompanhamento atual |

## Antes de publicar

Este pacote de atualizacao ja esta configurado para o banco D1
`maltworks-production` criado durante a implantacao da versao 5.1.0.

Para atualizar a instalacao existente, leia `ATUALIZACAO_5_4_0.md`. O arquivo
`DEPLOY.md` permanece como referencia para uma instalacao nova.
