import { describe, expect, it } from "vitest";
import { OFFLINE_AFTER_SECONDS } from "../src/notifications";
import { RETENTION_BATCH_SIZE } from "../src/retention";
import {
  TELEMETRY_PERSIST_INTERVAL_SECONDS,
  TELEMETRY_REALTIME_FAILOVER_INTERVAL_SECONDS,
} from "../src/telemetry-sampling";
import { D1_FREE_DAILY_WRITE_LIMIT } from "../src/d1-health";

const DAY = 86_400;
const FREE_WORKER_REQUESTS = 100_000;
const FREE_DO_REQUESTS = 100_000;
const FREE_DO_WRITTEN_ROWS = 100_000;
const DEVICES = 10;
const HTTP_SECONDS = 30;
const WS_HEARTBEAT_SECONDS = 30;

describe("10-controller Free pilot sizing", () => {
  it("fits Workers and Durable Objects with conservative operational headroom", () => {
    const httpRequests = DEVICES * DAY / HTTP_SECONDS;
    const wsHeartbeatMessages = DEVICES * DAY / WS_HEARTBEAT_SECONDS;
    const doRequests = httpRequests + wsHeartbeatMessages;
    expect(httpRequests).toBe(28_800);
    expect(doRequests).toBe(57_600);
    expect(httpRequests).toBeLessThan(FREE_WORKER_REQUESTS * 0.8);
    expect(doRequests).toBeLessThan(FREE_DO_REQUESTS * 0.8);

    // DO touchPresence coalesces messages within a 20-second interval.
    // 10 devices x 4,320 maximum coalesced presence writes (one per 20s)
    // including a factor of 1.5 for SQLite index/accounting overhead.
    const conservativeDoRows = DEVICES * DAY / 20 * 1.5;
    expect(conservativeDoRows).toBeLessThan(FREE_DO_WRITTEN_ROWS * 0.8);
  });

  it("fits the D1 row-write budget in stable operation with simulated events", () => {
    expect(TELEMETRY_PERSIST_INTERVAL_SECONDS).toBe(180);
    expect(TELEMETRY_REALTIME_FAILOVER_INTERVAL_SECONDS).toBe(180);
    expect(OFFLINE_AFTER_SECONDS).toBe(90);
    expect(OFFLINE_AFTER_SECONDS).toBeGreaterThanOrEqual(HTTP_SECONDS * 3);
    const rawPerDay = DEVICES * DAY / TELEMETRY_PERSIST_INTERVAL_SECONDS;
    const withEvents = Math.ceil(rawPerDay * 1.02);
    const fiveMinuteSummaries = DEVICES * DAY / 300;
    const hourlySummaries = DEVICES * DAY / 3600;
    const estimate = withEvents * 8 // observed 2026-10 D1 heuristic, NOT billing
      + withEvents * 2 // eventual deletion, pessimistic extra-index factor
      + (fiveMinuteSummaries + hourlySummaries) * 2;
    expect(rawPerDay).toBe(4_800);
    expect(estimate).toBeLessThan(D1_FREE_DAILY_WRITE_LIMIT * 0.8);
    expect(RETENTION_BATCH_SIZE * DAY / 600).toBeGreaterThan(withEvents);
  });
});
