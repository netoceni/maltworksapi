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

const scenarios = new Set(["normal", "alarm", "sensor-loss", "reboot", "offline", "command"]);

export function labDeviceId(index) {
  if (!Number.isInteger(index) || index < 0 || index >= 300) throw new Error("Invalid device index");
  return "MW-" + (0xC00000000000 + index).toString(16).toUpperCase().padStart(12, "0");
}

function labBootId(index, rebooted) {
  return (0xA0000000 + index + (rebooted ? 0x10000 : 0))
    .toString(16).toUpperCase().padStart(8, "0");
}

export function makeLabTelemetry(index, tick, {
  scenario = "normal", intervalSeconds = 30, startAt = 1_800_000_000,
} = {}) {
  if (!scenarios.has(scenario)) throw new Error("Unknown simulation scenario");
  if (!Number.isInteger(tick) || tick < 0) throw new Error("Invalid tick");
  if (intervalSeconds < 1 || intervalSeconds > 3600) throw new Error("Invalid interval");
  // An offline frame is omitted, not transmitted with a false disconnected flag.
  if (scenario === "offline" && index === 0 && tick >= 4 && tick <= 9) return null;

  const rebooted = scenario === "reboot" && tick >= 6;
  const sequence = rebooted ? tick - 5 : tick + 1;
  const uptimeSeconds = (rebooted ? tick - 6 : tick) * intervalSeconds + 30;
  const alarm = scenario === "alarm" && tick >= 4 && tick < 8;
  const disconnected = scenario === "sensor-loss" && tick >= 4 && tick < 8;
  const temperature = Number(Math.max(18, 21 - tick * 0.2).toFixed(2));
  const cooling = temperature > 18.5;
  const heating = temperature < 17.5;
  const result = {
    schemaVersion: 1,
    deviceId: labDeviceId(index),
    bootId: labBootId(index, rebooted),
    sequence,
    sentAt: startAt + tick * intervalSeconds,
    uptimeSeconds,
    firmware: { product: "MaltworksController", version: "5.5.2", phase: "lab" },
    network: { rssi: -55 - index % 10 },
    temperatures: {
      refrigerator: {
        connected: !disconnected,
        value: disconnected ? null : temperature,
        raw: disconnected ? null : temperature,
        offset: 0,
      },
      thermalWell: {
        connected: true,
        value: Number((temperature - 0.12).toFixed(2)),
        raw: Number((temperature - 0.12).toFixed(2)),
        offset: 0,
      },
    },
    control: {
      setpoint: 18,
      hysteresis: 0.5,
      state: cooling ? "COOLING" : heating ? "HEATING" : "STABLE",
      cooling, heating,
      compressorProtectionSeconds: 0,
      compressorProtectionDurationSeconds: 180,
    },
    profile: {
      active: false, paused: false, name: "",
      state: "IDLE", stage: 0, stageCount: 0, remainingSeconds: 0,
    },
    alarms: {
      active: alarm, unacknowledged: alarm, count: alarm ? 1 : 0,
      summary: alarm ? "Temperatura simulada acima do limite" : "Nenhum alarme",
      configuration: {
        sensorAlarmEnabled: true, highTemperatureEnabled: true,
        lowTemperatureEnabled: true, responseAlarmEnabled: true,
        highTemperatureLimit: 35, lowTemperatureLimit: -5,
        minimumExpectedChange: 0.5, responseTimeoutSeconds: 5400,
      },
    },
  };
  if (scenario === "command" && tick === 6) {
    result.commandResult = {
      id: "cmd_" + (index + 1).toString(16).padStart(32, "0"),
      status: "applied", appliedSetpoint: 18, message: "Simulated ACK",
    };
  }
  return result;
}

export function* generateLabFrames({
  devices = 1, frames = 12, intervalSeconds = 30, scenario = "normal",
} = {}) {
  if (!Number.isInteger(devices) || devices < 1 || devices > 25) {
    throw new Error("Lab pilot supports 1 to 25 devices");
  }
  if (!Number.isInteger(frames) || frames < 1 || frames > 1000) {
    throw new Error("Lab pilot supports 1 to 1000 ticks");
  }
  for (let tick = 0; tick < frames; tick++) {
    for (let index = 0; index < devices; index++) {
      const packet = makeLabTelemetry(index, tick, { scenario, intervalSeconds });
      if (packet !== null) yield packet;
    }
  }
}

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
