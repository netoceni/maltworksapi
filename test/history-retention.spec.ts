import { describe, expect, it } from "vitest";
import {
  historyExpiryPolicy, shouldExpireHistory,
  HISTORY_5MIN_PRUNE_BATCH, HISTORY_HOURLY_PRUNE_BATCH,
  HISTORY_5MIN_RETENTION_DAYS, HISTORY_HOURLY_RETENTION_DAYS,
} from "../src/history-retention";

describe("Intelligent history expiration policy", () => {
  it("defaults to 90 days of five-minute data and 365 days of hourly data", () => {
    expect(historyExpiryPolicy(undefined, undefined)).toEqual({
      fiveMinuteDays: 90,
      hourlyDays: 365,
    });
    expect(HISTORY_5MIN_RETENTION_DAYS).toBe(90);
    expect(HISTORY_HOURLY_RETENTION_DAYS).toBe(365);
    expect(HISTORY_5MIN_PRUNE_BATCH).toBe(250);
    expect(HISTORY_HOURLY_PRUNE_BATCH).toBe(100);
  });

  it("allows disabling expiry explicitly, but no dangerously short TTL", () => {
    expect(historyExpiryPolicy("0", "0")).toEqual({
      fiveMinuteDays: 0, hourlyDays: 0,
    });
    expect(historyExpiryPolicy("180", "730")).toEqual({
      fiveMinuteDays: 180, hourlyDays: 730,
    });
    expect(historyExpiryPolicy("0", "365")).toEqual({
      fiveMinuteDays: 0, hourlyDays: 365,
    });
    for (const [fiveMinute, hourly] of [
      ["1", "365"], ["89", "365"], ["90", "364"],
      ["180", "180"], ["730", "365"], ["-1", "365"],
      ["NaN", "365"], ["90", "365.5"], ["90", "99999"],
    ]) {
      expect(() => historyExpiryPolicy(fiveMinute, hourly)).toThrow();
    }
  });

  it("runs only on the existing bounded 10-minute cron schedule", () => {
    expect(shouldExpireHistory(Date.UTC(2026, 9, 28, 12, 0))).toBe(true);
    expect(shouldExpireHistory(Date.UTC(2026, 9, 28, 12, 10))).toBe(true);
    expect(shouldExpireHistory(Date.UTC(2026, 9, 28, 12, 20))).toBe(true);
    expect(shouldExpireHistory(Date.UTC(2026, 9, 28, 12, 21))).toBe(false);
  });
});
