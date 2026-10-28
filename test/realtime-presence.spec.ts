import { describe, expect, it } from "vitest";
import {
  maySkipPresenceWrite,
  REALTIME_PRESENCE_MIN_WRITE_INTERVAL_SECONDS,
} from "../src/realtime-presence";

const base = { lastSeenAt: 1_800_000_000, deadlineAt: 1_800_000_090, online: 1 };

describe("Durable Object presence write coalescing", () => {
  it("skips overlapping HTTP and WS updates below twenty seconds", () => {
    expect(REALTIME_PRESENCE_MIN_WRITE_INTERVAL_SECONDS).toBe(20);
    expect(maySkipPresenceWrite(base, base.lastSeenAt)).toBe(true);
    expect(maySkipPresenceWrite(base, base.lastSeenAt + 10)).toBe(true);
    expect(maySkipPresenceWrite(base, base.lastSeenAt + 19)).toBe(true);
    expect(maySkipPresenceWrite(base, base.lastSeenAt + 20)).toBe(false);
    expect(maySkipPresenceWrite(base, base.lastSeenAt + 30)).toBe(false);
  });

  it("never skips recovery, expiration, missing state or out-of-order clock", () => {
    expect(maySkipPresenceWrite(null, base.lastSeenAt)).toBe(false);
    expect(maySkipPresenceWrite({ ...base, online: 0 }, base.lastSeenAt + 5)).toBe(false);
    expect(maySkipPresenceWrite({ ...base, deadlineAt: base.lastSeenAt }, base.lastSeenAt)).toBe(false);
    expect(maySkipPresenceWrite(base, base.lastSeenAt - 1)).toBe(false);
  });
});
