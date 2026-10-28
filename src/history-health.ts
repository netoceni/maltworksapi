import { requireSystemAdmin } from "./admin";
import { jsonResponse } from "./http";
import { completedHistoryWatermark, HISTORY_FIVE_MINUTES, HISTORY_HOUR } from "./history-rollup";

/**
 * Read-only observability for system administrators.
 * Never returns account, device, organization or raw payload identifiers.
 */
export async function adminIntelligentHistoryHealth(
  request: Request, env: Env, requestId: string,
): Promise<Response> {
  await requireSystemAdmin(request, env);
  const now = Math.floor(Date.now() / 1000);
  const [progress, metrics] = await Promise.all([
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
    ok: true, status: summaries.some((row) => row.processedUntil === null)
      ? "warming_up" : "available",
    rawRows: metrics?.rawRows ?? 0,
    fiveMinuteRows: metrics?.fiveMinuteRows ?? 0,
    hourlyRows: metrics?.hourlyRows ?? 0,
    retentionSafeThrough: await completedHistoryWatermark(env.DB),
    summaries, requestId,
  });
}
