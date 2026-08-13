PRAGMA foreign_keys = ON;

CREATE TABLE firmware_releases (
  id TEXT PRIMARY KEY,
  product TEXT NOT NULL,
  version TEXT NOT NULL,
  board_family TEXT NOT NULL,
  phase TEXT NOT NULL,
  object_key TEXT NOT NULL UNIQUE,
  size_bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ready', 'disabled')) DEFAULT 'ready',
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (product, version, board_family)
);
CREATE INDEX idx_firmware_releases_created ON firmware_releases(created_at DESC);

CREATE TABLE ota_campaigns (
  id TEXT PRIMARY KEY,
  release_id TEXT NOT NULL REFERENCES firmware_releases(id) ON DELETE RESTRICT,
  name TEXT NOT NULL,
  rollout_percentage INTEGER NOT NULL CHECK (rollout_percentage IN (0, 10, 50, 100)),
  pilot_device_id TEXT REFERENCES devices(id) ON DELETE SET NULL,
  status TEXT NOT NULL CHECK (status IN ('draft', 'active', 'paused', 'completed')),
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_ota_campaigns_status ON ota_campaigns(status, updated_at DESC);

CREATE TABLE ota_assignments (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES ota_campaigns(id) ON DELETE CASCADE,
  release_id TEXT NOT NULL REFERENCES firmware_releases(id) ON DELETE RESTRICT,
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  source_version TEXT NOT NULL,
  target_version TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN (
    'assigned', 'downloading', 'installing', 'rebooting', 'validating',
    'succeeded', 'failed', 'rolled_back'
  )),
  progress INTEGER NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  error_message TEXT,
  download_token_hash TEXT,
  download_token_expires_at INTEGER,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  assigned_at INTEGER NOT NULL,
  started_at INTEGER,
  completed_at INTEGER,
  updated_at INTEGER NOT NULL,
  UNIQUE (campaign_id, device_id)
);
CREATE INDEX idx_ota_assignments_device ON ota_assignments(device_id, updated_at DESC);
CREATE INDEX idx_ota_assignments_campaign ON ota_assignments(campaign_id, status);

CREATE TABLE ota_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  assignment_id TEXT NOT NULL REFERENCES ota_assignments(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  progress INTEGER NOT NULL,
  message TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_ota_events_assignment ON ota_events(assignment_id, created_at DESC);
