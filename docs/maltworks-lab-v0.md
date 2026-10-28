# Maltworks Lab v0 — simulador OFFLINE de ESP32

Status: protótipo de teste, em PR separado. **Não controla relés,
não acessa internet, não contém credenciais e não envia HTTP**.

## Objetivo
Gerar telemetria JSONL determinística conforme o schema do Controller para
testar a API e o Histórico Inteligente sem hardware. O piloto Free
prevê **10 controladores virtuais a cada 30 segundos**; o gerador
aceita até 25 somente para testes de carga futuros em ambiente isolado.

## Exemplos
```bash
node scripts/maltworks-lab.mjs --devices 10 --frames 12 --interval 30 --scenario normal > lab-10.jsonl
node scripts/maltworks-lab.mjs --devices 1 --frames 12 --scenario alarm > alarm.jsonl
node scripts/maltworks-lab.mjs --devices 2 --frames 20 --scenario reboot > reboot.jsonl
node --test scripts/maltworks-lab.spec.mjs
```

Cada linha é um objeto de telemetria válido; nenhuma linha inclui token de
produção. Todas as identidades e timestamps são fictícios e reproduzíveis.

## Cenários disponíveis
- `normal`: resfriamento e estabilização térmica determinísticos
- `alarm`: alarme ativado e resolvido
- `sensor-loss`: sensor desconecta e recupera
- `reboot`: novo boot ID, sequência reinicia, `sentAt` continua avançando
- `offline`: o controlador 0 deixa de emitir frames por alguns ciclos
- `command`: um ACK `applied` de comando na sequência 7

## Próximas etapas
1. Expandir para modelos térmicos (inércia, compressor, histerese, ruído),
   rampas de fermentação e proteção do compressor.
2. Injetar JSONL em um Worker **de staging** autenticado com contas e tokens
   fictícios exclusivos, usando um transport que bloqueie por padrão todos
   os domínios públicos (especialmente `api.maltworks.com.br`).
3. Simular falhas de Wi-Fi, atrasos, duplicações e reconexões sob carga.
4. Instrumentar latência, alarmes, comando aplicado/rejeitado, DO, CPU,
   D1 rows_written, crescimento do banco e perdas na curva agregada.
5. Interface visual do Lab, com relógio acelerado e múltiplos controladores
   e cenários configuráveis.

O Lab **não deve** executar nem modificar o banco `maltworks-recovery-20261027`.
O roteiro completo de homologação encontra-se no PR API #14,
`docs/history-staging-25-controllers.md`.
