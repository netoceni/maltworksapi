-- v5.19: plan-based access to historical queries.
-- No billing, renewal or automatic upgrade in this migration.
-- No row means Essential (fail closed); downgrades never delete archival data.
CREATE TABLE IF NOT EXISTS organization_history_plans (
  organization_id TEXT PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  plan_code TEXT NOT NULL CHECK(plan_code IN ('essential', 'plus', 'pro')),
  updated_at INTEGER NOT NULL,
  updated_by TEXT REFERENCES users(id) ON DELETE SET NULL
);
