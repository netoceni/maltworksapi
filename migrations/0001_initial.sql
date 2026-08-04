PRAGMA foreign_keys = ON;

CREATE TABLE organizations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  password_iterations INTEGER NOT NULL,
  display_name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_login_at INTEGER
);

CREATE TABLE organization_members (
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member', 'viewer')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (organization_id, user_id)
);
CREATE INDEX idx_organization_members_user ON organization_members(user_id);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);
CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_sessions_expiry ON sessions(expires_at);

CREATE TABLE devices (
  id TEXT PRIMARY KEY,
  organization_id TEXT REFERENCES organizations(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'active', 'disabled')),
  firmware_version TEXT NOT NULL,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  claimed_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_devices_organization ON devices(organization_id);
CREATE INDEX idx_devices_last_seen ON devices(last_seen_at);

CREATE TABLE device_credentials (
  device_id TEXT PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  pairing_code_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  rotated_at INTEGER
);

CREATE TABLE telemetry (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  boot_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  received_at INTEGER NOT NULL,
  sent_at INTEGER NOT NULL,
  uptime_seconds INTEGER NOT NULL,
  refrigerator_connected INTEGER NOT NULL,
  refrigerator_value REAL,
  refrigerator_raw REAL,
  refrigerator_offset REAL NOT NULL,
  thermal_well_connected INTEGER NOT NULL,
  thermal_well_value REAL,
  thermal_well_raw REAL,
  thermal_well_offset REAL NOT NULL,
  setpoint REAL NOT NULL,
  hysteresis REAL NOT NULL,
  control_state TEXT NOT NULL,
  cooling INTEGER NOT NULL,
  heating INTEGER NOT NULL,
  compressor_protection_seconds INTEGER NOT NULL,
  profile_active INTEGER NOT NULL,
  profile_paused INTEGER NOT NULL,
  profile_name TEXT NOT NULL,
  profile_state TEXT NOT NULL,
  profile_stage INTEGER NOT NULL,
  profile_stage_count INTEGER NOT NULL,
  profile_remaining_seconds INTEGER NOT NULL,
  alarms_active INTEGER NOT NULL,
  alarms_unacknowledged INTEGER NOT NULL,
  alarms_count INTEGER NOT NULL,
  rssi INTEGER NOT NULL,
  firmware_product TEXT NOT NULL,
  firmware_version TEXT NOT NULL,
  firmware_phase TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  UNIQUE (device_id, boot_id, sequence)
);
CREATE INDEX idx_telemetry_device_received ON telemetry(device_id, received_at DESC);

CREATE TABLE device_latest_state (
  device_id TEXT PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
  received_at INTEGER NOT NULL,
  sent_at INTEGER NOT NULL,
  boot_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  refrigerator_value REAL,
  thermal_well_value REAL,
  setpoint REAL NOT NULL,
  control_state TEXT NOT NULL,
  cooling INTEGER NOT NULL,
  heating INTEGER NOT NULL,
  alarms_active INTEGER NOT NULL,
  rssi INTEGER NOT NULL,
  firmware_version TEXT NOT NULL,
  state_json TEXT NOT NULL
);

CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  device_id TEXT REFERENCES devices(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  details_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_audit_organization_created ON audit_log(organization_id, created_at DESC);
