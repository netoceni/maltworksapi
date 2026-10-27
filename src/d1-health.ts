import { RETENTION_BATCH_SIZE, telemetryRetentionDays } from "./retention";

// Workers Free: 500 MB per D1 database (decimal bytes).
export const D1_FREE_LIMIT_BYTES = 500_000_000;
export const D1_HEALTH_WARNING_BYTES = 250_000_000;
export const D1_HEALTH_CRITICAL_BYTES = 350_000_000;
export const RETENTION_DAILY_CAPACITY = RETENTION_BATCH_SIZE * 6 * 24;

export type D1HealthLevel = "normal" | "warning" | "critical";

export interface D1HealthMetrics {
  sizeBytes: number | null;
  telemetryRows: number;
  rowsLast24h: number;
  expiredRows: number;
}

export interface D1HealthAssessment {
  level: D1HealthLevel;
  reasons: string[];
}

export interface D1DailyHealthReport extends D1HealthMetrics, D1HealthAssessment {
  sampledAt: number;
  dayUtc: string;
  retentionDays: number;
  growthBytes: number | null;
}

// Five minutes after the 12:00 UTC retention run, once per day (09:05 BRT).
export function shouldRunD1DailyHealth(scheduledTimeMs: number): boolean {
  const date = new Date(scheduledTimeMs);
  return date.getUTCHours() === 12 && date.getUTCMinutes() === 5;
}

export function assessD1Health(metrics: D1HealthMetrics): D1HealthAssessment {
  let level: D1HealthLevel = "normal";
  const reasons: string[] = [];
  const warning = (reason: string) => {
    reasons.push(reason);
    if (level === "normal") level = "warning";
  };
  const critical = (reason: string) => {
    reasons.push(reason);
    level = "critical";
  };

  if (metrics.sizeBytes === null || !Number.isFinite(metrics.sizeBytes)) {
    warning("O tamanho do banco nao foi disponibilizado pelo D1.");
  } else if (metrics.sizeBytes >= D1_HEALTH_CRITICAL_BYTES) {
    critical("Armazenamento D1 >= 350 MB (70% da capacidade).");
  } else if (metrics.sizeBytes >= D1_HEALTH_WARNING_BYTES) {
    warning("Armazenamento D1 >= 250 MB (50% da capacidade).");
  }

  if (metrics.rowsLast24h >= RETENTION_DAILY_CAPACITY) {
    critical("Telemetria em 24h >= capacidade maxima diaria de limpeza.");
  } else if (metrics.rowsLast24h >= RETENTION_DAILY_CAPACITY * 0.8) {
    warning("Telemetria em 24h >= 80% da capacidade diaria de limpeza.");
  }

  if (metrics.expiredRows >= RETENTION_DAILY_CAPACITY) {
    critical("Fila de registros expirados >= capacidade de um dia de limpeza.");
  } else if (metrics.expiredRows >= RETENTION_BATCH_SIZE * 4) {
    warning("Fila de pelo menos 1000 registros expirados; verificar retencao.");
  }

  return { level, reasons };
}

/**
 * SELECTs inspect the database; one tiny daily snapshot supports trend analysis.
 * Snapshot failure does not block email alerts (e.g. when storage is exhausted).
 */
