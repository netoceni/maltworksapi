CREATE TABLE device_commands (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  type TEXT NOT NULL CHECK (type IN ('set_setpoint')),
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'delivered', 'applied', 'rejected', 'expired')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  delivered_at INTEGER,
  completed_at INTEGER,
  result_json TEXT
);

CREATE INDEX idx_device_commands_device_status
  ON device_commands(device_id, status, created_at);

CREATE UNIQUE INDEX idx_device_commands_one_active
  ON device_commands(device_id)
  WHERE status IN ('pending', 'delivered');

CREATE INDEX idx_device_commands_organization_created
  ON device_commands(organization_id, created_at DESC);
