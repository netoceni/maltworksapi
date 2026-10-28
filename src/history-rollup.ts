/**
 * Maltworks intelligent history — transactional, resumable summaries.
 *
 * The cron runs every five minutes but never aggregates an open UTC bucket.
 * Every batch atomically replaces complete summary buckets and advances
 * a per-resolution watermark. No original telemetry is modified here.
 *
 * Old data is caught up in bounded 12-hour slices. Retention separately
 * verifies that BOTH summary resolutions cover a row before deleting it.
 */
export const HISTORY_FIVE_MINUTES = 300;
export const HISTORY_HOUR = 3600;
export const HISTORY_ROLLUP_MAX_SPAN_SECONDS = 12 * 3600;
export const HISTORY_ROLLUP_LAG_SECONDS = 300;
export type HistoryResolution = 300 | 3600;

export interface HistoryRollupResult {
  resolutionSeconds: HistoryResolution;
  from: number;
  processedUntil: number;
  advanced: boolean;
  summaryRows: number;
}

export function shouldRollupHistory(scheduledTimeMs: number): boolean {
  const date = new Date(scheduledTimeMs);
  return date.getUTCMinutes() % 5 === 0;
}

export function completeHistoryUntil(
  now: number,
  resolutionSeconds: HistoryResolution,
): number {
  // For both 5-min and hourly resolutions, wait one entire resolution
  // before closing a window. This allows in-flight HTTP requests to commit.
  return Math.max(0, Math.floor((Math.floor(now) - resolutionSeconds) /
    resolutionSeconds) * resolutionSeconds);
}

export async function completedHistoryWatermark(db: D1Database): Promise<number | null> {
  const rows = await db.prepare(
    "SELECT MIN(processed_until) AS completedUntil, COUNT(*) AS resolutions " +
    "FROM history_rollup_watermarks WHERE resolution_seconds IN (300, 3600)",
  ).first<{ completedUntil: number | null; resolutions: number }>();
  return rows?.resolutions === 2 && rows.completedUntil !== null ?
    rows.completedUntil : null;
}

const HISTORY_COLUMNS = [
  "device_id", "bucket_start", "samples",
  "refrigerator_count", "refrigerator_sum", "refrigerator_min", "refrigerator_max",
  "thermal_well_count", "thermal_well_sum", "thermal_well_min", "thermal_well_max",
  "setpoint_sum", "setpoint_min", "setpoint_max",
  "cooling_samples", "heating_samples", "alarm_samples", "rssi_sum", "updated_at",
] as const;

function rollupStatement(db: D1Database, resolutionSeconds: HistoryResolution,
  from: number, until: number, now: number): D1PreparedStatement {
  // Table name and resolution are hardcoded from a fixed allowlist.
  const table = resolutionSeconds === HISTORY_FIVE_MINUTES ? "history_5min" : "history_hourly";
  const bucket = `CAST(received_at / ${resolutionSeconds} AS INTEGER) * ${resolutionSeconds}`;
  const selects = [
    "device_id", bucket, "COUNT(*)",
    "COUNT(refrigerator_value)", "COALESCE(SUM(refrigerator_value), 0)",
    "MIN(refrigerator_value)", "MAX(refrigerator_value)",
    "COUNT(thermal_well_value)", "COALESCE(SUM(thermal_well_value), 0)",
    "MIN(thermal_well_value)", "MAX(thermal_well_value)",
    "SUM(setpoint)", "MIN(setpoint)", "MAX(setpoint)",
    "SUM(cooling)", "SUM(heating)", "SUM(alarms_active)", "SUM(rssi)", "?3",
  ];
  const updates = HISTORY_COLUMNS.slice(2).map((column) =>
    `${column} = excluded.${column}`).join(", ");
  return db.prepare(
    `INSERT INTO ${table} (${HISTORY_COLUMNS.join(", ")})
     SELECT ${selects.join(", ")}
       FROM telemetry
      WHERE received_at >= ?1 AND received_at < ?2
      GROUP BY device_id, ${bucket}
     ON CONFLICT(device_id, bucket_start) DO UPDATE SET ${updates}`,
  ).bind(from, until, now);
}

export async function rollupHistoryResolution(
  db: D1Database,
  now: number,
  resolutionSeconds: HistoryResolution,
): Promise<HistoryRollupResult> {
  if (![HISTORY_FIVE_MINUTES, HISTORY_HOUR].includes(resolutionSeconds)) {
    throw new Error("Unsupported history rollup resolution.");
  }
  const maxCompletedUntil = completeHistoryUntil(now, resolutionSeconds);
  const progress = await db.prepare(
    "SELECT processed_until AS processedUntil FROM history_rollup_watermarks " +
    "WHERE resolution_seconds = ?1",
  ).bind(resolutionSeconds).first<{ processedUntil: number }>();
  const minimum = progress ? null : await db.prepare(
    "SELECT MIN(received_at) AS minimum FROM telemetry",
  ).first<{ minimum: number | null }>();
  const from = progress?.processedUntil ??
    (minimum?.minimum === null || minimum?.minimum === undefined ?
      maxCompletedUntil :
      Math.floor(minimum.minimum / resolutionSeconds) * resolutionSeconds);

  const until = Math.min(maxCompletedUntil, from + HISTORY_ROLLUP_MAX_SPAN_SECONDS);
  if (until <= from) {
    return { resolutionSeconds, from, processedUntil: from, advanced: false, summaryRows: 0 };
  }

  // D1 .batch() executes SQL statements transactionally: if the summary
  // insert fails, the watermark never advances. No deletions happen here.
  const results = await db.batch([
    rollupStatement(db, resolutionSeconds, from, until, Math.floor(now)),
    db.prepare(
      `INSERT INTO history_rollup_watermarks
       (resolution_seconds, processed_until, updated_at)
       VALUES (?1, ?2, ?3)
       ON CONFLICT(resolution_seconds) DO UPDATE SET
         processed_until = MAX(history_rollup_watermarks.processed_until,
           excluded.processed_until),
         updated_at = excluded.updated_at`,
    ).bind(resolutionSeconds, until, Math.floor(now)),
  ]);
  return {
    resolutionSeconds,
    from,
    processedUntil: until,
    advanced: true,
    summaryRows: results[0]?.meta.changes ?? 0,
  };
}

export async function runIntelligentHistoryRollup(
  env: Env,
  scheduledTimeMs: number,
): Promise<HistoryRollupResult[]> {
  const now = Math.floor(scheduledTimeMs / 1000);
  const results: HistoryRollupResult[] = [];
  for (const resolution of [HISTORY_FIVE_MINUTES, HISTORY_HOUR] as const) {
    results.push(await rollupHistoryResolution(env.DB, now, resolution));
  }
  console.info("Maltworks history rollup", { results });
  return results;
}