export async function runD1DailyHealth(
  env: Env,
  scheduledTimeMs: number,
): Promise<D1DailyHealthReport> {
  const now = Math.floor(scheduledTimeMs / 1000);
  const dayUtc = new Date(scheduledTimeMs).toISOString().slice(0, 10);
  const settings = env as Env & { TELEMETRY_RETENTION_DAYS?: string };
  const retentionDays = telemetryRetentionDays(settings.TELEMETRY_RETENTION_DAYS);
  const cutoff = retentionDays === 0 ? 0 : now - retentionDays * 86_400;

  const measurement = await env.DB.prepare(
    "SELECT " +
    "(SELECT COUNT(*) FROM telemetry) AS telemetryRows, " +
    "(SELECT COUNT(*) FROM telemetry WHERE received_at >= ?1) AS rowsLast24h, " +
    "(SELECT COUNT(*) FROM telemetry WHERE received_at < ?2) AS expiredRows",
  ).bind(now - 86_400, cutoff).all<{
    telemetryRows: number;
    rowsLast24h: number;
    expiredRows: number;
  }>();

  const values = measurement.results[0];
  if (!values) throw new Error("D1 health measurement returned no rows.");

  const reportedSize = measurement.meta.size_after;
  const metrics: D1HealthMetrics = {
    sizeBytes: Number.isFinite(reportedSize) ? reportedSize : null,
    telemetryRows: values.telemetryRows,
    rowsLast24h: values.rowsLast24h,
    expiredRows: values.expiredRows,
  };
  const assessment = assessD1Health(metrics);

  let growthBytes: number | null = null;
  try {
    const previous = await env.DB.prepare(
      "SELECT size_bytes AS sizeBytes FROM d1_health_daily " +
      "WHERE day_utc < ?1 ORDER BY day_utc DESC LIMIT 1",
    ).bind(dayUtc).first<{ sizeBytes: number }>();
    if (previous && metrics.sizeBytes !== null) {
      growthBytes = metrics.sizeBytes - previous.sizeBytes;
    }
  } catch (error) {
    console.error("D1 health trend lookup failed", { message: messageFor(error) });
  }

  const report: D1DailyHealthReport = {
    sampledAt: now,
    dayUtc,
    retentionDays,
    growthBytes,
    ...metrics,
    ...assessment,
  };

  if (metrics.sizeBytes !== null) {
    try {
      await env.DB.prepare(
        "INSERT INTO d1_health_daily " +
        "(day_utc, sampled_at, size_bytes, telemetry_rows, rows_last_24h, expired_rows, level) " +
        "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) " +
        "ON CONFLICT(day_utc) DO UPDATE SET " +
        "sampled_at = excluded.sampled_at, size_bytes = excluded.size_bytes, " +
        "telemetry_rows = excluded.telemetry_rows, rows_last_24h = excluded.rows_last_24h, " +
        "expired_rows = excluded.expired_rows, level = excluded.level",
      ).bind(dayUtc, now, metrics.sizeBytes, metrics.telemetryRows,
        metrics.rowsLast24h, metrics.expiredRows, assessment.level).run();
    } catch (error) {
      console.error("D1 health snapshot failed", { message: messageFor(error) });
    }
  }

  console.info("D1 daily health", report);
  if (assessment.level !== "normal") {
    await emailD1HealthAlert(env, report);
  }
  return report;
}

async function emailD1HealthAlert(env: Env, report: D1DailyHealthReport): Promise<void> {
  const from = env.NOTIFICATION_EMAIL_FROM?.trim() || env.SALES_EMAIL_FROM?.trim();
  const to = env.SALES_EMAIL_TO?.trim();
  if (!from || !to) {
    console.error("D1 health email not configured", { level: report.level });
    return;
  }

  const sizeText = report.sizeBytes === null
    ? "indisponivel"
    : (report.sizeBytes / 1_000_000).toFixed(2) + " MB / 500 MB";
  const lines = [
    "Nivel: " + report.level.toUpperCase(),
    "Data UTC: " + report.dayUtc,
    "Tamanho D1: " + sizeText,
    "Telemetrias totais: " + report.telemetryRows,
    "Telemetrias ultimas 24h: " + report.rowsLast24h,
    "Registros expirados: " + report.expiredRows,
    "Retencao: " + report.retentionDays + " dias",
    "Variacao desde a medicao anterior: " +
      (report.growthBytes === null ? "sem comparativo" : report.growthBytes + " bytes"),
    "",
    ...report.reasons,
    "",
    "Verifique o D1 e os logs da API. Nenhuma limpeza adicional foi executada por este monitor.",
  ];

  await env.EMAIL.send({
    from: { email: from, name: "Maltworks" },
    to,
    subject: "[Maltworks Cloud] D1 " + report.level.toUpperCase() + " - " + report.dayUtc,
    text: lines.join("\n"),
  });
  console.info("D1 health email dispatched", { level: report.level, dayUtc: report.dayUtc });
}

function messageFor(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
