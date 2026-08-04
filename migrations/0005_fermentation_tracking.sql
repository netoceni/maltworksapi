CREATE TABLE fermentation_sessions (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 2 AND 80),
  original_gravity REAL NOT NULL CHECK (original_gravity BETWEEN 0.990 AND 1.200),
  started_at INTEGER NOT NULL CHECK (started_at > 0),
  finished_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (finished_at IS NULL OR finished_at >= started_at)
);

CREATE INDEX idx_fermentation_sessions_device_started
  ON fermentation_sessions(device_id, started_at DESC);

CREATE INDEX idx_fermentation_sessions_organization_started
  ON fermentation_sessions(organization_id, started_at DESC);

CREATE UNIQUE INDEX idx_fermentation_sessions_one_active
  ON fermentation_sessions(device_id)
  WHERE finished_at IS NULL;

CREATE TABLE fermentation_readings (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES fermentation_sessions(id) ON DELETE CASCADE,
  created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  gravity REAL NOT NULL CHECK (gravity BETWEEN 0.990 AND 1.200),
  measured_at INTEGER NOT NULL CHECK (measured_at > 0),
  note TEXT NOT NULL DEFAULT '' CHECK (length(note) <= 120),
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_fermentation_readings_session_measured
  ON fermentation_readings(session_id, measured_at ASC, created_at ASC);
