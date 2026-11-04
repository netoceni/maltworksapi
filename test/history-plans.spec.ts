import { describe, expect, it } from "vitest";
import { historyEntitlements, requireHistoryPlanRange } from "../src/history-plans";

const DAY = 86_400;

describe("History plan access policy", () => {
  it("fails closed to Essential on missing or invalid plan", () => {
    for (const value of [undefined, null, "", "invalid", "PRO", "admin"]) {
      expect(historyEntitlements(value)).toMatchObject({
        plan: "essential", maxRangeSeconds: 7 * DAY,
        canUseFiveMinuteArchive: false,
      });
    }
  });

  it("maps Essential / Plus / Pro to 7 / 90 / 365 days", () => {
    const essential = historyEntitlements("essential");
    const plus = historyEntitlements("plus");
    const pro = historyEntitlements("pro");
    expect([essential.maxRangeSeconds, plus.maxRangeSeconds, pro.maxRangeSeconds])
      .toEqual([7, 90, 365].map((days) => days * DAY));
    expect(plus.canUseFiveMinuteArchive).toBe(true);
    expect(plus.canUseHourlyArchive).toBe(false);
    expect(pro.canUseHourlyArchive).toBe(true);
    expect(() => requireHistoryPlanRange(essential, 8 * DAY)).toThrow();
    expect(() => requireHistoryPlanRange(plus, 91 * DAY)).toThrow();
    expect(() => requireHistoryPlanRange(pro, 365 * DAY)).not.toThrow();
  });
});
