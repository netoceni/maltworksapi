import { ApiError } from "./types";

import {
  PLAN_SECONDS_PER_DAY, PLAN_POLICY, planEntitlements, organizationPlanEntitlements,
  type PlanCode, type PlanEntitlements,
} from "./plan-policy";

// Compatibility exports for existing history callers.
export const HISTORY_SECONDS_PER_DAY = PLAN_SECONDS_PER_DAY;
export type HistoryPlanCode = PlanCode;
export type HistoryPlanEntitlements = Omit<PlanEntitlements, "maxControllers">;
export const HISTORY_PLAN_POLICY = PLAN_POLICY;

export function historyEntitlements(raw: unknown): HistoryPlanEntitlements {
  const { maxControllers: _maxControllers, ...history } = planEntitlements(raw);
  return history;
}

export async function organizationHistoryEntitlements(
  db: D1Database, organizationId: string,
): Promise<HistoryPlanEntitlements> {
  const { maxControllers: _maxControllers, ...history } =
    await organizationPlanEntitlements(db, organizationId);
  return history;
}

export function requireHistoryPlanRange(
  entitlements: HistoryPlanEntitlements,
  rangeSeconds: number,
): void {
  if (!Number.isSafeInteger(rangeSeconds) || rangeSeconds < 0) {
    throw new ApiError(400, "INVALID_HISTORY_RANGE", "Periodo historico invalido.");
  }
  if (rangeSeconds <= entitlements.maxRangeSeconds) return;
  const needed = rangeSeconds > PLAN_POLICY.plus.maxRangeSeconds ? "Pro" : "Plus";
  throw new ApiError(
    403, "HISTORY_PLAN_REQUIRED",
    `Esse periodo historico requer o plano ${needed} ou superior.`,
  );
}
