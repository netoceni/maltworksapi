import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyProductionApproval } from './production-approval.mjs';

const sha = 'a'.repeat(40);
function fixture() {
  const env = {
    GITHUB_REPOSITORY: 'netoceni/maltworksapi',
    GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/main',
    GITHUB_RUN_ATTEMPT: '1', GITHUB_RUN_ID: '123', GITHUB_SHA: sha,
    PRODUCTION_CONFIRMED: 'true', GH_TOKEN: 'fake-token-never-a-real-credential',
  };
  const environment = {
    id: 42, name: 'production',
    protection_rules: [{ type: 'required_reviewers', reviewers: [{ type: 'User', reviewer: { id: 1 } }] }],
  };
  const reviews = [{ state: 'approved', environments: [{ id: 42, name: 'production' }],
    user: { id: 1, login: 'human-reviewer', type: 'User' } }];
  const main = { object: { sha } };
  const calls = [];
  const responses = new Map([
    ['environments/production', environment],
    ['actions/runs/123/approvals', reviews],
    ['git/ref/heads/main', main],
  ]);
  const fetchImpl = async (url, options) => {
    assert.equal(options.method, 'GET');
    assert.equal(options.redirect, 'error');
    assert.ok(url.startsWith('https://api.github.com/repos/netoceni/maltworksapi/'));
    const path = url.split('/maltworksapi/')[1];
    assert.ok(responses.has(path), `Unexpected API path: ${path}`);
    calls.push(path);
    return { ok: true, status: 200, json: async () => responses.get(path) };
  };
  return { env, environment, reviews, main, calls, responses, fetchImpl };
}

test('permits a manually approved first attempt at the current main SHA using GET only', async () => {
  const f = fixture();
  assert.deepEqual(await verifyProductionApproval(f), { sha, environment: 'production', reviewer: 'human-reviewer' });
  assert.equal(f.calls.at(-1), 'git/ref/heads/main');
});

for (const [name, field, value] of [
  ['push', 'GITHUB_EVENT_NAME', 'push'],
  ['pull request', 'GITHUB_EVENT_NAME', 'pull_request'],
  ['another branch', 'GITHUB_REF', 'refs/heads/development'],
  ['main tag', 'GITHUB_REF', 'refs/tags/main'],
  ['another repository', 'GITHUB_REPOSITORY', 'other/api'],
  ['unchecked confirmation', 'PRODUCTION_CONFIRMED', 'false'],
  ['rerun reusing approval', 'GITHUB_RUN_ATTEMPT', '2'],
  ['missing token', 'GH_TOKEN', ''],
  ['invalid SHA', 'GITHUB_SHA', 'main'],
  ['invalid run ID', 'GITHUB_RUN_ID', '../123'],
]) {
  test(`blocks ${name} before any API request`, async () => {
    const f = fixture(); f.env[field] = value;
    await assert.rejects(verifyProductionApproval(f));
    assert.equal(f.calls.length, 0);
  });
}

test('blocks an environment created automatically with no protection', async () => {
  const f = fixture(); f.environment.protection_rules = [];
  await assert.rejects(verifyProductionApproval(f), /revisores obrigatórios/);
});
test('blocks an empty required reviewers rule', async () => {
  const f = fixture(); f.environment.protection_rules[0].reviewers = [];
  await assert.rejects(verifyProductionApproval(f), /revisores obrigatórios/);
});
test('blocks a job started without a human approval record', async () => {
  const f = fixture(); f.reviews.length = 0;
  await assert.rejects(verifyProductionApproval(f), /Aprovação humana/);
});
test('blocks approval for a different environment ID with the same name', async () => {
  const f = fixture(); f.reviews[0].environments[0].id = 43;
  await assert.rejects(verifyProductionApproval(f), /Aprovação humana/);
});
test('blocks automated bot approval', async () => {
  const f = fixture(); f.reviews[0].user.type = 'Bot';
  await assert.rejects(verifyProductionApproval(f), /Aprovação humana/);
});
test('blocks rejected production runs', async () => {
  const f = fixture(); f.reviews.push({ ...f.reviews[0], state: 'rejected' });
  await assert.rejects(verifyProductionApproval(f), /rejeição/);
});
test('blocks main advancing while waiting for approval or after migrations', async () => {
  const f = fixture(); f.main.object.sha = 'b'.repeat(40);
  await assert.rejects(verifyProductionApproval(f), /main mudou/);
});
test('checks fresh metadata every time, including the second guard before deploy', async () => {
  const f = fixture(); await verifyProductionApproval(f);
  f.reviews.length = 0;
  await assert.rejects(verifyProductionApproval(f), /Aprovação humana/);
});
for (const status of [401, 403, 404, 429, 500]) {
  test(`fails closed on GitHub HTTP ${status}`, async () => {
    const f = fixture(); f.fetchImpl = async () => ({ ok: false, status });
    await assert.rejects(verifyProductionApproval(f), new RegExp(`HTTP ${status}`));
  });
}
test('does not expose network error details or credentials', async () => {
  const f = fixture(); f.fetchImpl = async () => { throw new Error(f.env.GH_TOKEN); };
  await assert.rejects(verifyProductionApproval(f), error =>
    /Produção bloqueada/.test(error.message) && !error.message.includes(f.env.GH_TOKEN));
});
test('fails closed on invalid JSON', async () => {
  const f = fixture(); f.fetchImpl = async () => ({ ok: true, json: async () => { throw new Error('bad JSON'); } });
  await assert.rejects(verifyProductionApproval(f), /Resposta de aprovação inválida/);
});
