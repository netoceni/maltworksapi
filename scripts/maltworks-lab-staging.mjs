#!/usr/bin/env node
/**
 * Developer CLI. No customer interface and no production API routes.
 *
 * Dry run (no network): node scripts/maltworks-lab-staging.mjs
 *
 * Active sending requires ALL of:
 *   --send --endpoint <loopback or approved staging domain>
 *   MALTWORKS_LAB_STAGING_TOKENS_JSON (test-only device IDs/tokens)
 *   CF_ACCESS_CLIENT_ID / CF_ACCESS_CLIENT_SECRET (remote staging only)
 *
 * The staging destination must already have a separate Worker, D1, Durable
 * Object and Cloudflare Access policy. This command does not create them.
 */
import { pathToFileURL } from "node:url";
import { readLabTokens, requireLabEndpoint, runLabStaging } from "./maltworks-lab-transport.mjs";

const SCENARIOS = new Set(["normal", "alarm", "sensor-loss", "reboot", "offline", "command"]);

export function parseLabStageArgs(argv) {
  const result = {
    send: false, endpoint: null, devices: 1, ticks: 12,
    paceMs: 30_000, scenario: "normal",
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--send") {
      if (result.send) throw new Error("Duplicate --send");
      result.send = true;
      continue;
    }
    if (!["--endpoint", "--devices", "--ticks", "--pace-ms", "--scenario"].includes(arg)) {
      throw new Error("Unknown Lab argument: " + arg);
    }
    const val = argv[++i];
    if (val === undefined) throw new Error("Missing value for " + arg);
    if (arg === "--endpoint") result.endpoint = val;
    else if (arg === "--scenario") result.scenario = val;
    else {
      if (!/^(0|[1-9][0-9]*)$/u.test(val)) {
        throw new Error("Expected non-negative integer for " + arg);
      }
      const key = arg === "--pace-ms" ? "paceMs" : arg.slice(2);
      result[key] = Number(val);
    }
  }
  if (!SCENARIOS.has(result.scenario)) throw new Error("Unknown Lab scenario");
  if (!Number.isSafeInteger(result.devices) || result.devices < 1 || result.devices > 10) {
    throw new Error("Free Lab staging supports 1-10 devices");
  }
  if (!Number.isSafeInteger(result.ticks) || result.ticks < 1 || result.ticks > 120) {
    throw new Error("Free Lab staging supports 1-120 ticks");
  }
  if (!Number.isSafeInteger(result.paceMs) || result.paceMs < 0 ||
      result.paceMs > 60_000) {
    throw new Error("Invalid Lab pacing");
  }
  if (result.send) requireLabEndpoint(result.endpoint);
  return result;
}

export async function main(argv = process.argv.slice(2), environment = process.env) {
  const options = parseLabStageArgs(argv);
  if (!options.send) {
    process.stdout.write(
      "Maltworks Lab is INTERNAL/DRY-RUN: zero network traffic. " +
      "Use --send with an isolated local or Cloudflare Access-protected staging endpoint.\n",
    );
    return { dryRun: true };
  }
  const tokens = readLabTokens(environment.MALTWORKS_LAB_STAGING_TOKENS_JSON, options.devices);
  const result = await runLabStaging({
    ...options,
    tokens,
    accessClientId: environment.CF_ACCESS_CLIENT_ID,
    accessClientSecret: environment.CF_ACCESS_CLIENT_SECRET,
  });
  process.stdout.write(JSON.stringify(result) + "\n");
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    // Avoid echoing URLs with secrets, env, headers or response bodies.
    process.stderr.write("Maltworks Lab: " + error.message + "\n");
    process.exitCode = 1;
  });
}
