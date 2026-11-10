#!/usr/bin/env node
/**
 * Maltworks Lab v0: deterministic OFFLINE ESP32 telemetry generator.
 * No fetch, sockets, tokens, Cloudflare binding or production credentials.
 *
 * Examples:
 * node scripts/maltworks-lab.mjs --devices 10 --frames 12 --scenario normal
 * node scripts/maltworks-lab.mjs --devices 2 --frames 12 --scenario alarm
 */
import { pathToFileURL } from "node:url";

// Keep the Node-only CLI separate from the portable telemetry generator.
import { generateLabFrames } from "./maltworks-lab-core.mjs";
export { labDeviceId, makeLabTelemetry, generateLabFrames } from "./maltworks-lab-core.mjs";

function parseArgs(args) {
  const options = { devices: 1, frames: 12, intervalSeconds: 30, scenario: "normal" };
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (!["--devices", "--frames", "--interval", "--scenario"].includes(key)) {
      throw new Error("Unknown option: " + key);
    }
    const value = args[++i];
    if (value === undefined) throw new Error("Missing value for " + key);
    if (key === "--scenario") options.scenario = value;
    else {
      if (!/^[0-9]+$/u.test(value)) throw new Error("Expected positive integer for " + key);
      options[key === "--interval" ? "intervalSeconds" : key.slice(2)] = Number(value);
    }
  }
  return options;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const options = parseArgs(process.argv.slice(2));
    for (const packet of generateLabFrames(options)) process.stdout.write(JSON.stringify(packet) + "\n");
  } catch (error) {
    process.stderr.write("Maltworks Lab: " + error.message + "\n");
    process.exitCode = 1;
  }
}
