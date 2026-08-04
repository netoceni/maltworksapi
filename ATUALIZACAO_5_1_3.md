# Atualizacao da API 5.1.2 para 5.1.3

Esta versao adiciona a tabela `device_commands` e precisa aplicar a migracao
remota antes da publicacao do Worker.

```powershell
npm.cmd install
npm.cmd run check
npm.cmd test
npm.cmd run db:migrate:remote
npm.cmd run deploy
```

A migracao preserva usuarios, sessoes, dispositivos, credenciais, telemetria e
estado atual. Nenhum segredo novo e necessario.
