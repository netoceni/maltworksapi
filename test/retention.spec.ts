import { describe, expect, it, vi } from "vitest";
import {
  D1_STORAGE_WARNING_BYTES,
  pruneExpiredTelemetry,
  runTelemetryRetention,
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
    expect(() => telemetryRetentionDays("3651")).toThrow();
    expect(shouldPruneTelemetry(Date.UTC(2026, 9, 27, 10, 20))).toBe(true);
    expect(shouldPruneTelemetry(Date.UTC(2026, 9, 27, 10, 21))).toBe(false);
  });

  it("issues bounded deletes and uses D1 metadata without extra queries", async () => {
    let sql = "";
    let args: unknown[] = [];
    let calls = 0;
    const db = {
      prepare(statement: string) {
        calls++;
        if (statement.includes("history_rollup_watermarks")) {
          return { first: async () => ({ completedUntil: 1_800_000_000, resolutions: 2 }) };
        }
        sql = statement;
        return {
          bind(...values: unknown[]) {
            args = values;
            return {
              run: async () => ({
                meta: {
                  changes: 3,
                  size_after: 123456,
                  rows_read: 4,
                  rows_written: 6,
                },
              }),
            };
          },
        };
      },
    } as unknown as D1Database;

    expect(await pruneExpiredTelemetry(db, 1_800_000_000, 7, 250)).toEqual({
      deletedRows: 3,
      sizeAfterBytes: 123456,
      rowsRead: 4,
      rowsWritten: 6,
    });
    expect(sql).toContain("DELETE FROM telemetry");
    expect(sql).toContain("received_at < ?1");
    expect(sql).toContain("LIMIT ?2");
    expect(args).toEqual([1_800_000_000 - 7 * 86_400, 250]);
    expect(calls).toBe(2);

    expect(await pruneExpiredTelemetry(db, 1_800_000_000, 0)).toEqual({
      deletedRows: 0,
      sizeAfterBytes: null,
      rowsRead: null,
      rowsWritten: null,
    });
    expect(calls).toBe(2);
    await expect(pruneExpiredTelemetry(db, 1_800_000_000, 7, 1001)).rejects.toThrow();
    expect(calls).toBe(2);
  });

  it("warns when D1 storage or pruning batch approaches capacity", async () => {
    const db = {
      prepare(statement: string) {
        if (statement.includes("history_rollup_watermarks")) {
          return { first: async () => ({ completedUntil: 1_800_000_000, resolutions: 2 }) };
        }
        return {
          bind() {
            return {
              run: async () => ({
                meta: {
                  changes: 250,
                  size_after: D1_STORAGE_WARNING_BYTES,
                  rows_read: 251,
                  rows_written: 500,
                },
              }),
            };
          },
        };
      },
    } as unknown as D1Database;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      const env = { DB: db, TELEMETRY_RETENTION_DAYS: "7" } as unknown as Env;
      expect(await runTelemetryRetention(env, 1_800_000_000_000)).toBe(250);
      expect(info).toHaveBeenCalledWith(
        "Telemetry retention",
        expect.objectContaining({ deletedRows: 250, sizeAfterBytes: D1_STORAGE_WARNING_BYTES }),
      );
      expect(warn).toHaveBeenCalledWith(
        "D1 storage approaching free-tier capacity",
        expect.objectContaining({ sizeAfterBytes: D1_STORAGE_WARNING_BYTES }),
      );
      expect(warn).toHaveBeenCalledWith(
        "Telemetry retention batch at capacity",
        expect.objectContaining({ batchSize: 250 }),
      );
    } finally {
      warn.mockRestore();
      info.mockRestore();
    }
  });
});
