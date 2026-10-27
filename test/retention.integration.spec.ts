import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { pruneExpiredTelemetry } from "../src/retention";

const now = 1_800_000_000;
const day = 86_400;
const deviceId = "MW-A1B2C3D4E5F7";

describe("D1 telemetry retention (real SQL)", () => {
  it("uses the expiry index, deletes only old rows and preserves the latest state", async () => {
    await env.DB.prepare(
      `INSERT INTO devices
         (id, organization_id, name, status, firmware_version, first_seen_at,
          last_seen_at, claimed_at, created_at, updated_at)
       VALUES (?1, NULL, 'Retention test', 'pending', '5.18.0',
               ?2, ?2, NULL, ?2, ?2)`,
    ).bind(deviceId, now).run();

    await env.DB.prepare(
      `INSERT INTO device_latest_state
         (device_id, received_at, sent_at, boot_id, sequence,
          refrigerator_value, thermal_well_value, setpoint,
          control_state, cooling, heating, alarms_active,
          rssi, firmware_version, state_json)
       VALUES (?1, ?2, ?2, 'ABCDEF12', 4, 18, 18, 18,
               'STABLE', 0, 0, 0, -50, '5.18.0', '{}')`,
    ).bind(deviceId, now).run();

    const insert = env.DB.prepare(
      `INSERT INTO telemetry (
         device_id, boot_id, sequence, received_at, sent_at, uptime_seconds,
         refrigerator_connected, refrigerator_offset,
         thermal_well_connected, thermal_well_offset,
         setpoint, hysteresis, control_state, cooling, heating, compressor_protection_seconds,
         profile_active, profile_paused, profile_name, profile_state, profile_stage,
         profile_stage_count, profile_remaining_seconds,
         alarms_active, alarms_unacknowledged, alarms_count,
         rssi, firmware_product, firmware_version, firmware_phase, payload_json
       ) VALUES (
         ?1, 'ABCDEF12', ?2, ?3, ?3, 100,
         1, 0, 1, 0,
         18, 0.5, 'STABLE', 0, 0, 0,
         0, 0, '', 'IDLE', 0,
         0, 0,
         0, 0, 0,
         -50, 'MaltworksController', '5.18.0', 'test', '{}'
       )`,
    );

    await env.DB.batch([
      insert.bind(deviceId, 1, now - 8 * day),
      insert.bind(deviceId, 2, now - 7 * day - 1),
      insert.bind(deviceId, 3, now - 7 * day), // Exactly at the boundary: preserve
      insert.bind(deviceId, 4, now - 2 * day),
    ]);

    const plan = await env.DB.prepare(
      `EXPLAIN QUERY PLAN SELECT id FROM telemetry
        WHERE received_at < ?1 ORDER BY received_at ASC, id ASC LIMIT ?2`,
    ).bind(now - 7 * day, 250).all<{ detail: string }>();
    expect(plan.results.some((row) => row.detail.includes("idx_telemetry_received_at_id"))).toBe(true);

    const first = await pruneExpiredTelemetry(env.DB, now, 7, 1);
    expect(first.deletedRows).toBe(1);

    const second = await pruneExpiredTelemetry(env.DB, now, 7, 250);
    expect(second.deletedRows).toBe(1);

    const remaining = await env.DB.prepare(
      "SELECT sequence FROM telemetry WHERE device_id = ?1 ORDER BY sequence",
    ).bind(deviceId).all<{ sequence: number }>();
    expect(remaining.results.map((row) => row.sequence)).toEqual([3, 4]);

    const current = await env.DB.prepare(
      "SELECT sequence FROM device_latest_state WHERE device_id = ?1",
    ).bind(deviceId).first<{ sequence: number }>();
    expect(current?.sequence).toBe(4);
  });
});
