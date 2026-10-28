import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  expireIntelligentHistory, HISTORY_5MIN_PRUNE_BATCH,
  HISTORY_HOURLY_PRUNE_BATCH,
} from "../src/history-retention";

const now = 1_800_000_000;
const day = 86_400;
const five = 300;
const hour = 3600;
const id = "MW-C0FFEE00A001";
const align = (time: number, step: number) => Math.floor(time / step) * step;

async function count(table: "history_5min" | "history_hourly"): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS total FROM ${table} WHERE device_id = ?1`,
  ).bind(id).first<{ total: number }>();
  return row?.total ?? 0;
}

const insertSql = (table: "history_5min" | "history_hourly") => `
  INSERT INTO ${table} (
    device_id, bucket_start, samples,
    refrigerator_count, refrigerator_sum, refrigerator_min, refrigerator_max,
    thermal_well_count, thermal_well_sum, thermal_well_min, thermal_well_max,
    setpoint_sum, setpoint_min, setpoint_max,
    cooling_samples, heating_samples, alarm_samples, rssi_sum, updated_at
  ) VALUES (
    ?1, ?2, 1,
    1, 18, 18, 18,
    1, 18, 18, 18,
    18, 18, 18,
    0, 0, 0, -50, ?3
  )`;

async function insert(table: "history_5min" | "history_hourly", bucket: number): Promise<void> {
  await env.DB.prepare(insertSql(table)).bind(id, bucket, now).run();
}

async function hasRow(table: "history_5min" | "history_hourly", bucket: number): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT 1 AS found FROM ${table} WHERE device_id = ?1 AND bucket_start = ?2`,
  ).bind(id, bucket).first();
  return Boolean(row);
}

describe("History expiration safety (real isolated D1)", () => {
  it("never removes data before confirmation, respects boundaries and handles backlog", async () => {
    await env.DB.prepare(
      `INSERT INTO devices (
        id, organization_id, name, status, firmware_version,
        first_seen_at, last_seen_at, claimed_at, created_at, updated_at
      ) VALUES (?1, NULL, 'History expiry test', 'pending',
        '5.19.0', ?2, ?2, NULL, ?2, ?2)`,
    ).bind(id, now).run();

    const oldFive = align(now - 95 * day, five);
    const fiveBoundary = align(now - 90 * day, five);
    const olderFive = align(now - 370 * day, five);
    const recentFive = align(now - day, five);
    const oldHour = align(now - 370 * day, hour);
    const hourBoundary = align(now - 365 * day, hour);
    await insert("history_5min", oldFive);
    await insert("history_5min", olderFive);
    await insert("history_5min", fiveBoundary);
    await insert("history_5min", recentFive);
    await insert("history_hourly", oldHour);
    await insert("history_hourly", hourBoundary);
    expect(await count("history_5min")).toBe(4);
    expect(await count("history_hourly")).toBe(2);

    // The bounded expiry must use the covering bucket index, not a full
    // table scan or an extra temporary sort across millions of points.
    for (const table of ["history_5min", "history_hourly"] as const) {
      const plan = await env.DB.prepare(
        `EXPLAIN QUERY PLAN SELECT rowid FROM ${table}
          WHERE bucket_start < ?1 ORDER BY bucket_start ASC LIMIT ?2`,
      ).bind(now, 250).all<{ detail: string }>();
      expect(plan.results.some((row) =>
        row.detail.includes(`idx_${table}_bucket`))).toBe(true);
      expect(plan.results.some((row) =>
        row.detail.includes("TEMP B-TREE"))).toBe(false);
    }

    // Before the hourly archive confirms coverage: no derived data is lost.
    const paused = await expireIntelligentHistory(env.DB, now);
    expect(paused).toMatchObject({
      paused: true, fiveMinuteDeleted: 0, hourlyDeleted: 0,
    });
    expect(await count("history_5min")).toBe(4);

    // Checkpoint reaches olderFive only: no five-minute bucket at or after
    // the watermark may be deleted, even if it is older than 90 days.
    await env.DB.prepare(
      "INSERT INTO history_rollup_watermarks " +
      "(resolution_seconds, processed_until, updated_at) VALUES (3600, ?1, ?2)",
    ).bind(align(oldFive, hour), now).run();
    const partial = await expireIntelligentHistory(env.DB, now);
    expect(partial.paused).toBe(false);
    expect(partial.fiveMinuteDeleted).toBe(1);
    expect(await hasRow("history_5min", oldFive)).toBe(true);
    expect(await hasRow("history_5min", olderFive)).toBe(false);

    // Once hourly archive covers the interval, 95-day-old fine points
    // become eligible. Boundary 90d and 365d buckets stay intact.
    await env.DB.prepare(
      "UPDATE history_rollup_watermarks SET processed_until = ?1 WHERE resolution_seconds = 3600",
    ).bind(now).run();
    const finished = await expireIntelligentHistory(env.DB, now);
    expect(finished.fiveMinuteDeleted).toBe(1);
    expect(await hasRow("history_5min", oldFive)).toBe(false);
    expect(await hasRow("history_5min", fiveBoundary)).toBe(true);
    expect(await hasRow("history_5min", recentFive)).toBe(true);
    expect(await hasRow("history_hourly", oldHour)).toBe(false);
    expect(await hasRow("history_hourly", hourBoundary)).toBe(true);
    expect(await count("history_5min")).toBe(2);

    // 260 expired fine rows exceed a single safe 250-row batch.
    // The hourly backup covering the remaining fine rows must survive.
    const veryOld = align(now - 410 * day, hour);
    const fineInsert = env.DB.prepare(insertSql("history_5min"));
    for (let offset = 0; offset < 260; offset += 50) {
      const rows = Array.from(
        { length: Math.min(50, 260 - offset) },
        (_, index) => fineInsert.bind(id, veryOld + (offset + index) * five, now),
      );
      await env.DB.batch(rows);
    }
    const hourlyInsert = env.DB.prepare(insertSql("history_hourly"));
    await env.DB.batch(Array.from({ length: 22 }, (_, index) =>
      hourlyInsert.bind(id, veryOld + index * hour, now)));
    expect(await count("history_5min")).toBe(262);

    const first = await expireIntelligentHistory(env.DB, now);
    expect(first.fiveMinuteDeleted).toBe(HISTORY_5MIN_PRUNE_BATCH);
    expect(first.hourlyDeleted).toBeLessThanOrEqual(HISTORY_HOURLY_PRUNE_BATCH);
    expect(await count("history_5min")).toBe(12);
    const earliest = await env.DB.prepare(
      "SELECT MIN(bucket_start) AS minimum FROM history_5min WHERE device_id = ?1",
    ).bind(id).first<{ minimum: number | null }>();
    expect(earliest?.minimum).not.toBeNull();
    const containingHour = align(earliest!.minimum!, hour);
    expect(await hasRow("history_hourly", containingHour)).toBe(true);

    const second = await expireIntelligentHistory(env.DB, now);
    expect(second.fiveMinuteDeleted).toBe(10);
    expect(await count("history_5min")).toBe(2);
    expect(await hasRow("history_hourly", containingHour)).toBe(false);

    // Only archive tables changed; the device/other application data remain.
    expect(await env.DB.prepare(
      "SELECT 1 FROM devices WHERE id = ?1",
    ).bind(id).first()).not.toBeNull();
  });
});
