import { completedHistoryWatermark } from "./history-rollup";

/**
 * Retention for detailed telemetry only.
 * Accounts, credentials, device_latest_state, recipes, fermentation records
 * and audit events are not touched by the cleanup job.
 */
export const DEFAULT_TELEMETRY_RETENTION_DAYS = 7;
// Provides 57,600 raw-delete capacity/day, allowing headroom above
// 25 devices x 1 minute (36,000) plus safety-event snapshots.
// Requires Workers/D1 Paid before operating a 25-device fleet.
// 250 x 144 cleanups/day = 36,000 raw rows/day. The Free 10-controller
// pilot generates ~4,800 stable snapshots/day (plus safety transitions).
export const RETENTION_BATCH_SIZE = 250;
export const D1_STORAGE_WARNING_BYTES = 350_000_000;
const MAX_RETENTION_DAYS = 3650;

export interface TelemetryPruneStats {
  deletedRows: number;
  sizeAfterBytes: number | null;
  rowsRead: number | null;
  rowsWritten: number | null;
}

export function telemetryRetentionDays(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_TELEMETRY_RETENTION_DAYS;
  const value = raw.trim();
  if (!/^(0|[1-9][0-9]{0,3})$/u.test(value)) {
    throw new Error("TELEMETRY_RETENTION_DAYS must be an integer from 0 to 3650.");
  }
  const days = Number(value);
  if (days > MAX_RETENTION_DAYS) {
    throw new Error("TELEMETRY_RETENTION_DAYS must be an integer from 0 to 3650.");
  }
  return days;
}

/** Keep the existing once-per-minute cron; prune only every 10 minutes. */
export function shouldPruneTelemetry(scheduledTimeMs: number): boolean {
  return new Date(scheduledTimeMs).getUTCMinutes() % 10 === 0;
}

/**
 * Delete only expired raw samples, in a small bounded batch.
 * The migration idx_telemetry_received_at_id makes the expiration lookup
 * efficient even when telemetry contains many devices and rows.
 */
export async function pruneExpiredTelemetry(
  db: D1Database,
  nowSeconds: number,
  retentionDays: number,
  limit = RETENTION_BATCH_SIZE,
): Promise<TelemetryPruneStats> {
  if (!Number.isInteger(retentionDays) || retentionDays < 0 || retentionDays > MAX_RETENTION_DAYS) {
    throw new Error("Invalid telemetry retention days.");
  }
  if (retentionDays === 0) {
    return { deletedRows: 0, sizeAfterBytes: null, rowsRead: null, rowsWritten: null };
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
    throw new Error("Telemetry pruning batch must be between 1 and 1000 rows.");
  }
  const cutoff = Math.floor(nowSeconds) - retentionDays * 86_400;
  const archivedUntil = await completedHistoryWatermark(db);
  // Never remove raw data before both 5-minute and hourly summaries cover it.
  // A missing watermark (first deploy, delayed cron, D1 error) pauses deletion.
  if (archivedUntil === null || archivedUntil <= 0) {
    console.warn("Telemetry retention paused: intelligent history catch-up incomplete");
    return { deletedRows: 0, sizeAfterBytes: null, rowsRead: null, rowsWritten: null };
  }
  const safeCutoff = Math.min(cutoff, archivedUntil);
  const { meta } = await db.prepare(
    `DELETE FROM telemetry
      WHERE id IN (
        SELECT id FROM telemetry
         WHERE received_at < ?1
         ORDER BY received_at ASC, id ASC
         LIMIT ?2
      )`,
  ).bind(safeCutoff, limit).run();
  return {
    deletedRows: meta.changes ?? 0,
    sizeAfterBytes: Number.isFinite(meta.size_after) ? meta.size_after : null,
    rowsRead: Number.isFinite(meta.rows_read) ? meta.rows_read : null,
    rowsWritten: Number.isFinite(meta.rows_written) ? meta.rows_written : null,
  };
}

export async function runTelemetryRetention(env: Env, scheduledTimeMs: number): Promise<number> {
  // Generated Env types can be refreshed with wrangler types later.
  const settings = env as Env & { TELEMETRY_RETENTION_DAYS?: string };
  const retentionDays = telemetryRetentionDays(settings.TELEMETRY_RETENTION_DAYS);
  const stats = await pruneExpiredTelemetry(env.DB, scheduledTimeMs / 1000, retentionDays);

  // D1 returns its post-query size and row-usage metrics without an extra query.
  console.info("Telemetry retention", { retentionDays, ...stats });

  if (stats.sizeAfterBytes !== null && stats.sizeAfterBytes >= D1_STORAGE_WARNING_BYTES) {
    console.warn("D1 storage approaching free-tier capacity", {
      sizeAfterBytes: stats.sizeAfterBytes,
      warningThresholdBytes: D1_STORAGE_WARNING_BYTES,
    });
  }
  if (stats.deletedRows === RETENTION_BATCH_SIZE) {
    console.warn("Telemetry retention batch at capacity", {
      deletedRows: stats.deletedRows,
      batchSize: RETENTION_BATCH_SIZE,
    });
  }
  return stats.deletedRows;
}
