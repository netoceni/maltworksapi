import { HISTORY_FIVE_MINUTES, HISTORY_HOUR } from "./history-rollup";

/**
 * Bounded expiry of *derived* data. The source telemetry is handled separately.
 *
 * 5-minute buckets can be removed only after the hourly rollup watermark
 * confirms complete coverage. Hourly buckets are removed only once their
 * configured long-term lifetime has elapsed. Both scans use the bucket index.
 *
 * Default windows: 90d at 5min, 365d at 1h.
 * Values of 0 disable expiry; positive values have deliberately high minimums
 * to avoid accidentally discarding history through misconfiguration.
 */
export const HISTORY_5MIN_RETENTION_DAYS = 90;
export const HISTORY_HOURLY_RETENTION_DAYS = 365;
export const HISTORY_5MIN_PRUNE_BATCH = 250;
export const HISTORY_HOURLY_PRUNE_BATCH = 100;
const DAY = 86_400;

export interface HistoryExpiryPolicy {
  fiveMinuteDays: number;
  hourlyDays: number;
}

export interface HistoryExpiryResult {
  fiveMinuteDeleted: number;
  hourlyDeleted: number;
  fiveMinuteCutoff: number | null;
  hourlyCutoff: number | null;
  hourlyCoveredThrough: number | null;
  paused: boolean;
  rowsRead: number;
  rowsWritten: number;
}

function parseDays(raw: string | undefined, fallback: number, minimum: number, key: string): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  if (!/^(0|[1-9][0-9]{0,3})$/u.test(raw.trim())) {
    throw new Error(`${key} must be 0 or an integer from ${minimum} to 3650 days.`);
  }
  const value = Number(raw.trim());
  if (value !== 0 && (value < minimum || value > 3650)) {
    throw new Error(`${key} must be 0 or an integer from ${minimum} to 3650 days.`);
  }
  return value;
}

export function historyExpiryPolicy(
  fiveMinuteRaw: string | undefined, hourlyRaw: string | undefined,
): HistoryExpiryPolicy {
  const fiveMinuteDays = parseDays(
    fiveMinuteRaw, HISTORY_5MIN_RETENTION_DAYS, 90, "HISTORY_5MIN_RETENTION_DAYS",
  );
  const hourlyDays = parseDays(
    hourlyRaw, HISTORY_HOURLY_RETENTION_DAYS, 365, "HISTORY_HOURLY_RETENTION_DAYS",
  );
  if (fiveMinuteDays !== 0 && hourlyDays !== 0 && hourlyDays <= fiveMinuteDays) {
    throw new Error("Hourly retention must exceed five-minute retention.");
  }
  return { fiveMinuteDays, hourlyDays };
}

export function shouldExpireHistory(scheduledTimeMs: number): boolean {
  return new Date(scheduledTimeMs).getUTCMinutes() % 10 === 0;
}

function expiredBefore(nowSeconds: number, days: number, resolution: number): number {
  // A bucket must be fully in the past before being eligible for deletion.
  return Math.max(0, Math.floor((Math.floor(nowSeconds) - days * DAY) / resolution) * resolution);
}

async function pruneSummary(
  db: D1Database, resolution: 300 | 3600, before: number, batchSize: number,
): Promise<{ deleted: number; rowsRead: number; rowsWritten: number }> {
  const table = resolution === HISTORY_FIVE_MINUTES ? "history_5min" : "history_hourly";
  const result = await db.prepare(
    `DELETE FROM ${table}
       WHERE rowid IN (
         SELECT rowid FROM ${table}
          WHERE bucket_start < ?1
          ORDER BY bucket_start ASC
          LIMIT ?2
       )`,
  ).bind(before, batchSize).run();
  return {
    deleted: result.meta.changes ?? 0,
    rowsRead: result.meta.rows_read ?? 0,
    rowsWritten: result.meta.rows_written ?? 0,
  };
}

