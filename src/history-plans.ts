import { ApiError } from "./types";

export const HISTORY_SECONDS_PER_DAY = 86_400;
export type HistoryPlanCode = "essential" | "plus" | "pro";

export interface HistoryPlanEntitlements {
  plan: HistoryPlanCode;
  maxRangeSeconds: number;
  canUseFiveMinuteArchive: boolean;
  canUseHourlyArchive: boolean;
}

// Product proposal for pilot. The same D1 aggregates are retained for the
// longest supported plan; authorization controls access without deleting data
// when a customer changes tier. These values are not prices or billing terms.
export const HISTORY_PLAN_POLICY: Record<HistoryPlanCode, HistoryPlanEntitlements> = {
  essential: {
    plan: "essential",
    maxRangeSeconds: 7 * HISTORY_SECONDS_PER_DAY,
    canUseFiveMinuteArchive: false,
    canUseHourlyArchive: false,
  },
  plus: {
    plan: "plus",
    maxRangeSeconds: 90 * HISTORY_SECONDS_PER_DAY,
    canUseFiveMinuteArchive: true,
    canUseHourlyArchive: false,
  },
  pro: {
    plan: "pro",
    maxRangeSeconds: 365 * HISTORY_SECONDS_PER_DAY,
    canUseFiveMinuteArchive: true,
    canUseHourlyArchive: true,
  },
};

export function historyEntitlements(raw: unknown): HistoryPlanEntitlements {
  const plan = raw === "plus" || raw === "pro" ? raw : "essential";
  return { ...HISTORY_PLAN_POLICY[plan] };
}

export async function organizationHistoryEntitlements(
  db: D1Database, organizationId: string,
): Promise<HistoryPlanEntitlements> {
  const row = await db.prepare(
    "SELECT plan_code AS planCode FROM organization_history_plans WHERE organization_id = ?1",
  ).bind(organizationId).first<{ planCode: string }>();
  // Missing/unknown/invalid billing state never grants premium access.
  return historyEntitlements(row?.planCode);
}

export function requireHistoryPlanRange(
  entitlements: HistoryPlanEntitlements,
  rangeSeconds: number,
): void {
  if (!Number.isSafeInteger(rangeSeconds) || rangeSeconds < 0) {
    throw new ApiError(400, "INVALID_HISTORY_RANGE", "Periodo historico invalido.");
  }
  if (rangeSeconds <= entitlements.maxRangeSeconds) return;
  const needed = rangeSeconds > 90 * HISTORY_SECONDS_PER_DAY ? "Pro" : "Plus";
  throw new ApiError(
    403, "HISTORY_PLAN_REQUIRED",
    `Esse periodo historico requer o plano ${needed} ou superior.`,
  );
}
