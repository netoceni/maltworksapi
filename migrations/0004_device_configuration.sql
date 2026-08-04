CREATE TABLE device_configurations (
  device_id TEXT PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK (version >= 1),
  status TEXT NOT NULL CHECK (status IN ('pending', 'applied', 'rejected')),
  hysteresis REAL NOT NULL CHECK (hysteresis BETWEEN 0.1 AND 5.0),
  compressor_protection_seconds INTEGER NOT NULL CHECK (compressor_protection_seconds BETWEEN 60 AND 900),
  refrigerator_offset REAL NOT NULL CHECK (refrigerator_offset BETWEEN -10.0 AND 10.0),
  thermal_well_offset REAL NOT NULL CHECK (thermal_well_offset BETWEEN -10.0 AND 10.0),
  sensor_alarm_enabled INTEGER NOT NULL CHECK (sensor_alarm_enabled IN (0, 1)),
  high_temperature_enabled INTEGER NOT NULL CHECK (high_temperature_enabled IN (0, 1)),
  low_temperature_enabled INTEGER NOT NULL CHECK (low_temperature_enabled IN (0, 1)),
  response_alarm_enabled INTEGER NOT NULL CHECK (response_alarm_enabled IN (0, 1)),
  high_temperature_limit REAL NOT NULL CHECK (high_temperature_limit BETWEEN -30.0 AND 60.0),
  low_temperature_limit REAL NOT NULL CHECK (low_temperature_limit BETWEEN -30.0 AND 60.0),
  minimum_expected_change REAL NOT NULL CHECK (minimum_expected_change BETWEEN 0.1 AND 10.0),
  response_timeout_seconds INTEGER NOT NULL CHECK (response_timeout_seconds BETWEEN 60 AND 86400),
  last_command_id TEXT NOT NULL,
  updated_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  updated_at INTEGER NOT NULL,
  applied_at INTEGER,
  CHECK (high_temperature_limit > low_temperature_limit)
);

CREATE INDEX idx_device_configurations_organization
  ON device_configurations(organization_id, updated_at DESC);

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
    type IN (
      'set_setpoint', 'start_profile', 'pause_profile', 'resume_profile',
      'stop_profile', 'set_configuration', 'acknowledge_alarms'
    )
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
