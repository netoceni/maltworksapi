import { describe, expect, it } from "vitest";
import {
  completeHistoryUntil,
  HISTORY_FIVE_MINUTES,
  HISTORY_HOUR,
  HISTORY_ROLLUP_MAX_SPAN_SECONDS,
  shouldRollupHistory,
} from "../src/history-rollup";

describe("Intelligent History — schedule and complete UTC buckets", () => {
  it("runs on five-minute cron boundaries only", () => {
    expect(shouldRollupHistory(Date.UTC(2026, 9, 28, 12, 5))).toBe(true);
    expect(shouldRollupHistory(Date.UTC(2026, 9, 28, 12, 10))).toBe(true);
    expect(shouldRollupHistory(Date.UTC(2026, 9, 28, 12, 14))).toBe(false);
    expect(shouldRollupHistory(Date.UTC(2026, 9, 28, 12, 59))).toBe(false);
  });
  it("only archives closed UTC buckets after a full-resolution safety lag", () => {
    const moment = Date.UTC(2026, 9, 28, 14, 27) / 1_000;
    expect(completeHistoryUntil(moment, HISTORY_FIVE_MINUTES)).toBe(
      Date.UTC(2026, 9, 28, 14, 20) / 1_000,
    );
    expect(completeHistoryUntil(moment, HISTORY_HOUR)).toBe(
      Date.UTC(2026, 9, 28, 13, 0) / 1_000,
    );
    expect(completeHistoryUntil(0, HISTORY_HOUR)).toBe(0);
    expect(HISTORY_ROLLUP_MAX_SPAN_SECONDS).toBe(43_200);
  });
});
