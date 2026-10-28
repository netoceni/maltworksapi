import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  completedHistoryWatermark, rollupHistoryResolution,
  HISTORY_FIVE_MINUTES, HISTORY_HOUR,
} from "../src/history-rollup";
import { pruneExpiredTelemetry } from "../src/retention";

const now = 1_800_000_000;
const day = 86_400;
const deviceId = "MW-FA0102030405";
const start = Math.floor((now - 8 * day) / 3600) * 3600;
const later = start + day + 30;

async function samplesRemaining(): Promise<number> {
  return (await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM telemetry WHERE device_id = ?1",
  ).bind(deviceId).first<{ count: number }>())?.count ?? 0;
}

describe("Intelligent History — D1 real SQL rollups", () => {
  it("aggregates 5-min and hourly buckets, resumes safely, never deletes uncovered data", async () => {
    await env.DB.prepare(
      `INSERT INTO devices (id, organization_id, name, status,
        firmware_version, first_seen_at, last_seen_at,
        claimed_at, created_at, updated_at)
       VALUES (?1, NULL, 'History fixture', 'pending',
       '5.19.0', ?2, ?2, NULL, ?2, ?2)`,
    ).bind(deviceId, now).run();

    const insert = env.DB.prepare(
      `INSERT INTO telemetry (
         device_id, boot_id, sequence, received_at, sent_at, uptime_seconds,
         refrigerator_connected, refrigerator_value, refrigerator_raw, refrigerator_offset,
         thermal_well_connected, thermal_well_value, thermal_well_raw, thermal_well_offset,
         setpoint, hysteresis, control_state, cooling, heating, compressor_protection_seconds,
         profile_active, profile_paused, profile_name, profile_state, profile_stage,
         profile_stage_count, profile_remaining_seconds, alarms_active,
         alarms_unacknowledged, alarms_count, rssi, firmware_product,
         firmware_version, firmware_phase, payload_json
      ) VALUES (
        ?1, 'A1B2C3D4', ?2, ?3, ?3, 100,
        1, ?4, ?4, 0, 1, ?5, ?5, 0,
        ?6, 0.5, 'STABLE', ?7, 0, 0,
        0, 0, '', 'IDLE', 0, 0, 0, ?8,
        0, ?8, -50, 'MaltworksController', '5.19.0', 'test', '{}'
      )`,
    );
    await env.DB.batch([
      insert.bind(deviceId, 1, start + 30, 18, 19, 18, 0, 0),
      insert.bind(deviceId, 2, start + 90, 22, 21, 18, 1, 1),
      insert.bind(deviceId, 3, start + 150, null, 20, 19, 0, 0),
      insert.bind(deviceId, 4, later, 17, 18, 17, 0, 0),
      insert.bind(deviceId, 5, now - 2 * day, 16, 17, 16, 0, 0),
    ]);
    expect(await samplesRemaining()).toBe(5);
    expect(await completedHistoryWatermark(env.DB)).toBeNull();
    expect((await pruneExpiredTelemetry(env.DB, now, 7, 250)).deletedRows).toBe(0);

    const r5 = await rollupHistoryResolution(env.DB, now, HISTORY_FIVE_MINUTES);
    const rh = await rollupHistoryResolution(env.DB, now, HISTORY_HOUR);
    expect(r5.advanced).toBe(true);
    expect(rh.advanced).toBe(true);
    expect(r5.from).toBe(start);
    expect(rh.from).toBe(start);
    expect(await completedHistoryWatermark(env.DB)).toBe(start + 12 * 3600);

    const bucket = await env.DB.prepare(
      `SELECT samples, refrigerator_count AS refrigeratorCount,
         refrigerator_sum AS refrigeratorSum, refrigerator_min AS refrigeratorMin,
         refrigerator_max AS refrigeratorMax,
         thermal_well_count AS thermalWellCount, thermal_well_sum AS thermalWellSum,
         setpoint_sum AS setpointSum, cooling_samples AS coolingSamples,
         alarm_samples AS alarmSamples
         FROM history_5min WHERE device_id = ?1 AND bucket_start = ?2`,
    ).bind(deviceId, start).first<Record<string, number>>();
    expect(bucket).toMatchObject({
      samples: 3,
      refrigeratorCount: 2, refrigeratorSum: 40,
      refrigeratorMin: 18, refrigeratorMax: 22,
      thermalWellCount: 3, thermalWellSum: 60,
      setpointSum: 55, coolingSamples: 1, alarmSamples: 1,
    });
    const hour = await env.DB.prepare(
      "SELECT samples, refrigerator_sum AS refrigeratorSum FROM history_hourly " +
      "WHERE device_id = ?1 AND bucket_start = ?2",
    ).bind(deviceId, start).first<{ samples: number; refrigeratorSum: number }>();
    expect(hour).toMatchObject({ samples: 3, refrigeratorSum: 40 });

    // First archival slice covers the first old bucket but not the second one.
    expect((await pruneExpiredTelemetry(env.DB, now, 7, 250)).deletedRows).toBe(3);
    expect(await samplesRemaining()).toBe(2);
    const uncovered = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM telemetry WHERE device_id = ?1 AND received_at = ?2",
    ).bind(deviceId, later).first<{ count: number }>();
    expect(uncovered?.count).toBe(1);

    // After resuming, later expired raw data may finally be cleaned.
    for (let iteration = 0; iteration < 3; iteration++) {
      await rollupHistoryResolution(env.DB, now, HISTORY_FIVE_MINUTES);
      await rollupHistoryResolution(env.DB, now, HISTORY_HOUR);
    }
    expect((await pruneExpiredTelemetry(env.DB, now, 7, 250)).deletedRows).toBe(1);
    expect(await samplesRemaining()).toBe(1);
    const archivedLater = await env.DB.prepare(
      "SELECT samples FROM history_5min WHERE device_id = ?1 AND bucket_start = ?2",
    ).bind(deviceId, Math.floor(later / 300) * 300).first<{ samples: number }>();
    expect(archivedLater?.samples).toBe(1);

    // Rebuild one completed range after resetting ONLY test progress.
    // An UPSERT overwrites summary values instead of double-counting them.
    await env.DB.prepare(
      "UPDATE history_rollup_watermarks SET processed_until = ?1 WHERE resolution_seconds = 300",
    ).bind(start).run();
    await rollupHistoryResolution(env.DB, now, HISTORY_FIVE_MINUTES);
    const sameBucket = await env.DB.prepare(
      "SELECT samples, refrigerator_sum AS refrigeratorSum FROM history_5min " +
      "WHERE device_id = ?1 AND bucket_start = ?2",
    ).bind(deviceId, start).first<{ samples: number; refrigeratorSum: number }>();
    // Raw samples already removed; a rebuild should not happen in production.
    // The test confirms that the original summary remains if no raw source exists.
    expect(sameBucket?.samples).toBe(3);
    expect(sameBucket?.refrigeratorSum).toBe(40);
  });
});
