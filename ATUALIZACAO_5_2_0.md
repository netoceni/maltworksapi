# Atualização Maltworks Cloud API 5.2.0

Esta versão adiciona a biblioteca de receitas na nuvem e comandos seguros de
início, pausa, retomada e interrupção dos perfis executados pelo ESP32.

## Ordem de atualização

Execute, nesta ordem:

1. `npm.cmd install`
2. `npm.cmd run check`
3. `npm.cmd test`
4. `npx.cmd wrangler d1 migrations apply maltworks-production --remote`
5. `npm.cmd run deploy`

A migração `0003_cloud_recipes.sql` preserva os comandos de setpoint já
existentes e amplia a tabela para os novos comandos de perfil.
