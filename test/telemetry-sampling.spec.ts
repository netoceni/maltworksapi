import { describe, expect, it } from "vitest";
import {
  isStaleTelemetry,
  shouldPersistTelemetry,
  shouldPersistRealtimeFailover,
  TELEMETRY_PERSIST_INTERVAL_SECONDS,
  TELEMETRY_REALTIME_FAILOVER_INTERVAL_SECONDS,
  telemetryPersistenceIntervalSeconds,
  type LastPersistedTelemetry,
} from "../src/telemetry-sampling";
import type { TelemetryPayload } from "../src/types";

const first: TelemetryPayload = {
  schemaVersion: 1,
  deviceId: "MW-ABCDEF123456",
  bootId: "ABCDEF12",
  sequence: 1,
  sentAt: 1_800_000_000,
  uptimeSeconds: 100,
  firmware: { product: "MaltworksController", version: "5.5.2", phase: "pilot" },
  network: { rssi: -55 },
  temperatures: {
    refrigerator: { connected: true, value: 19, raw: 19, offset: 0 },
    thermalWell: { connected: true, value: 18.9, raw: 18.9, offset: 0 },
  },
  control: {
    setpoint: 18, hysteresis: 0.5, state: "STABLE",
    cooling: false, heating: false,
    compressorProtectionSeconds: 0, compressorProtectionDurationSeconds: 60,
  },
  profile: {
    active: false, paused: false, name: "",
    state: "IDLE", stage: 0, stageCount: 0, remainingSeconds: 0,
  },
  alarms: {
    active: false, unacknowledged: false, count: 0, summary: "Nenhum alarme",
    configuration: {
      sensorAlarmEnabled: true, highTemperatureEnabled: true,
      lowTemperatureEnabled: true, responseAlarmEnabled: true,
      highTemperatureLimit: 35, lowTemperatureLimit: -5,
      minimumExpectedChange: 0.5, responseTimeoutSeconds: 5400,
    },
  },
};

function copy(firstSample = first): TelemetryPayload {
  return JSON.parse(JSON.stringify(firstSample)) as TelemetryPayload;
}

function persisted(last = first, time = 1_800_000_000): LastPersistedTelemetry {
  return {
    bootId: last.bootId, sequence: last.sequence,
    stateReceivedAt: time, stateJson: JSON.stringify(last), offlineActive: 0,
  };
}

