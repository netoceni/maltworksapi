import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { aggregateDeviceHistory, historyCoverageCursor } from "../src/history-rollup";

const deviceId = "MW-123456ABCDEF";
const base = 1_800_000_000; // divisible by 300

describe("5-minute historical rollups on isolated D1", () => {
  it("keeps min/max/avg, missing sensors, alarms, idempotency and checkpoint", async () => {
    await env.DB.prepare(
      `INSERT INTO devices
       (id, organization_id, name, status, firmware_version, first_seen_at, last_seen_at, created_at, updated_at)
       VALUES (?1,NULL,'History Test','pending','5.19.0',?2,?2,?2,?2)`,
    ).bind(deviceId, base).run();

    const insert = env.DB.prepare(
      `INSERT INTO telemetry (
       device_id,boot_id,sequence,received_at,sent_at,uptime_seconds,
       refrigerator_connected,refrigerator_value,refrigerator_offset,
       thermal_well_connected,thermal_well_value,thermal_well_offset,
       setpoint,hysteresis,control_state,cooling,heating,compressor_protection_seconds,
       profile_active,profile_paused,profile_name,profile_state,profile_stage,
       profile_stage_count,profile_remaining_seconds,
       alarms_active,alarms_unacknowledged,alarms_count,rssi,
       firmware_product,firmware_version,firmware_phase,payload_json
      ) VALUES (
       ?1,'ABCDEF12',?2,?3,?3,?2,?4,?5,0,
       ?6,?7,0,18,0.5,'STABLE',?8,0,0,
       0,0,'','IDLE',0,0,0,
       ?9,?9,?9,-50,'MaltworksController','5.19.0','test','{}'
      )`,
    );
    await env.DB.batch([
      insert.bind(deviceId, 1, base + 10, 1, 18, 1, 19, 0, 0),
      insert.bind(deviceId, 2, base + 20, 1, 20, 0, null, 1, 1),
      insert.bind(deviceId, 3, base + 305, 0, null, 1, 18, 0, 0),
    ]);
    const countBefore = await env.DB.prepare(
      "SELECT COUNT(*) AS total FROM telemetry WHERE device_id = ?1",
    ).bind(deviceId).first<{ total: number }>();
    expect(countBefore?.total).toBe(3);

    const run = await aggregateDeviceHistory(env.DB, deviceId, base + 900, 4);
    expect(run.scanned).toBe(2);
    expect(run.written).toBe(2);
    expect(await historyCoverageCursor(env.DB, deviceId)).toBe(base + 600);

    const result = await env.DB.prepare(
      "SELECT * FROM telemetry_5m WHERE device_id = ?1 ORDER BY bucket_start",
    ).bind(deviceId).all<Record<string, number | null>>();
    expect(result.results).toHaveLength(2);
    expect(result.results[0]).toMatchObject({
      sample_count: 2, refrigerator_count: 2, refrigerator_avg: 19,
      refrigerator_min: 18, refrigerator_max: 20,
      thermal_well_count: 1, thermal_well_avg: 19,
      cooling_samples: 1, alarm_samples: 1,
    });
    expect(result.results[1]).toMatchObject({
      sample_count: 1, refrigerator_count: 0, refrigerator_avg: null,
      thermal_well_count: 1, thermal_well_avg: 18,
    });

    // Safe to call repeatedly, no double counting or duplicate buckets.
    const again = await aggregateDeviceHistory(env.DB, deviceId, base + 900, 4);
    expect(again.written).toBe(0);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM telemetry_5m")
      .first<{ n: number }>())?.n).toBe(2);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM telemetry")
      .first<{ n: number }>())?.n).toBe(3);
  });

  it("does not aggregate the open or settling bucket", async () => {
    const current = await aggregateDeviceHistory(env.DB, deviceId, base + 380);
    expect(current.written).toBe(0);
    expect(current.nextBucketStart).toBeGreaterThanOrEqual(base + 600);
  });
});
