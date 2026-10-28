import assert from "node:assert/strict";
import test from "node:test";
import {
  LAB_MAX_STAGING_DEVICES, readLabTokens, requireLabEndpoint, runLabStaging,
} from "./maltworks-lab-transport.mjs";
import { labDeviceId } from "./maltworks-lab.mjs";
import { parseLabStageArgs } from "./maltworks-lab-staging.mjs";

const TOKEN = "ab".repeat(32);
const local = "http://127.0.0.1:8787/v1/telemetry";
const remote = "https://api-staging.maltworks.com.br/v1/telemetry";
const tokens = (devices) => readLabTokens(
  JSON.stringify(Object.fromEntries(
    Array.from({ length: devices }, (_, i) => [labDeviceId(i), TOKEN]),
  )),
  devices,
);
const accepted = () => ({ status: 200, json: async () => ({
  ok: true, accepted: true, deviceStatus: "active",
}) });

test("local and explicit staging URLs are accepted, nothing else", () => {
  assert.equal(requireLabEndpoint(local).pathname, "/v1/telemetry");
  assert.equal(requireLabEndpoint(remote).hostname, "api-staging.maltworks.com.br");
  assert.equal(requireLabEndpoint(
    "https://lab-api.staging.maltworks.com.br/v1/telemetry",
  ).hostname, "lab-api.staging.maltworks.com.br");
  for (const bad of [
    "https://api.maltworks.com.br/v1/telemetry",
    "https://app.maltworks.com.br/v1/telemetry",
    "https://admin.maltworks.com.br/v1/telemetry",
    "https://maltworks-api.example.workers.dev/v1/telemetry",
    "https://api-staging.maltworks.com.br.evil.example/v1/telemetry",
    "https://api-staging.maltworks.com.br@api.maltworks.com.br/v1/telemetry",
    "http://api-staging.maltworks.com.br/v1/telemetry",
    "https://api-staging.maltworks.com.br/v1/devices/claim",
    "https://api-staging.maltworks.com.br/v1/telemetry?next=prod",
    "https://api-staging.maltworks.com.br/v1/telemetry#anchor",
    "http://0.0.0.0:8787/v1/telemetry",
    "https://localhost.evil.example/v1/telemetry",
    "ftp://localhost/v1/telemetry",
  ]) {
    assert.throws(() => requireLabEndpoint(bad), undefined, bad);
  }
});

test("credential map rejects invalid, missing and excess devices", () => {
  assert.equal(LAB_MAX_STAGING_DEVICES, 10);
  assert.equal(tokens(2).size, 2);
  assert.throws(() => readLabTokens("{}", 1));
  assert.throws(() => readLabTokens("{bad json", 1));
  assert.throws(() => readLabTokens(JSON.stringify({ [labDeviceId(0)]: "insecure" }), 1));
  assert.throws(() => tokens(11));
});

test("CLI defaults to safe dry-run and blocks invalid ranges", () => {
  assert.equal(parseLabStageArgs([]).send, false);
  assert.equal(parseLabStageArgs(["--send", "--endpoint", remote]).send, true);
  assert.throws(() => parseLabStageArgs(["--send", "--endpoint", "https://api.maltworks.com.br/v1/telemetry"]));
  assert.throws(() => parseLabStageArgs(["--devices", "11"]));
  assert.throws(() => parseLabStageArgs(["--ticks", "121"]));
  assert.throws(() => parseLabStageArgs(["--scenario", "rm-rf"]));
});

test("remote staging cannot start without Access service credentials", async () => {
  let fetchCalls = 0;
  await assert.rejects(
    runLabStaging({ endpoint: remote, tokens: tokens(1), paceMs: 0 }, {
      fetchImpl: () => { fetchCalls++; return accepted(); },
    }),
    /Access service credentials/,
  );
  assert.equal(fetchCalls, 0);
});

test("missing credentials never produce partial writes", async () => {
  let fetchCalls = 0;
  await assert.rejects(
    runLabStaging({ endpoint: local, devices: 2, tokens: tokens(1), paceMs: 0 }, {
      fetchImpl: () => { fetchCalls++; return accepted(); },
    }),
    /Missing or invalid staging token/,
  );
  assert.equal(fetchCalls, 0);
});

test("staging sender uses the real telemetry contract without customer routes", async () => {
  const calls = [];
  const result = await runLabStaging({
    endpoint: remote, tokens: tokens(2), devices: 2, ticks: 3,
    paceMs: 0, startAt: 1_800_000_000, sessionId: 19,
    accessClientId: "test-access-id", accessClientSecret: "test-access-secret",
  }, {
    fetchImpl: async (url, options) => {
      calls.push({ url, options, payload: JSON.parse(options.body) });
      return accepted();
    },
  });
  assert.equal(result.delivered, 6);
  assert.equal(result.omitted, 0);
  assert.equal(result.timingValid, false);
  assert.equal(calls.length, 6);
  const first = calls[0];
  assert.equal(first.url, remote);
  assert.equal(first.options.redirect, "error");
  assert.equal(first.options.method, "POST");
  assert.equal(first.options.headers.Authorization, "Bearer " + TOKEN);
  assert.equal(first.options.headers["CF-Access-Client-Id"], "test-access-id");
  assert.equal(first.options.headers["CF-Access-Client-Secret"], "test-access-secret");
  assert.equal(first.options.headers["X-Maltworks-Device-ID"], first.payload.deviceId);
  assert.equal(first.payload.schemaVersion, 1);
  assert.equal(first.payload.firmware.product, "MaltworksController");
  assert.equal(calls[4].payload.sequence, 3);
  assert.equal(calls[0].payload.bootId, calls[2].payload.bootId);
  assert.equal(calls[0].payload.sentAt + 30, calls[2].payload.sentAt);
});

test("offline test preserves silent periods and 30s pacing", async () => {
  const delays = [];
  const result = await runLabStaging({
    endpoint: local, tokens: tokens(1), ticks: 12, paceMs: 30_000,
    scenario: "offline", startAt: 1_800_000_000, sessionId: 24,
  }, {
    fetchImpl: async () => accepted(),
    sleep: async (ms) => delays.push(ms),
  });
  assert.equal(result.delivered, 6);
  assert.equal(result.omitted, 6);
  assert.equal(result.timingValid, true);
  assert.deepEqual(delays, Array(11).fill(30_000));
});

test("pending device, redirects and rejected requests stop without leaking secrets", async () => {
  const args = { endpoint: local, tokens: tokens(1), paceMs: 0 };
  await assert.rejects(runLabStaging(args, {
    fetchImpl: async () => ({ status: 202, json: async () => ({ deviceStatus: "pending" }) }),
  }), /pending/);
  await assert.rejects(runLabStaging(args, {
    fetchImpl: async () => ({ status: 302, json: async () => ({}) }),
  }), /HTTP 302/);
  await assert.rejects(runLabStaging(args, {
    fetchImpl: async () => { throw new Error("Bearer " + TOKEN + " is secret"); },
  }), (error) => {
    assert.ok(!error.message.includes(TOKEN));
    return /failed or was redirected/.test(error.message);
  });
});
