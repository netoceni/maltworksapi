import { requireSystemAdmin } from "./admin";
import { jsonResponse } from "./http";
import {
  historyExpiryPolicy, HISTORY_5MIN_PRUNE_BATCH, HISTORY_HOURLY_PRUNE_BATCH,
} from "./history-retention";
import {
  completedHistoryWatermark, completeHistoryUntil,
  HISTORY_FIVE_MINUTES, HISTORY_HOUR,
} from "./history-rollup";

/**
 * Read-only observability for system administrators.
 * Never returns account, device, organization or raw payload identifiers.
 */
export async function adminIntelligentHistoryHealth(
  request: Request, env: Env, requestId: string,
): Promise<Response> {
  await requireSystemAdmin(request, env);
  const now = Math.floor(Date.now() / 1000);
  const settings = env as Env & {
    HISTORY_5MIN_RETENTION_DAYS?: string;
    HISTORY_HOURLY_RETENTION_DAYS?: string;
  };
  const expiryPolicy = historyExpiryPolicy(
    settings.HISTORY_5MIN_RETENTION_DAYS,
    settings.HISTORY_HOURLY_RETENTION_DAYS,
  );
  const [progress, metrics, oldest] = await Promise.all([
    env.DB.prepare(
      "SELECT resolution_seconds AS resolutionSeconds, " +
      "processed_until AS processedUntil, updated_at AS updatedAt " +
      "FROM history_rollup_watermarks ORDER BY resolution_seconds",
    ).all<{ resolutionSeconds: number; processedUntil: number; updatedAt: number }>(),
    env.DB.prepare(
      "SELECT (SELECT COUNT(*) FROM history_5min) AS fiveMinuteRows, " +
      "(SELECT COUNT(*) FROM history_hourly) AS hourlyRows, " +
      "(SELECT COUNT(*) FROM telemetry) AS rawRows",
    ).first<{ fiveMinuteRows: number; hourlyRows: number; rawRows: number }>(),
    env.DB.prepare(
      "SELECT (SELECT MIN(bucket_start) FROM history_5min) AS oldestFiveMinuteBucket, " +
      "(SELECT MIN(bucket_start) FROM history_hourly) AS oldestHourlyBucket",
    ).first<{ oldestFiveMinuteBucket: number | null; oldestHourlyBucket: number | null }>(),
  ]);

  const summaries = [HISTORY_FIVE_MINUTES, HISTORY_HOUR].map((resolution) => {
    const row = progress.results.find((value) => value.resolutionSeconds === resolution);
    return {
      resolutionSeconds: resolution,
      processedUntil: row?.processedUntil ?? null,
      updatedAt: row?.updatedAt ?? null,
      lagSeconds: row ? Math.max(0, now - row.processedUntil) : null,
    };
  });
  return jsonResponse({
    ok: true,
    status: summaries.some((row) => row.processedUntil === null)
      ? "warming_up"
      : summaries.some((row) => row.processedUntil! <
        completeHistoryUntil(now, row.resolutionSeconds as 300 | 3600))
        ? "catching_up" : "available",
    rawRows: metrics?.rawRows ?? 0,
    fiveMinuteRows: metrics?.fiveMinuteRows ?? 0,
    hourlyRows: metrics?.hourlyRows ?? 0,
    retentionSafeThrough: await completedHistoryWatermark(env.DB),
    expiry: {
      fiveMinuteDays: expiryPolicy.fiveMinuteDays,
      hourlyDays: expiryPolicy.hourlyDays,
      maxFineDeletesEvery10Minutes: HISTORY_5MIN_PRUNE_BATCH,
      maxHourlyDeletesEvery10Minutes: HISTORY_HOURLY_PRUNE_BATCH,
      oldestFiveMinuteBucket: oldest?.oldestFiveMinuteBucket ?? null,
      oldestHourlyBucket: oldest?.oldestHourlyBucket ?? null,
    },
    summaries, requestId,
  });
}
