import { describe, expect, it, vi } from "vitest";
import {
  assessD1Health,
  D1_HEALTH_CRITICAL_BYTES,
  D1_HEALTH_WARNING_BYTES,
  RETENTION_DAILY_CAPACITY,
  runD1DailyHealth,
  shouldRunD1DailyHealth,
} from "../src/d1-health";

describe("D1 daily monitoring", () => {
  it("runs only at 12:05 UTC, once per day", () => {
    expect(shouldRunD1DailyHealth(Date.UTC(2026, 9, 28, 12, 5))).toBe(true);
    expect(shouldRunD1DailyHealth(Date.UTC(2026, 9, 28, 12, 4))).toBe(false);
    expect(shouldRunD1DailyHealth(Date.UTC(2026, 9, 28, 13, 5))).toBe(false);
  });

  it("detects storage, ingest and expiry backlog risks", () => {
    const normal = { sizeBytes: 1_146_880, telemetryRows: 294, rowsLast24h: 294, expiredRows: 0 };
    expect(assessD1Health(normal).level).toBe("normal");
    expect(assessD1Health({ ...normal, sizeBytes: D1_HEALTH_WARNING_BYTES }).level).toBe("warning");
    expect(assessD1Health({ ...normal, sizeBytes: D1_HEALTH_CRITICAL_BYTES }).level).toBe("critical");
    expect(assessD1Health({ ...normal, rowsLast24h: RETENTION_DAILY_CAPACITY * 0.8 }).level).toBe("warning");
    expect(assessD1Health({ ...normal, rowsLast24h: RETENTION_DAILY_CAPACITY }).level).toBe("critical");
    expect(assessD1Health({ ...normal, expiredRows: 1_000 }).level).toBe("warning");
    expect(assessD1Health({ ...normal, expiredRows: RETENTION_DAILY_CAPACITY }).level).toBe("critical");
    expect(assessD1Health({ ...normal, sizeBytes: null }).level).toBe("warning");
  });

  it("records daily metrics without sending routine email", async () => {
    const queries: string[] = [];
    const written: unknown[][] = [];
    const email = vi.fn();
    const db = {
      prepare(sql: string) {
        queries.push(sql);
        return {
          bind(...args: unknown[]) {
            return {
              all: async () => ({
                results: [{ telemetryRows: 294, rowsLast24h: 294, expiredRows: 0 }],
                meta: { size_after: 1_146_880 },
              }),
              first: async () => ({ sizeBytes: 1_100_000 }),
              run: async () => { written.push(args); return { meta: { changes: 1 } }; },
            };
          },
        };
      },
    } as unknown as D1Database;
    const env = { DB: db, EMAIL: { send: email } } as unknown as Env;
    const result = await runD1DailyHealth(env, Date.UTC(2026, 9, 28, 12, 5));
    expect(result.level).toBe("normal");
    expect(result.growthBytes).toBe(46_880);
    expect(written).toHaveLength(1);
    expect(written[0]?.[0]).toBe("2026-10-28");
    expect(queries.some((query) => query.includes("FROM telemetry"))).toBe(true);
    expect(queries.some((query) => query.includes("INSERT INTO d1_health_daily"))).toBe(true);
    expect(email).not.toHaveBeenCalled();
  });

  it("sends email for critical health even if snapshot write fails", async () => {
    const email = vi.fn(async (_message: { subject: string }) => ({ messageId: "test-alert" }));
    const db = {
      prepare(_sql: string) {
        return {
          bind() {
            return {
              all: async () => ({
                results: [{ telemetryRows: 90000, rowsLast24h: 40000, expiredRows: 300 }],
                meta: { size_after: 380_000_000 },
              }),
              first: async () => null,
              run: async () => { throw new Error("D1 storage unavailable"); },
            };
          },
        };
      },
    } as unknown as D1Database;
    const env = {
      DB: db, EMAIL: { send: email },
      NOTIFICATION_EMAIL_FROM: "alerts@example.com", SALES_EMAIL_TO: "admin@example.com",
    } as unknown as Env;
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = await runD1DailyHealth(env, Date.UTC(2026, 9, 28, 12, 5));
      expect(result.level).toBe("critical");
      expect(errorLog).toHaveBeenCalledWith("D1 health snapshot failed", expect.anything());
      expect(email).toHaveBeenCalledTimes(1);
      expect(email.mock.calls[0]?.[0]?.subject).toContain("CRITICAL");
    } finally {
      errorLog.mockRestore();
    }
  });
});
