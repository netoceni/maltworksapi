# Maltworks Cloud 5.19 — Histórico Inteligente (primeira entrega)

Status: **protótipo validado somente em banco D1 isolado**, não ativar em produção.

## Concluído nesta branch
- Migração aditiva `0017_smart_history_5m.sql`: agregados de cinco minutos e checkpoint por dispositivo.
- Agregação por janela completa, limitada a 12 buckets por execução.
- Medições médias, mínimas e máximas de geladeira, poço térmico e setpoint.
- Contagem de amostras, alarmes e estado de aquecimento/refrigeração.
- UPSERT por `(device_id, bucket_start)` para idempotência, transação de agregado + checkpoint.
- Testes de SQL isolado: valores nulos dos sensores, buckets fechados, reinício do processo e ausência de exclusão.

## Ainda não deve ocorrer em produção
- O job não está conectado ao cron.
- Nenhum endpoint Cloud foi alterado.
- A retenção bruta de 7 dias segue a implementação anterior. **Ainda não existe proteção de exclusão baseada no checkpoint.**
- Não integrar esse PR até finalizar a cobertura pré-limpeza e o backfill idempotente (especialmente dados com mais de sete dias).

## Próximas etapas técnicas
1. Backfill paginado: começar pela janela mais antiga por dispositivo, respeitar orçamento de linhas D1.
2. Alterar o cleanup para exigir agregação confirmada antes de excluir qualquer bucket antigo.
3. Criar agregados horários derivados de 5 minutos; definir retenção de 90 dias/1 ano após mensurar custo.
4. Consultas API que componham 7 dias de amostra bruta + períodos antigos agregados sem descontinuidades.
5. Cloud: seletor de resolução e indicação de média/mínima/máxima; tooltip e comparação de lotes.
6. Telemetria simulada em homologação para testar múltiplos controladores e diferentes períodos.
7. Testar crash entre persistência, atualização do checkpoint e limpeza. Não perder informação histórica.
8. Verificar quotas de leitura/escrita e tamanho D1 antes de publicar a migração.

## Questões que aguardam decisão de produto
- Retenção Plus/Pro: 90 dias em cinco minutos e 1 ano em resolução horária?
- Guardar histórico de todos os controladores igualmente ou usar limites por assinatura?
- Atribuir históricos diretamente a lotes com snapshot da receita e data de início/término?
- Exportação CSV e relatório PDF em um estágio posterior?

Não há mudança de schema em produção nem remoção de telemetria neste PR.
