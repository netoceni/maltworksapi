/**
 * Retention for raw temperature telemetry only.
 * Profiles, device configuration, sessions, users, batches and audit records
 * are intentionally outside of this cleanup job.
 */
export const DEFAULT_TELEMETRY_RETENTION_DAYS = 7;
export const RETENTION_BATCH_SIZE = 250;
const MAX_RETENTION_DAYS = 3650;

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

/** Keep the existing once-per-minute cron, but prune only every 10 minutes. */
export function shouldPruneTelemetry(scheduledTimeMs: number): boolean {
  return new Date(scheduledTimeMs).getUTCMinutes() % 10 === 0;
}

/**
 * Delete a bounded number of expired rows per invocation. Never delete the
 * latest device state: that is stored in device_latest_state separately.
 */
export async function pruneExpiredTelemetry(
  db: D1Database,
  nowSeconds: number,
  retentionDays: number,
  limit = RETENTION_BATCH_SIZE,
): Promise<number> {
  if (!Number.isInteger(retentionDays) || retentionDays < 0 || retentionDays > MAX_RETENTION_DAYS) {
    throw new Error("Invalid telemetry retention days.");
  }
  if (retentionDays === 0) return 0; // Explicitly disable deletion.
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
    throw new Error("Telemetry pruning batch must be between 1 and 1000 rows.");
  }
  const cutoff = Math.floor(nowSeconds) - retentionDays * 86_400;
  const result = await db.prepare(
    `DELETE FROM telemetry
      WHERE id IN (
        SELECT id FROM telemetry
         WHERE received_at < ?1
         ORDER BY received_at ASC, id ASC
         LIMIT ?2
      )`,
  ).bind(cutoff, limit).run();
  return result.meta.changes ?? 0;
}

export async function runTelemetryRetention(env: Env, scheduledTimeMs: number): Promise<number> {
  // Until worker-bindings.d.ts is regenerated, preserve the generated Env type.
  const settings = env as Env & { TELEMETRY_RETENTION_DAYS?: string };
  const days = telemetryRetentionDays(settings.TELEMETRY_RETENTION_DAYS);
  const deletedRows = await pruneExpiredTelemetry(env.DB, scheduledTimeMs / 1000, days);
  if (deletedRows > 0) {
    console.info("Telemetry retention", {
      retentionDays: days,
      deletedRows,
    });
  }
  return deletedRows;
}
