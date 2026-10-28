# Maltworks Lab v0 — ferramenta INTERNA de teste de ESP32

**Não é um produto para clientes. Não existe interface de Lab no Cloud
comercial nem rota /lab na API de produção.** O gerador base funciona
inteiramente offline, sem credenciais. Um emissor separado, explicitamente
habilitado, pode enviar dados fictícios **somente à homologação**; nunca
à API de produção.

Status: PR draft, sem deploy, sem equipamentos físicos, sem criação
automática de infraestrutura Cloudflare.

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

## Transporte de homologação (somente desenvolvedores)

O Lab não entra no bundle do Worker nem no HTML do Cloud. Os scripts ficam
em `scripts/` e só rodam manualmente no terminal dos desenvolvedores.
`node scripts/maltworks-lab-staging.mjs` executa um **dry-run** sem rede.

O modo com envio exige `--send`, URL explícita de homologação,
**tokens falsos vinculados a dispositivos ativos numa organização de
staging**, e, para host remoto, credenciais de serviço Cloudflare Access:

```powershell
# Exemplo documental; o hostname ainda precisa ser criado/protegido.
# Nunca usar tokens reais ou o dominio api.maltworks.com.br.
$env:MALTWORKS_LAB_STAGING_TOKENS_JSON = '{"MW-C00000000000":"<TOKEN_TESTE_64_DIGITOS_HEX>"}'
$env:CF_ACCESS_CLIENT_ID = "<CLOUDFLARE_ACCESS_ID_TESTE>"
$env:CF_ACCESS_CLIENT_SECRET = "<CLOUDFLARE_ACCESS_SECRET_TESTE>"
node scripts/maltworks-lab-staging.mjs --send --endpoint https://api-staging.maltworks.com.br/v1/telemetry --devices 1 --ticks 12 --scenario alarm --pace-ms 30000
```

A primeira telemetria de um dispositivo ainda não vinculado retorna 202
(`pending`). Esse estado **não é aceito como sucesso** na sessão;
primeiro registrar e vincular cada dispositivo em uma organização da
homologação, sem usar banco, contas ou tokens de clientes.

A restrição de destino usa uma allowlist fixa: localhost/127.0.0.1/
::1 ou HTTPS em `api-staging.maltworks.com.br` e subdomínios de
`staging.maltworks.com.br`. Domínios de produção, workers.dev,
pages.dev, redirecionamentos, URL com login/senha ou query string
são recusados. O transporte não registra tokens nos logs.

A simulação rápida `--pace-ms 0` serve apenas para verificar o fluxo
de autenticação/HTTP; **não testa timeouts, offline de 90s ou agregação
de 180s**. Para testes temporais, manter `--pace-ms 30000`. O limite
da execução remota é 10 dispositivos e 120 intervalos, para não
esgotar a cota gratuita sem querer.

## Provisionamento seguro do ambiente

`wrangler.lab-staging.example.jsonc` é apenas um modelo propositalmente
**não implantável**: o UUID é um placeholder inválido. Copiar para
`wrangler.lab-staging.jsonc`, preencher **um novo D1 de staging** e
executar a checagem:

```bash
node scripts/maltworks-lab-stage-preflight.mjs wrangler.lab-staging.jsonc
node --test scripts/maltworks-lab*.spec.mjs
```

O guard bloqueia o UUID do D1 recuperado de produção, nomes do Worker
produtivo, routes indevidas, cron, R2, e-mail e outras bindings sensíveis.
Configurar Cloudflare Access e domínio de staging antes de expor o Worker
remotamente. Usar DO próprio, secrets fictícios e **nunca copiar** a
configuração e os bancos de produção.

**Limitação atual:** o conector disponível dá acesso ao GitHub, não cria
recursos Cloudflare. O ambiente remoto não foi criado nem testado ao vivo;
a configuração e o envio podem ser validados localmente até que o staging
exista. Em uma conta Cloudflare Free compartilhada com produção, testes
remotos também consomem as mesmas cotas da conta. Usar sessões curtas
ou uma conta de homologação separada.

## Próximas etapas
1. Expandir para modelos térmicos (inércia, compressor, histerese, ruído),
   rampas de fermentação e proteção do compressor.
2. Homologar o transporte já implementado no Worker **de staging**,
   com dispositivo previamente vinculado à organização e Cloudflare Access.
3. Simular falhas de Wi-Fi, atrasos, duplicações e reconexões sob carga.
4. Instrumentar latência, alarmes, comando aplicado/rejeitado, DO, CPU,
   D1 rows_written, crescimento do banco e perdas na curva agregada.
5. Opcional: dashboard **interno** de desenvolvimento, nunca incorporado
   ao produto Cloud comercial. Não é necessário na versão piloto.

O Lab **não deve** executar nem modificar o banco `maltworks-recovery-20261027`.
O roteiro principal de homologação encontra-se no PR API #14,
`docs/history-staging-free-10.md`.
