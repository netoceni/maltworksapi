# Atualização Maltworks Cloud API 5.4.0

Aplicar `0005_fermentation_tracking.sql` antes de publicar o Worker 5.4.0.

A migração cria os acompanhamentos de fermentação e as leituras manuais de
densidade. Dispositivos, telemetria, receitas, configurações e comandos já
existentes não são alterados.

Ordem segura no PowerShell:

```powershell
npm.cmd install
npm.cmd run check
npm.cmd test
npm.cmd run db:migrate:remote
npm.cmd run deploy
```

Depois confirme que `https://api.maltworks.com.br/health` informa a versão
`5.4.0`. Somente então publique o painel 5.7.0.

O firmware 5.2.0 continua compatível e não precisa ser regravado para esta
atualização.
