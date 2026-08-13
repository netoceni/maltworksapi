PRAGMA foreign_keys = ON;

-- As fermentacoes existentes passam a ser a base permanente dos lotes.
ALTER TABLE fermentation_sessions ADD COLUMN batch_code TEXT NOT NULL DEFAULT '';
ALTER TABLE fermentation_sessions ADD COLUMN recipe_id TEXT;
ALTER TABLE fermentation_sessions ADD COLUMN recipe_snapshot_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE fermentation_sessions ADD COLUMN equipment_name TEXT NOT NULL DEFAULT '';
ALTER TABLE fermentation_sessions ADD COLUMN planned_final_gravity REAL CHECK (planned_final_gravity IS NULL OR planned_final_gravity BETWEEN 0.990 AND 1.200);
ALTER TABLE fermentation_sessions ADD COLUMN planned_volume_liters REAL CHECK (planned_volume_liters IS NULL OR planned_volume_liters > 0);
ALTER TABLE fermentation_sessions ADD COLUMN final_gravity REAL CHECK (final_gravity IS NULL OR final_gravity BETWEEN 0.990 AND 1.200);
ALTER TABLE fermentation_sessions ADD COLUMN actual_volume_liters REAL CHECK (actual_volume_liters IS NULL OR actual_volume_liters > 0);
ALTER TABLE fermentation_sessions ADD COLUMN summary_notes TEXT NOT NULL DEFAULT '' CHECK (length(summary_notes) <= 4000);
ALTER TABLE fermentation_sessions ADD COLUMN sensory_score INTEGER CHECK (sensory_score IS NULL OR sensory_score BETWEEN 0 AND 100);
ALTER TABLE fermentation_sessions ADD COLUMN sensory_notes TEXT NOT NULL DEFAULT '' CHECK (length(sensory_notes) <= 4000);

CREATE INDEX idx_fermentation_sessions_recipe_started
  ON fermentation_sessions(organization_id, recipe_id, started_at DESC);

CREATE UNIQUE INDEX idx_fermentation_sessions_batch_code
  ON fermentation_sessions(organization_id, batch_code)
  WHERE batch_code <> '';

CREATE TABLE batch_ingredients (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES fermentation_sessions(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  category TEXT NOT NULL DEFAULT 'outro' CHECK (category IN ('malte', 'lupulo', 'levedura', 'adjunto', 'agua', 'embalagem', 'outro')),
  planned_quantity REAL NOT NULL CHECK (planned_quantity >= 0),
  actual_quantity REAL CHECK (actual_quantity IS NULL OR actual_quantity >= 0),
  unit TEXT NOT NULL CHECK (unit IN ('kg', 'g', 'l', 'ml', 'un')),
  planned_cost_cents INTEGER NOT NULL DEFAULT 0 CHECK (planned_cost_cents >= 0),
  actual_cost_cents INTEGER CHECK (actual_cost_cents IS NULL OR actual_cost_cents >= 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_batch_ingredients_session
  ON batch_ingredients(session_id, created_at ASC);

CREATE TABLE batch_journal (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES fermentation_sessions(id) ON DELETE CASCADE,
  created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  kind TEXT NOT NULL CHECK (kind IN ('observacao', 'ocorrencia')),
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
  details TEXT NOT NULL DEFAULT '' CHECK (length(details) <= 4000),
  occurred_at INTEGER NOT NULL CHECK (occurred_at > 0),
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_batch_journal_session_occurred
  ON batch_journal(session_id, occurred_at DESC, created_at DESC);

CREATE TABLE batch_attachments (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES fermentation_sessions(id) ON DELETE CASCADE,
  created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  object_key TEXT NOT NULL UNIQUE,
  file_name TEXT NOT NULL CHECK (length(file_name) BETWEEN 1 AND 180),
  content_type TEXT NOT NULL CHECK (length(content_type) BETWEEN 1 AND 100),
  size_bytes INTEGER NOT NULL CHECK (size_bytes BETWEEN 1 AND 10485760),
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_batch_attachments_session_created
  ON batch_attachments(session_id, created_at DESC);
