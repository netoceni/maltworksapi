import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { pruneExpiredTelemetry, shouldPruneTelemetry, telemetryRetentionDays } from "../src/retention";

describe("raw telemetry retention", () => {
  it("validates retention configuration and cron cadence", () => {
    expect(telemetryRetentionDays(undefined)).toBe(7);
    expect(telemetryRetentionDays("30")).toBe(30);
    expect(telemetryRetentionDays("0")).toBe(0);
    expect(() => telemetryRetentionDays("-1")).toThrow();
    expect(() => telemetryRetentionDays("7.5")).toThrow();
    expect(shouldPruneTelemetry(Date.UTC(2026, 9, 27, 10, 20))).toBe(true);
    expect(shouldPruneTelemetry(Date.UTC(2026, 9, 27, 10, 21))).toBe(false);
  });

  it("deletes only old telemetry in bounded batches", async () => {
    const now = 1_800_000_000;
    const old = now - 9 * 86_400;
    const recent = now - 1 * 86_400;
    await env.DB.prepare("PRAGMA foreign_keys = OFF").run();
    try {
      const insert = env.DB.prepare(
        `INSERT INTO telemetry (
          device_id,boot_id,sequence,received_at,sent_at,uptime_seconds,
          refrigerator_connected,refrigerator_offset,thermal_well_connected,thermal_well_offset,
          setpoint,hysteresis,control_state,cooling,heating,compressor_protection_seconds,
          profile_active,profile_paused,profile_name,profile_state,profile_stage,profile_stage_count,
          profile_remaining_seconds,alarms_active,alarms_unacknowledged,alarms_count,rssi,
          firmware_product,firmware_version,firmware_phase,payload_json
        ) VALUES (
          'MW-A1B2C3D4E5F6','ABCDEF12',?1,?2,?2,0,
          1,0,1,0,18,0.5,'ESTAVEL',0,0,0,
          0,0,'','INATIVO',0,0,0,0,0,0,-60,
          'MaltworksController','5.5.2','test','{}'
        )`,
      );
      await insert.bind(800001, old).run();
      await insert.bind(800002, old + 1).run();
      await insert.bind(800003, recent).run();
      expect(await pruneExpiredTelemetry(env.DB, now, 7, 1)).toBe(1);
      expect(await pruneExpiredTelemetry(env.DB, now, 7, 1)).toBe(1);
      expect(await pruneExpiredTelemetry(env.DB, now, 7, 1)).toBe(0);
      const rows = await env.DB.prepare(
        "SELECT sequence FROM telemetry WHERE sequence BETWEEN 800001 AND 800003 ORDER BY sequence"
      ).all<{sequence: number}>();
      expect(rows.results.map(x => x.sequence)).toEqual([800003]);
      expect(await pruneExpiredTelemetry(env.DB, now, 0)).toBe(0);
    } finally {
      await env.DB.prepare("DELETE FROM telemetry WHERE sequence BETWEEN 800001 AND 800003").run();
      await env.DB.prepare("PRAGMA foreign_keys = ON").run();
    }
  });
});
