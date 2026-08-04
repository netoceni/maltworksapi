CREATE TABLE cloud_recipes (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  name TEXT NOT NULL COLLATE NOCASE,
  description TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (organization_id, name)
);

CREATE INDEX idx_cloud_recipes_organization_name
  ON cloud_recipes(organization_id, name COLLATE NOCASE);

CREATE TABLE cloud_recipe_stages (
  recipe_id TEXT NOT NULL REFERENCES cloud_recipes(id) ON DELETE CASCADE,
  position INTEGER NOT NULL CHECK (position BETWEEN 0 AND 7),
  name TEXT NOT NULL,
  target_temperature REAL NOT NULL CHECK (target_temperature BETWEEN -10.0 AND 40.0),
  duration_seconds INTEGER NOT NULL CHECK (duration_seconds BETWEEN 60 AND 7776000),
  PRIMARY KEY (recipe_id, position)
);

DROP INDEX IF EXISTS idx_device_commands_device_status;
DROP INDEX IF EXISTS idx_device_commands_one_active;
DROP INDEX IF EXISTS idx_device_commands_organization_created;

ALTER TABLE device_commands RENAME TO device_commands_legacy;

CREATE TABLE device_commands (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  type TEXT NOT NULL CHECK (
    type IN ('set_setpoint', 'start_profile', 'pause_profile', 'resume_profile', 'stop_profile')
  ),
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'delivered', 'applied', 'rejected', 'expired')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  delivered_at INTEGER,
  completed_at INTEGER,
  result_json TEXT
);

INSERT INTO device_commands (
  id, device_id, organization_id, created_by_user_id, type, payload_json,
  status, created_at, expires_at, delivered_at, completed_at, result_json
)
SELECT
  id, device_id, organization_id, created_by_user_id, type, payload_json,
  status, created_at, expires_at, delivered_at, completed_at, result_json
FROM device_commands_legacy;

DROP TABLE device_commands_legacy;

CREATE INDEX idx_device_commands_device_status
  ON device_commands(device_id, status, created_at);

CREATE UNIQUE INDEX idx_device_commands_one_active
  ON device_commands(device_id)
  WHERE status IN ('pending', 'delivered');

CREATE INDEX idx_device_commands_organization_created
  ON device_commands(organization_id, created_at DESC);
