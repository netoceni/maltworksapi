import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Only GitHub metadata is read here. This script never calls Cloudflare.
export async function verifyProductionApproval({ env = process.env, fetchImpl = fetch } = {}) {
  const fail = (message) => { throw new Error(message); };
  if (env.GITHUB_REPOSITORY !== 'netoceni/maltworksapi') fail('Repositório de produção inesperado.');
  if (env.GITHUB_EVENT_NAME !== 'workflow_dispatch' || env.GITHUB_REF !== 'refs/heads/main') {
    fail('Produção exige início manual selecionando a branch main.');
  }
  if (env.PRODUCTION_CONFIRMED !== 'true') fail('Confirmação de produção ausente.');
  // Approval history is per run, not per attempt. Never reuse approval on reruns.
  if (env.GITHUB_RUN_ATTEMPT !== '1') fail('Reexecução bloqueada: inicie uma nova execução e obtenha nova aprovação.');
  if (!/^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? '') || !/^[1-9][0-9]*$/.test(env.GITHUB_RUN_ID ?? '')) {
    fail('Identificação da execução ou do commit inválida.');
  }
  if (!env.GH_TOKEN) fail('Token de leitura do GitHub ausente.');

  async function read(path) {
    let response;
    try {
      response = await fetchImpl(`https://api.github.com/repos/netoceni/maltworksapi/${path}`, {
        method: 'GET',
        redirect: 'error',
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${env.GH_TOKEN}`,
          'X-GitHub-Api-Version': '2026-03-10',
        },
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      fail('Não foi possível consultar a aprovação no GitHub. Produção bloqueada.');
    }
    if (!response.ok) fail(`Consulta de aprovação recusada pelo GitHub (HTTP ${response.status}).`);
    try { return await response.json(); }
    catch { fail('Resposta de aprovação inválida. Produção bloqueada.'); }
  }

  const environment = await read('environments/production');
  if (!Number.isSafeInteger(environment?.id) || environment.id <= 0 || environment.name !== 'production') {
    fail('Ambiente production ausente ou inválido.');
  }
  const rules = environment.protection_rules;
  if (!Array.isArray(rules) || !rules.some(rule => rule?.type === 'required_reviewers' && Array.isArray(rule.reviewers) && rule.reviewers.length > 0)) {
    fail('Configure revisores obrigatórios no ambiente production antes de publicar.');
  }

  const reviews = await read(`actions/runs/${env.GITHUB_RUN_ID}/approvals`);
  if (!Array.isArray(reviews)) fail('Histórico de aprovações inválido.');
  const matching = reviews.filter(review => review.environments?.some(item =>
    item.id === environment.id && item.name === 'production'));
  if (matching.some(review => review.state === 'rejected')) fail('Existe uma rejeição para esta execução.');
  const approval = matching.find(review => review.state === 'approved' &&
    review.user?.type === 'User' && Number.isSafeInteger(review.user.id) && review.user.id > 0 && review.user.login);
  if (!approval) fail('Aprovação humana de production ausente. Um registro de aprovação é obrigatório.');

  // Check last, immediately before the next privileged step.
  const main = await read('git/ref/heads/main');
  if (main?.object?.sha !== env.GITHUB_SHA) fail('main mudou após o início: execute novamente e obtenha nova aprovação.');
  return { sha: env.GITHUB_SHA, environment: 'production', reviewer: approval.user.login };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const result = await verifyProductionApproval();
    console.log(`Aprovação humana confirmada para production, commit ${result.sha}.`);
  } catch (error) {
    // Never print API response bodies, headers or tokens.
    console.error(`Produção bloqueada: ${error.message}`);
    process.exitCode = 1;
  }
}
