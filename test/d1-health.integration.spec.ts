import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { runD1DailyHealth } from "../src/d1-health";

describe("D1 health snapshot (real SQL)", () => {
  it("records a daily measurement without altering telemetry", async () => {
    const scheduled = Date.UTC(2026, 9, 29, 12, 5);
    const report = await runD1DailyHealth(env, scheduled);
    expect(report.sizeBytes).not.toBeNull();
    expect(report.level).toBe("normal");
    const snapshot = await env.DB.prepare(
      "SELECT sampled_at AS sampledAt, telemetry_rows AS telemetryRows " +
      "FROM d1_health_daily WHERE day_utc = ?1",
    ).bind("2026-10-29").first<{ sampledAt: number; telemetryRows: number }>();
    expect(snapshot?.sampledAt).toBe(Math.floor(scheduled / 1000));
    expect(snapshot?.telemetryRows).toBe(report.telemetryRows);
  });
});
