import { ApiError } from "./types";

export const PLAN_SECONDS_PER_DAY = 86_400;
export type PlanCode = "essential" | "plus" | "pro";

export interface PlanEntitlements {
  readonly plan: PlanCode;
  readonly maxControllers: number;
  readonly canUseRecipes: boolean;
  readonly canUseBatches: boolean;
  readonly canUseDensity: boolean;
  readonly maxRangeSeconds: number;
  readonly canUseFiveMinuteArchive: boolean;
  readonly canUseHourlyArchive: boolean;
}

// Pilot grants, not billing terms. Keep shipped entitlements in one place;
// remaining commercial features still require explicit API gates (#23).
export const PLAN_POLICY = Object.freeze({
  essential: Object.freeze({
    plan: "essential", maxControllers: 1, maxRangeSeconds: 7 * PLAN_SECONDS_PER_DAY,
    canUseFiveMinuteArchive: false, canUseHourlyArchive: false, canUseRecipes: false,
    canUseBatches: false, canUseDensity: false,
  }),
  plus: Object.freeze({
    plan: "plus", maxControllers: 2, maxRangeSeconds: 90 * PLAN_SECONDS_PER_DAY,
    canUseFiveMinuteArchive: true, canUseHourlyArchive: false, canUseRecipes: true,
    canUseBatches: false, canUseDensity: false,
  }),
  pro: Object.freeze({
    plan: "pro", maxControllers: 5, maxRangeSeconds: 365 * PLAN_SECONDS_PER_DAY,
    canUseFiveMinuteArchive: true, canUseHourlyArchive: true, canUseRecipes: true,
    canUseBatches: true, canUseDensity: true,
  }),
} satisfies Record<PlanCode, PlanEntitlements>);

export function planEntitlements(raw: unknown): PlanEntitlements {
  const plan = raw === "plus" || raw === "pro" ? raw : "essential";
  return { ...PLAN_POLICY[plan] };
}

export async function organizationPlanEntitlements(
  db: D1Database, organizationId: string,
): Promise<PlanEntitlements> {
  const row = await db.prepare(
    "SELECT plan_code AS planCode FROM organization_history_plans WHERE organization_id = ?1",
  ).bind(organizationId).first<{ planCode: string }>();
  return planEntitlements(row?.planCode);
}

// Resolve inside the claim UPDATE, never from a previously read session/plan.
// Values come only from the immutable server policy, not request input.
export const CONTROLLER_LIMIT_SQL = `CASE COALESCE(
  (SELECT plan_code FROM organization_history_plans WHERE organization_id = ?2),
  'essential')
  WHEN 'plus' THEN ${PLAN_POLICY.plus.maxControllers}
  WHEN 'pro' THEN ${PLAN_POLICY.pro.maxControllers}
  ELSE ${PLAN_POLICY.essential.maxControllers} END`;

// Call only after session, membership and existing write-role authorization.
// This guards new cloud recipe access, never device telemetry or in-flight work.
export async function requireOrganizationRecipes(db: D1Database, organizationId: string): Promise<void> {
  const entitlements = await organizationPlanEntitlements(db, organizationId);
  if (!entitlements.canUseRecipes) {
    throw new ApiError(403, "RECIPE_PLAN_REQUIRED", "Receitas na nuvem requerem o plano Plus ou Pro.");
  }
}

// Batch records contain gravity readings/metrics; both currently belong to Pro.
// Separate flags keep the product policy explicit without altering device control.
export async function requireOrganizationBatches(db: D1Database, organizationId: string): Promise<void> {
  if (!(await organizationPlanEntitlements(db, organizationId)).canUseBatches) {
    throw new ApiError(403, "BATCH_PLAN_REQUIRED", "Lotes requerem o plano Pro.");
  }
}

export async function requireOrganizationDensity(db: D1Database, organizationId: string): Promise<void> {
  if (!(await organizationPlanEntitlements(db, organizationId)).canUseDensity) {
    throw new ApiError(403, "DENSITY_PLAN_REQUIRED", "Densidade requer o plano Pro.");
  }
}
