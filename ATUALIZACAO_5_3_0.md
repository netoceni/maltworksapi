# Atualização Maltworks Cloud API 5.3.0

Aplicar `0004_device_configuration.sql` antes de publicar o Worker 5.3.0.

A migração cria a configuração versionada por dispositivo e amplia a fila para
os comandos `set_configuration` e `acknowledge_alarms`. Comandos e receitas já
existentes são preservados durante a reconstrução da tabela.

Ordem segura:

1. instalar dependências, verificar TypeScript e executar os testes;
2. aplicar as migrações D1 no banco remoto;
3. publicar a API 5.3.0;
4. gravar o firmware 5.2.0;
5. publicar o painel 5.5.0.
