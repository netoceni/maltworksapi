import { requireSession, selectOrganization } from "./auth";
import { jsonResponse } from "./http";
import {
  HISTORY_FIVE_MINUTES, HISTORY_HOUR, completeHistoryUntil, type HistoryResolution,
} from "./history-rollup";
import { ApiError } from "./types";

const DAY = 86_400;
const YEAR = 365 * DAY;
const FIVE_MINUTE_MAX_RANGE = 90 * DAY;

interface AggregateRow {
  receivedAt: number;
  bucketStart: number;
  samples: number;
  refrigeratorValue: number | null;
  refrigeratorMin: number | null;
  refrigeratorMax: number | null;
  thermalWellValue: number | null;
  thermalWellMin: number | null;
  thermalWellMax: number | null;
  setpoint: number | null;
  setpointMin: number;
  setpointMax: number;
  coolingSamples: number;
  heatingSamples: number;
  alarmSamples: number;
  rssi: number | null;
}

export interface HistoryQueryOptions {
  rangeSeconds: number;
  requestedMaxPoints: number;
  sourceResolutionSeconds: HistoryResolution;
  outputBucketSeconds: number;
}

export function historyQueryOptions(
  rawRange: string | null,
  rawMaxPoints: string | null,
): HistoryQueryOptions {
  const range = rawRange ?? String(30 * DAY);
  const rangeSeconds = range === "all" ? YEAR : Number(range);
  if (range !== "all" && !/^[1-9][0-9]*$/u.test(range)) {
    throw new ApiError(400, "INVALID_HISTORY_RANGE", "Periodo do historico invalido.");
  }
  if (!Number.isSafeInteger(rangeSeconds) || rangeSeconds < 300 || rangeSeconds > YEAR) {
    throw new ApiError(400, "INVALID_HISTORY_RANGE", "Periodo do historico invalido.");
  }
  const maxString = rawMaxPoints ?? "720";
  if (!/^[1-9][0-9]*$/u.test(maxString)) {
    throw new ApiError(400, "INVALID_MAX_POINTS", "Numero de pontos invalido.");
  }
  const requestedMaxPoints = Number(maxString);
  if (!Number.isSafeInteger(requestedMaxPoints) ||
      requestedMaxPoints < 20 || requestedMaxPoints > 1000) {
    throw new ApiError(400, "INVALID_MAX_POINTS", "Numero de pontos invalido.");
  }
  const sourceResolutionSeconds: HistoryResolution = rangeSeconds <= FIVE_MINUTE_MAX_RANGE ?
    HISTORY_FIVE_MINUTES : HISTORY_HOUR;
  const outputBucketSeconds = Math.ceil(
    Math.max(1, Math.ceil(rangeSeconds / requestedMaxPoints)) /
      sourceResolutionSeconds,
  ) * sourceResolutionSeconds;
  return { rangeSeconds, requestedMaxPoints, sourceResolutionSeconds, outputBucketSeconds };
}

/**
 * Nonbreaking historical endpoint: existing GET .../telemetry stays unchanged
 * while v5.19 clients can opt in to explicit archive resolution metadata.
 * No plan gates are inferred here; entitlement decisions are still pending.
 */
export async function aggregatedDeviceHistory(
  request: Request, env: Env, requestId: string, deviceId: string,
): Promise<Response> {
  const session = await requireSession(request, env);
  const url = new URL(request.url);
  const organizationId = selectOrganization(session, url.searchParams.get("organizationId"));
  const device = await env.DB.prepare(
    "SELECT id FROM devices WHERE id = ?1 AND organization_id = ?2",
  ).bind(deviceId, organizationId).first();
  if (!device) throw new ApiError(404, "DEVICE_NOT_FOUND", "Controlador nao encontrado.");

  const options = historyQueryOptions(
    url.searchParams.get("range"), url.searchParams.get("maxPoints"),
  );
  const now = Math.floor(Date.now() / 1000);
  const since = now - options.rangeSeconds;
  // Include the first source bucket if it partially overlaps the requested range.
  const alignedSince = Math.floor(since / options.sourceResolutionSeconds) *
    options.sourceResolutionSeconds;
  const table = options.sourceResolutionSeconds === HISTORY_FIVE_MINUTES ?
    "history_5min" : "history_hourly";
  // Only predefined resolutions and validated, bounded integer bucket widths
  // are included in the SQL; all user identifiers and periods are bound.
  const span = options.outputBucketSeconds;
  const bucket = `CAST(bucket_start / ${span} AS INTEGER) * ${span}`;
  const watermark = await env.DB.prepare(
    "SELECT processed_until AS processedUntil FROM history_rollup_watermarks " +
    "WHERE resolution_seconds = ?1",
  ).bind(options.sourceResolutionSeconds).first<{ processedUntil: number }>();

  const rows = await env.DB.prepare(
    `SELECT ${bucket} AS bucketStart,
      MAX(bucket_start) + ${options.sourceResolutionSeconds} AS receivedAt,
      SUM(samples) AS samples,
      CASE WHEN SUM(refrigerator_count) > 0
        THEN SUM(refrigerator_sum) * 1.0 / SUM(refrigerator_count) ELSE NULL END AS refrigeratorValue,
      MIN(refrigerator_min) AS refrigeratorMin,
      MAX(refrigerator_max) AS refrigeratorMax,
      CASE WHEN SUM(thermal_well_count) > 0
        THEN SUM(thermal_well_sum) * 1.0 / SUM(thermal_well_count) ELSE NULL END AS thermalWellValue,
      MIN(thermal_well_min) AS thermalWellMin,
      MAX(thermal_well_max) AS thermalWellMax,
      SUM(setpoint_sum) * 1.0 / SUM(samples) AS setpoint,
      MIN(setpoint_min) AS setpointMin,
      MAX(setpoint_max) AS setpointMax,
      SUM(cooling_samples) AS coolingSamples,
      SUM(heating_samples) AS heatingSamples,
      SUM(alarm_samples) AS alarmSamples,
      SUM(rssi_sum) * 1.0 / SUM(samples) AS rssi
     FROM ${table}
     WHERE device_id = ?1 AND bucket_start >= ?2 AND bucket_start < ?3
     GROUP BY ${bucket}
     ORDER BY bucketStart DESC
     LIMIT ?4`,
  ).bind(deviceId, alignedSince, now, options.requestedMaxPoints).all<AggregateRow>();
  return jsonResponse({
    ok: true,
    deviceId,
    source: "d1_aggregate",
    range: url.searchParams.get("range") ?? String(30 * DAY),
    from: since,
    to: now,
    bucketSeconds: options.outputBucketSeconds,
    sourceResolutionSeconds: options.sourceResolutionSeconds,
    completeThrough: watermark?.processedUntil ?? null,
    status: !watermark ? "warming_up" :
      watermark.processedUntil < completeHistoryUntil(now, options.sourceResolutionSeconds)
        ? "catching_up" : "available",
    points: rows.results,
    totalPoints: rows.results.length,
    truncated: rows.results.length >= options.requestedMaxPoints,
    requestId,
  });
}
