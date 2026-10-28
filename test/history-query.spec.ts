import { describe, expect, it } from "vitest";
import { historyQueryOptions } from "../src/history-query";

const DAY = 86_400;

describe("Intelligent History query selection", () => {
  it("selects five-minute data up to 90 days and hourly over 90 days", () => {
    expect(historyQueryOptions(String(7 * DAY), null)).toMatchObject({
      sourceResolutionSeconds: 300, requestedMaxPoints: 720,
    });
    expect(historyQueryOptions(String(90 * DAY), "720")).toMatchObject({
      sourceResolutionSeconds: 300,
    });
    expect(historyQueryOptions(String(91 * DAY), "720")).toMatchObject({
      sourceResolutionSeconds: 3600,
    });
    expect(historyQueryOptions("all", "1000")).toMatchObject({
      rangeSeconds: 365 * DAY,
      sourceResolutionSeconds: 3600,
      requestedMaxPoints: 1000,
    });
  });
  it("limits points and emits integral output buckets", () => {
    const opts = historyQueryOptions(String(90 * DAY), "720");
    expect(opts.outputBucketSeconds % opts.sourceResolutionSeconds).toBe(0);
    expect(opts.outputBucketSeconds).toBeGreaterThanOrEqual(300);
    expect(opts.outputBucketSeconds * opts.requestedMaxPoints).toBeGreaterThanOrEqual(opts.rangeSeconds);
  });
  it("rejects unbounded or malformed requests", () => {
    for (const bad of ["-1", "0", "1", "nan", "4e3", String(366 * DAY)]) {
      expect(() => historyQueryOptions(bad, "720")).toThrow();
    }
    for (const bad of ["0", "1", "1001", "2.5", "NaN", ""]) {
      expect(() => historyQueryOptions(String(7 * DAY), bad)).toThrow();
    }
  });
});
