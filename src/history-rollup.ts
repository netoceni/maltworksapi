/**
 * Five-minute history prototype. This module is deliberately NOT wired to the
 * production scheduler until backfill, quota, and safe-pruning tests pass.
 * Never infer missing periods as zero temperatures.
 */
export const HISTORY_BUCKET_SECONDS = 300;
export const HISTORY_SETTLE_SECONDS = 120;
export const HISTORY_MAX_BUCKETS_PER_RUN = 12;

export interface HistoryRollupStats {
  scanned: number;
  written: number;
  nextBucketStart: number | null;
}

/**
 * Advance a single device through complete five-minute UTC buckets.
 * A cursor advances across empty buckets too, but only after a successful
 * transactional D1 batch. Re-running a bucket is harmless (UPSERT).
 */
export async function aggregateDeviceHistory(
  db: D1Database,
  deviceId: string,
  nowSeconds: number,
  maxBuckets = HISTORY_MAX_BUCKETS_PER_RUN,
): Promise<HistoryRollupStats> {
  if (!Number.isInteger(maxBuckets) || maxBuckets < 1 || maxBuckets > 100) {
    throw new Error("Invalid history batch size.");
  }
  const safeUpper = Math.floor((nowSeconds - HISTORY_SETTLE_SECONDS) / HISTORY_BUCKET_SECONDS) *
    HISTORY_BUCKET_SECONDS;
  const cursor = await db.prepare(
    "SELECT next_bucket_start AS nextBucketStart FROM telemetry_rollup_cursors WHERE device_id = ?1",
  ).bind(deviceId).first<{ nextBucketStart: number }>();
  const earliest = await db.prepare(
    "SELECT MIN(received_at) AS oldest FROM telemetry WHERE device_id = ?1",
  ).bind(deviceId).first<{ oldest: number | null }>();
  if (earliest?.oldest === null || earliest?.oldest === undefined) {
    return { scanned: 0, written: 0, nextBucketStart: cursor?.nextBucketStart ?? null };
  }
  const earliestBucket = Math.floor(earliest.oldest / HISTORY_BUCKET_SECONDS) * HISTORY_BUCKET_SECONDS;
  const start = cursor ? Math.max(cursor.nextBucketStart, earliestBucket) : earliestBucket;
  if (start >= safeUpper) {
    return { scanned: 0, written: 0, nextBucketStart: cursor?.nextBucketStart ?? start };
  }
  const stop = Math.min(safeUpper, start + maxBuckets * HISTORY_BUCKET_SECONDS);
  const now = Math.floor(nowSeconds);

  const rows = await db.prepare(
    `SELECT CAST(received_at / ?2 AS INTEGER) * ?2 AS bucketStart,
            MIN(received_at) AS firstReceivedAt,
            MAX(received_at) AS lastReceivedAt,
            COUNT(*) AS sampleCount,
            COUNT(refrigerator_value) AS refrigeratorCount,
            AVG(refrigerator_value) AS refrigeratorAvg,
            MIN(refrigerator_value) AS refrigeratorMin,
            MAX(refrigerator_value) AS refrigeratorMax,
            COUNT(thermal_well_value) AS thermalWellCount,
            AVG(thermal_well_value) AS thermalWellAvg,
            MIN(thermal_well_value) AS thermalWellMin,
            MAX(thermal_well_value) AS thermalWellMax,
            AVG(setpoint) AS setpointAvg,
            MIN(setpoint) AS setpointMin,
            MAX(setpoint) AS setpointMax,
            SUM(cooling) AS coolingSamples,
            SUM(heating) AS heatingSamples,
            SUM(alarms_active) AS alarmSamples
       FROM telemetry
      WHERE device_id = ?1 AND received_at >= ?3 AND received_at < ?4
      GROUP BY CAST(received_at / ?2 AS INTEGER)
      ORDER BY bucketStart ASC`,
  ).bind(deviceId, HISTORY_BUCKET_SECONDS, start, stop).all<{
    bucketStart: number;
    firstReceivedAt: number; lastReceivedAt: number; sampleCount: number;
    refrigeratorCount: number; refrigeratorAvg: number | null;
    refrigeratorMin: number | null; refrigeratorMax: number | null;
    thermalWellCount: number; thermalWellAvg: number | null;
    thermalWellMin: number | null; thermalWellMax: number | null;
    setpointAvg: number; setpointMin: number; setpointMax: number;
    coolingSamples: number; heatingSamples: number; alarmSamples: number;
  }>();
  const writes = rows.results.map((row) => db.prepare(
    `INSERT INTO telemetry_5m (
       device_id, bucket_start, first_received_at, last_received_at, sample_count,
       refrigerator_count, refrigerator_avg, refrigerator_min, refrigerator_max,
       thermal_well_count, thermal_well_avg, thermal_well_min, thermal_well_max,
       setpoint_avg, setpoint_min, setpoint_max, cooling_samples, heating_samples,
       alarm_samples, updated_at
     ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20)
     ON CONFLICT(device_id, bucket_start) DO UPDATE SET
       first_received_at=excluded.first_received_at, last_received_at=excluded.last_received_at,
       sample_count=excluded.sample_count, refrigerator_count=excluded.refrigerator_count,
       refrigerator_avg=excluded.refrigerator_avg,
       refrigerator_min=excluded.refrigerator_min, refrigerator_max=excluded.refrigerator_max,
       thermal_well_count=excluded.thermal_well_count, thermal_well_avg=excluded.thermal_well_avg,
       thermal_well_min=excluded.thermal_well_min, thermal_well_max=excluded.thermal_well_max,
       setpoint_avg=excluded.setpoint_avg, setpoint_min=excluded.setpoint_min,
       setpoint_max=excluded.setpoint_max, cooling_samples=excluded.cooling_samples,
       heating_samples=excluded.heating_samples, alarm_samples=excluded.alarm_samples,
       updated_at=excluded.updated_at`,
  ).bind(
    deviceId, row.bucketStart, row.firstReceivedAt, row.lastReceivedAt, row.sampleCount,
    row.refrigeratorCount, row.refrigeratorAvg, row.refrigeratorMin, row.refrigeratorMax,
    row.thermalWellCount, row.thermalWellAvg, row.thermalWellMin, row.thermalWellMax,
    row.setpointAvg, row.setpointMin, row.setpointMax, row.coolingSamples,
    row.heatingSamples, row.alarmSamples, now,
  ));
  writes.push(db.prepare(
    `INSERT INTO telemetry_rollup_cursors(device_id, next_bucket_start, updated_at)
     VALUES (?1, ?2, ?3)
     ON CONFLICT(device_id) DO UPDATE SET
       next_bucket_start = MAX(next_bucket_start, excluded.next_bucket_start),
       updated_at = excluded.updated_at`,
  ).bind(deviceId, stop, now));
  await db.batch(writes);
  return { scanned: (stop - start) / HISTORY_BUCKET_SECONDS, written: rows.results.length, nextBucketStart: stop };
}

/** The cursor may be examined by safe retention; it is NOT proof by itself
 * that historical data was preserved if legacy retention ran earlier. */
export async function historyCoverageCursor(db: D1Database, deviceId: string): Promise<number | null> {
  const row = await db.prepare(
    "SELECT next_bucket_start AS nextBucketStart FROM telemetry_rollup_cursors WHERE device_id = ?1",
  ).bind(deviceId).first<{ nextBucketStart: number }>();
  return row?.nextBucketStart ?? null;
}
