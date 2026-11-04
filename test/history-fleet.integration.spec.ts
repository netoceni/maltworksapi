import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  rollupHistoryResolution,
  HISTORY_FIVE_MINUTES, HISTORY_HOUR,
} from "../src/history-rollup";

const count = 25;
const hour = 3600;
const now = Math.floor(Date.now() / (hour * 1000)) * hour;
const start = now - 2 * hour;
const deviceId = (index: number): string =>
  "MW-" + (0xC00000000000 + index).toString(16).toUpperCase().padStart(12, "0");

describe("Intelligent history multi-controller D1 integration", () => {
  it("keeps 25 independently aggregated device series, using indexed queries", async () => {
    const devices = Array.from({ length: count }, (_, index) =>
      env.DB.prepare(
        `INSERT INTO devices
           (id, organization_id, name, status, firmware_version,
            first_seen_at, last_seen_at, claimed_at, created_at, updated_at)
         VALUES (?1, NULL, 'Simulated controller', 'pending',
           '5.19.0', ?2, ?2, NULL, ?2, ?2)`,
      ).bind(deviceId(index), now));
    for (let offset = 0; offset < devices.length; offset += 20) {
      await env.DB.batch(devices.slice(offset, offset + 20));
    }

    // 25 devices x 12 persisted minutes = 300 representative real-SQL rows.
    // High-frequency HTTP packets are modeled separately in the performance
    // simulator, never sent from this test.
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
        ?1, 'AA000011', ?2, ?3, ?3, 100,
        1, ?4, ?4, 0, 1, ?5, ?5, 0,
        18, 0.5, 'STABLE', 0, 0, 0,
        0, 0, '', 'IDLE', 0, 0, 0, 0,
        0, 0, -51, 'MaltworksController', '5.19.0', 'test', '{}'
      )`,
    );
    const rows = [];
    for (let index = 0; index < count; index++) {
      for (let minute = 0; minute < 12; minute++) {
        const at = start + minute * 60 + 1;
        const temp = 17 + index * 0.1;
        rows.push(insert.bind(deviceId(index), minute + 1, at, temp, temp - 0.1));
      }
    }
    for (let index = 0; index < rows.length; index += 50) {
      await env.DB.batch(rows.slice(index, index + 50));
    }

    const beginning = performance.now();
    const fine = await rollupHistoryResolution(env.DB, now, HISTORY_FIVE_MINUTES);
    const hourly = await rollupHistoryResolution(env.DB, now, HISTORY_HOUR);
    const elapsedMs = performance.now() - beginning;
    expect(fine.advanced).toBe(true);
    expect(hourly.advanced).toBe(true);

    const results = await env.DB.prepare(
      "SELECT device_id AS deviceId, SUM(samples) AS samples, COUNT(*) AS buckets " +
      "FROM history_5min GROUP BY device_id ORDER BY device_id",
    ).all<{ deviceId: string; samples: number; buckets: number }>();
    expect(results.results).toHaveLength(count);
    for (let index = 0; index < count; index++) {
      expect(results.results[index]).toMatchObject({
        deviceId: deviceId(index), samples: 12, buckets: 3,
      });
    }
    const hourlyCount = await env.DB.prepare(
      "SELECT COUNT(*) AS records, SUM(samples) AS samples FROM history_hourly",
    ).first<{ records: number; samples: number }>();
    expect(hourlyCount).toMatchObject({ records: count, samples: count * 12 });

    // A historical query for one organization/device should use PK lookup,
    // not scan every customer's buckets.
    const plan = await env.DB.prepare(
      "EXPLAIN QUERY PLAN SELECT bucket_start, samples " +
      "FROM history_5min WHERE device_id = ?1 AND bucket_start >= ?2 " +
      "ORDER BY bucket_start DESC LIMIT 720",
    ).bind(deviceId(0), start).all<{ detail: string }>();
    expect(plan.results.some((row) => row.detail.includes(
      "sqlite_autoindex_history_5min_1",
    ))).toBe(true);

    console.info("History multi-controller isolated D1", {
      devices: count, rawRows: rows.length,
      fiveMinuteRows: fine.summaryRows, hourlyRows: hourly.summaryRows,
      elapsedMs: Math.round(elapsedMs * 10) / 10,
      rowsRead: results.meta.rows_read ?? null,
    });
  });
});