/** At most 350 deleted summary rows per 10 min; never touches user/raw tables. */
export async function expireIntelligentHistory(
  db: D1Database,
  nowSeconds: number,
  policy: HistoryExpiryPolicy = historyExpiryPolicy(undefined, undefined),
): Promise<HistoryExpiryResult> {
  if (!Number.isFinite(nowSeconds) || nowSeconds < 0) {
    throw new Error("Invalid history expiry timestamp.");
  }
  // Validate callers too; not just policy parsed from environment.
  historyExpiryPolicy(String(policy.fiveMinuteDays), String(policy.hourlyDays));

  const zero: HistoryExpiryResult = {
    fiveMinuteDeleted: 0, hourlyDeleted: 0,
    fiveMinuteCutoff: null, hourlyCutoff: null,
    hourlyCoveredThrough: null, paused: false, rowsRead: 0, rowsWritten: 0,
  };
  if (policy.fiveMinuteDays === 0 && policy.hourlyDays === 0) return zero;

  // No hourly checkpoint means no proof that 5-minute data is safe to drop.
  const progress = await db.prepare(
    "SELECT processed_until AS processedUntil FROM history_rollup_watermarks " +
    "WHERE resolution_seconds = ?1",
  ).bind(HISTORY_HOUR).first<{ processedUntil: number }>();
  if (!progress || !Number.isFinite(progress.processedUntil)) {
    return { ...zero, paused: true };
  }
  const hourlyCoveredThrough = progress.processedUntil;

  let fiveMinuteDeleted = 0;
  let hourlyDeleted = 0;
  let rowsRead = 0;
  let rowsWritten = 0;
  let fiveMinuteCutoff: number | null = null;
  let hourlyCutoff: number | null = null;

  if (policy.fiveMinuteDays > 0) {
    fiveMinuteCutoff = Math.min(
      expiredBefore(nowSeconds, policy.fiveMinuteDays, HISTORY_FIVE_MINUTES),
      Math.floor(hourlyCoveredThrough / HISTORY_FIVE_MINUTES) * HISTORY_FIVE_MINUTES,
    );
    if (fiveMinuteCutoff > 0) {
      const result = await pruneSummary(db, HISTORY_FIVE_MINUTES, fiveMinuteCutoff,
        HISTORY_5MIN_PRUNE_BATCH);
      fiveMinuteDeleted = result.deleted;
      rowsRead += result.rowsRead;
      rowsWritten += result.rowsWritten;
    }
  }

  if (policy.hourlyDays > 0) {
    // If 5-minute expiry is lagging, retain the hourly backup for those
    // still-present buckets. This prevents an accidental coverage gap.
    const oldestFine = await db.prepare(
      "SELECT MIN(bucket_start) AS earliest FROM history_5min",
    ).first<{ earliest: number | null }>();
    const oldestFineBoundary = oldestFine?.earliest === null ||
      oldestFine?.earliest === undefined ?
      Number.POSITIVE_INFINITY :
      Math.floor(oldestFine.earliest / HISTORY_HOUR) * HISTORY_HOUR;
    hourlyCutoff = Math.min(
      expiredBefore(nowSeconds, policy.hourlyDays, HISTORY_HOUR),
      Math.floor(hourlyCoveredThrough / HISTORY_HOUR) * HISTORY_HOUR,
      oldestFineBoundary,
    );
    if (hourlyCutoff > 0) {
      const result = await pruneSummary(db, HISTORY_HOUR, hourlyCutoff,
        HISTORY_HOURLY_PRUNE_BATCH);
      hourlyDeleted = result.deleted;
      rowsRead += result.rowsRead;
      rowsWritten += result.rowsWritten;
    }
  }

  return {
    fiveMinuteDeleted, hourlyDeleted,
    fiveMinuteCutoff, hourlyCutoff, hourlyCoveredThrough,
    paused: false, rowsRead, rowsWritten,
  };
}

export async function runIntelligentHistoryExpiry(
  env: Env, scheduledTimeMs: number,
): Promise<HistoryExpiryResult> {
  const options = env as Env & {
    HISTORY_5MIN_RETENTION_DAYS?: string;
    HISTORY_HOURLY_RETENTION_DAYS?: string;
  };
  const policy = historyExpiryPolicy(
    options.HISTORY_5MIN_RETENTION_DAYS,
    options.HISTORY_HOURLY_RETENTION_DAYS,
  );
  const result = await expireIntelligentHistory(env.DB,
    Math.floor(scheduledTimeMs / 1000), policy);
  console.info("Intelligent history expiry", { ...policy, ...result });
  if (result.paused) {
    console.warn("Intelligent history expiry paused: hourly archive is not verified");
  }
  if (result.fiveMinuteDeleted === HISTORY_5MIN_PRUNE_BATCH ||
      result.hourlyDeleted === HISTORY_HOURLY_PRUNE_BATCH) {
    console.warn("Intelligent history expiry batch at capacity", { ...policy, ...result });
  }
  return result;
}
