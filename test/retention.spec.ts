import { describe, expect, it } from "vitest";
import {
  pruneExpiredTelemetry,
  shouldPruneTelemetry,
  telemetryRetentionDays,
} from "../src/retention";

describe("raw telemetry retention", () => {
  it("validates retention policy and cron cadence", () => {
    expect(telemetryRetentionDays(undefined)).toBe(7);
    expect(telemetryRetentionDays("30")).toBe(30);
    expect(telemetryRetentionDays("0")).toBe(0);
    expect(() => telemetryRetentionDays("-1")).toThrow();
    expect(() => telemetryRetentionDays("7.5")).toThrow();
    expect(shouldPruneTelemetry(Date.UTC(2026, 9, 27, 10, 20))).toBe(true);
    expect(shouldPruneTelemetry(Date.UTC(2026, 9, 27, 10, 21))).toBe(false);
  });

  it("issues a bounded delete with cutoff and does not run when disabled", async () => {
    let sql = "";
    let args: unknown[] = [];
    const db = {
      prepare(statement: string) {
        sql = statement;
        return {
          bind(...values: unknown[]) {
            args = values;
            return { run: async () => ({ meta: { changes: 3 } }) };
          },
        };
      },
    } as unknown as D1Database;
    expect(await pruneExpiredTelemetry(db, 1_800_000_000, 7, 250)).toBe(3);
    expect(sql).toContain("DELETE FROM telemetry");
    expect(sql).toContain("received_at < ?1");
    expect(sql).toContain("LIMIT ?2");
    expect(args).toEqual([1_800_000_000 - 7 * 86_400, 250]);
    sql = "";
    expect(await pruneExpiredTelemetry(db, 1_800_000_000, 0)).toBe(0);
    expect(sql).toBe("");
    await expect(pruneExpiredTelemetry(db, 1_800_000_000, 7, 1001)).rejects.toThrow();
  });
});
