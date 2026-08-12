# Atualização 5.7.0 — Painel administrativo

Esta versão adiciona autorização administrativa de sistema e endpoints para o
painel separado em `admin.maltworks.com.br`.

## Ordem de publicação

1. Aplicar a migração D1 `0008_system_admins.sql`.
2. Publicar a API 5.7.0.
3. Publicar o projeto Pages `maltworks-admin`.
4. Associar `admin.maltworks.com.br` ao novo projeto.

A migração concede a função `superadmin` somente à conta mais antiga já
existente. Em uma instalação vazia, o bootstrap cria o primeiro usuário e
atribui essa função na mesma operação.

## Verificação

- uma conta administrativa deve receber `200` em `/v1/admin/me`;
- uma conta comum autenticada deve receber `403`;
- `/v1/admin/users` não deve conter e-mail, nome, hash de senha, sessões ou
  tokens.