describe("event-aware D1 sampling", () => {
  it("accepts explicit safe sampling settings and a legacy rollback option", () => {
    expect(telemetryPersistenceIntervalSeconds(undefined)).toBe(60);
    expect(telemetryPersistenceIntervalSeconds("60")).toBe(60);
    expect(telemetryPersistenceIntervalSeconds("30")).toBe(30);
    expect(telemetryPersistenceIntervalSeconds("120")).toBe(120);
    expect(telemetryPersistenceIntervalSeconds("300")).toBe(300);
    expect(telemetryPersistenceIntervalSeconds("0")).toBe(0);
    expect(telemetryPersistenceIntervalSeconds("5")).toBe(60);
    expect(telemetryPersistenceIntervalSeconds("600")).toBe(60);
    expect(telemetryPersistenceIntervalSeconds("invalid")).toBe(60);
  });

  it("writes first packet, periodic sample and reboot, not ordinary 5s packets", () => {
    const current = copy();
    current.sequence = 2;
    current.sentAt += 5;
    current.uptimeSeconds += 5;
    current.temperatures.refrigerator.value = 18.8;
    current.control.compressorProtectionSeconds = 50;
    current.profile.remainingSeconds = 500;
    current.network.rssi = -56;

    expect(shouldPersistTelemetry(current, null, first.sentAt + 5)).toBe(true);
    expect(shouldPersistTelemetry(current, persisted(), first.sentAt + 5)).toBe(false);
    expect(shouldPersistTelemetry(current, persisted(), first.sentAt + 59)).toBe(false);
    expect(shouldPersistTelemetry(current, persisted(), first.sentAt + 60)).toBe(true);
    expect(TELEMETRY_PERSIST_INTERVAL_SECONDS).toBe(60);

    const booted = copy(current);
    booted.bootId = "87654321";
    expect(shouldPersistTelemetry(booted, persisted(), first.sentAt + 5)).toBe(true);
    const repeated = copy(first);
    expect(shouldPersistTelemetry(repeated, persisted(), first.sentAt + 61)).toBe(false);
  });

  it("immediately stores all safety and profile transitions", () => {
    const previous = persisted();
    const changes: Array<(next: TelemetryPayload) => void> = [
      (next) => { next.control.cooling = true; },
      (next) => { next.control.heating = true; },
      (next) => { next.control.state = "COOLING"; },
      (next) => { next.temperatures.refrigerator.connected = false; },
      (next) => { next.temperatures.thermalWell.connected = false; },
      (next) => { next.alarms.active = true; },
      (next) => { next.alarms.unacknowledged = true; },
      (next) => { next.alarms.count = 1; },
      (next) => { next.profile.active = true; },
      (next) => { next.profile.paused = true; },
      (next) => { next.profile.stage = 2; },
      (next) => { next.profile.state = "RUNNING"; },
      (next) => { next.control.setpoint = 15; },
      (next) => { next.control.hysteresis = 0.7; },
      (next) => { next.temperatures.refrigerator.offset = 0.2; },
      (next) => { next.firmware.version = "5.6.0"; },
      (next) => { next.alarms.configuration.highTemperatureLimit = 40; },
      (next) => {
        next.commandResult = {
          id: "cmd_" + "1".repeat(32), status: "applied",
          appliedSetpoint: 18, message: "OK",
        };
      },
    ];
    for (const mutate of changes) {
      const current = copy();
      current.sequence = 2;
      mutate(current);
      expect(shouldPersistTelemetry(current, previous, first.sentAt + 5)).toBe(true);
    }
  });

  it("rejects stale sequences even during offline recovery and ignores an older boot", () => {
    const replay = copy();
    expect(isStaleTelemetry(replay, persisted())).toBe(true);
    expect(shouldPersistTelemetry(
      replay, { ...persisted(), offlineActive: 1 }, first.sentAt + 100,
    )).toBe(false);

    const older = copy();
    older.bootId = "00001111";
    older.sequence = 50;
    older.sentAt = first.sentAt - 5;
    expect(isStaleTelemetry(older, persisted())).toBe(true);
    expect(shouldPersistTelemetry(older, persisted(), first.sentAt + 5)).toBe(false);

    const newBoot = copy();
    newBoot.bootId = "99998888";
    newBoot.sequence = 1;
    newBoot.sentAt = first.sentAt + 5;
    expect(isStaleTelemetry(newBoot, persisted())).toBe(false);
    expect(shouldPersistTelemetry(newBoot, persisted(), first.sentAt + 5)).toBe(true);
  });

  it("does not write on every setpoint step of an active ramp", () => {
    const initial = copy();
    initial.profile.active = true;
    initial.profile.name = "Rampa IPA";
    initial.profile.state = "RUNNING";
    initial.control.setpoint = 18;
    const updated = copy(initial);
    updated.sequence = 2;
    updated.profile.remainingSeconds = 3500;
    updated.control.setpoint = 18.01;
    expect(shouldPersistTelemetry(updated, persisted(initial), first.sentAt + 5)).toBe(false);
    expect(shouldPersistTelemetry(updated, persisted(initial), first.sentAt + 60)).toBe(true);
  });

  it("fails safe to persistence on corrupt/unknown previous payload or recovery", () => {
    const current = copy();
    current.sequence = 2;
    expect(shouldPersistTelemetry(current, { ...persisted(), stateJson: "{" }, first.sentAt + 5)).toBe(true);
    expect(shouldPersistTelemetry(current, { ...persisted(), stateJson: "{}" }, first.sentAt + 5)).toBe(true);
    expect(shouldPersistTelemetry(current, { ...persisted(), offlineActive: 1 }, first.sentAt + 5)).toBe(true);
    expect(shouldPersistTelemetry(current, persisted(), first.sentAt - 1)).toBe(true);
  });

  it("rate-limits D1 failover if the Durable Object becomes unavailable", () => {
    expect(TELEMETRY_REALTIME_FAILOVER_INTERVAL_SECONDS).toBe(30);
    expect(shouldPersistRealtimeFailover(null, first.sentAt)).toBe(true);
    expect(shouldPersistRealtimeFailover(persisted(), first.sentAt + 5)).toBe(false);
    expect(shouldPersistRealtimeFailover(persisted(), first.sentAt + 29)).toBe(false);
    expect(shouldPersistRealtimeFailover(persisted(), first.sentAt + 30)).toBe(true);
    expect(shouldPersistRealtimeFailover(persisted(), first.sentAt - 1)).toBe(true);
  });

  it("persists command acknowledgement resolution once then returns to sampling", () => {
    const acked = copy();
    acked.sequence = 2;
    acked.commandResult = {
      id: "cmd_" + "a".repeat(32), status: "applied",
      appliedSetpoint: 18, message: "Applied",
    };
    expect(shouldPersistTelemetry(acked, persisted(), first.sentAt + 5)).toBe(true);
    const repeated = copy(acked);
    repeated.sequence = 3;
    expect(shouldPersistTelemetry(repeated, persisted(acked, first.sentAt + 5), first.sentAt + 10)).toBe(false);
    const cleared = copy(repeated);
    cleared.sequence = 4;
    delete cleared.commandResult;
    expect(shouldPersistTelemetry(cleared, persisted(acked, first.sentAt + 5), first.sentAt + 15)).toBe(true);
  });
});
