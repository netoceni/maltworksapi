# Maltworks API — retenção por amostragem e publicação controlada

**Status:** PR [API #13](https://github.com/netoceni/maltworksapi/pull/13), revisão necessária.
**Banco:** `maltworks-recovery-20261027`. Não altera migrações, contas, receitas, lotes, anexos ou retenção atual.

## Diagnóstico que motivou a mudança

Em 28/10/2026 às 09h43 BRT, o workflow remoto somente leitura
[40561199502](https://github.com/netoceni/maltworksapi/actions/runs/40561199502),
tentativa 2, mediu:

- Tamanho: 15.814.656 bytes (15,81 MB, 3,2% dos 500 MB).
- Telemetrias totais e das últimas 24 h: 10.119.
- Registros expirados pela janela de sete dias: 0.
- Linhas D1 escritas nas últimas 24h: 84.178, ~84% da cota Free como comparação.
- A contagem de 24 horas é uma janela móvel. A cota gratuita reinicia em
  00:00 UTC; a comparação não é o uso exato do dia UTC.

D1 executa pelo menos três comandos de escrita por telemetria persistida.
O total real inclui escrita em índices e outros eventos. A medição de ~8,3
linhas escritas por telemetria é **aproximada**, pois nem todas as gravações
da janela vieram da ingestão.

## Novo comportamento da API

1. O ESP32 continua transmitindo HTTP na mesma cadência (ex.: 5s), sem
   alteração no firmware. Token de dispositivo é verificado em toda requisição.
2. A API transmite cada estado autenticado ao Durable Object, que mantém
   estado instantâneo na memória e presença em SQLite próprio; a transmissão
   WebSocket para o Cloud continua em tempo real.
3. Com estados estáveis, `telemetry`, `device_latest_state` e
   `devices.last_seen_at` só são escritos no D1 a cada **60 segundos**.
4. Mudança de alarme (ativação/normalização), estado de sensor, relé,
   estado de controle, perfil/etapa, configuração, firmware e ACK de comando
   força gravação imediata independentemente da janela de 60 segundos.
5. Flutuação ordinária de temperatura, RSSI, contagem de segundos e
   rampas contínuas de setpoint não força gravação adicional.
6. O estado instantâneo usado por `/latest`, `/devices`, validações
   de comando, pré-checagem OTA, inventário OTA e contadores online do Admin
   consulta primeiro o DO e usa D1 como fallback caso indisponível.
   O histórico de até **15 minutos** recebe até 180 pontos de alta resolução
   temporariamente mantidos em memória no DO; após hibernação ou reinício
   do DO, a curva usa os pontos do D1 (resolução de 60s) como fallback.
7. Alertas de offline são comandados pelo DO após 30s sem contato.
   A varredura D1 usa margem para evitar falsos offline pelos snapshots
   amostrados e confirma a presença no DO.
8. Quando DO falha, o D1 é fallback a cada **30 segundos**, e não a cada
   pacote HTTP; a frequência permanece limitada para impedir nova saturação.
9. Frames antigos/retransmitidos não sobrescrevem o estado atual do D1 ou
   DO. Em caso de reboot no mesmo segundo, a sequência e o timestamp
   emitidos pelo firmware ajudam a resolver a ordem. Um frame duplicado
   ainda pode confirmar a reconexão sem recriar eventos de alarme.

## Configuração

`TELEMETRY_PERSIST_INTERVAL_SECONDS` no `wrangler.jsonc`:

- `60`: valor recomendado para piloto, previsto para publicação.
- `30` a `300`: períodos válidos quando o orçamento operacional for revisto.
- `0`: **somente reversão emergencial**, retorna às escritas legadas em
  toda telemetria e pode saturar o banco; não manter ativado.
- Valor inválido retorna ao padrão seguro de `60`.

A variável é lida no Worker. Alterá-la no painel Cloudflare ou no
`wrangler.jsonc` exige verificar qual configuração prevalece após deploy.

## Economia teórica em períodos estáveis

| Cadência HTTP | Amostras HTTP/dia | Amostras D1/dia com janela de 60s | Redução nas amostras brutas |
| --- | ---: | ---: | ---: |
| 5 s | 17.280 | 1.440 | 91,7% |
| 15 s | 5.760 | 1.440 | 75,0% |
| 30 s | 2.880 | 1.440 | 50,0% |

São valores **por dispositivo** em estado estável. Mudanças importantes
geram amostras extras. A economia efetiva de linhas escritas deve ser
confirmada nas métricas remotas após publicação.

## Pré-implantação — não pular

- CI: `npm run check`, `npm test` em D1 isolado aprovados;
  exigir resultados do **último commit** deste PR. Revisão de 28/10:
  [run 40701689027](https://github.com/netoceni/maltworksapi/actions/runs/40701689027)
  aprovou 23 testes (7 arquivos), inclusive concorrência entre sequências,
  retorno de estado após reinício e histórico live sem nova escrita no D1.
- Confirmar política de segurança do login, comandos, OTA, alarmes,
  presença e reentrada após perda de Wi-Fi.
- Executar diagnóstico somente leitura e confirmar a saúde do banco
  de produção; preservar o banco antigo como referência.
- Não executar comandos `DROP`, `DELETE` manuais, importações,
  backups restaurados ou reconfiguração do binding D1.
- O merge na `main` aciona deploy automático do Worker. **Exigir decisão
  de publicar** depois da revisão; PR em rascunho não faz deploy.
- Registrar horário de publicação para comparar antes/depois nas métricas D1.

## Pós-implantação e critérios de reversão

- Verificar ingestão HTTP 200/202 e envio de comandos a partir do Cloud,
  estado em tempo real, atualização de gráficos, notificações de alarme,
  offline/online, comandos e agendamento OTA (sem instalar firmware).
- Medir `rows_written_24h`, tamanho, telemetrias/h, taxa de erros
  Cloudflare Workers e custo do Durable Object.
- Pausar e investigar diante de falha no envio de comandos, estado
  desatualizado no Cloud, alertas de offline falsos ou problemas em
  notificações críticas. Reverter Worker somente com plano controlado;
  nunca restaurar banco antigo por causa de falha de código.
- `TELEMETRY_PERSIST_INTERVAL_SECONDS=0` é apenas mitigação temporária
  para voltar à semântica legada; acelera novamente as escritas, portanto
  requer observação da cota D1 e correção/reversão de código.

## Ainda não entregue neste PR

- Agregados de 5 minutos/horários e histórico de longo prazo. A limpeza
  de 7 dias permanece intacta; `range=all` **não** cria arquivo permanente.
- E2E em hardware, simulação de redes intermitentes em campo,
  testes de carga multi-dispositivo e validação de custos Durable Objects.
- O buffer de 15 minutos é **volátil e não constitui histórico durável**.
  Requer futura agregação em D1/R2 para retenção de longa duração.
- Mensagens de um boot antigo com relógio completamente dessincronizado
  podem não ser ordenáveis após uma hibernação do DO. A proteção é forte
  para o fluxo normal de sequência monotônica, mas não é uma garantia
  de ordenação total distribuída sob falhas simultâneas de relógio e rede.
- Proteção da branch `main` (não disponível para escrita nesta integração).

A próxima fase exige agregar o histórico antes de excluir qualquer amostra
bruta, para preservar curvas antigas.
