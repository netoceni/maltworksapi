CREATE TABLE notifications (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  device_id TEXT REFERENCES devices(id) ON DELETE CASCADE,
  event_key TEXT NOT NULL UNIQUE,
  category TEXT NOT NULL CHECK (category IN ('device', 'sensor', 'alarm', 'profile', 'command')),
  type TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('info', 'success', 'warning', 'critical')),
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  data_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_notifications_organization_created
  ON notifications(organization_id, created_at DESC);
CREATE INDEX idx_notifications_device_created
  ON notifications(device_id, created_at DESC);

CREATE TABLE notification_reads (
  notification_id TEXT NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  read_at INTEGER NOT NULL,
  PRIMARY KEY (notification_id, user_id)
);
CREATE INDEX idx_notification_reads_user
  ON notification_reads(user_id, read_at DESC);

CREATE TABLE notification_preferences (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email_enabled INTEGER NOT NULL DEFAULT 0 CHECK (email_enabled IN (0, 1)),
  device_events INTEGER NOT NULL DEFAULT 1 CHECK (device_events IN (0, 1)),
  sensor_events INTEGER NOT NULL DEFAULT 1 CHECK (sensor_events IN (0, 1)),
  alarm_events INTEGER NOT NULL DEFAULT 1 CHECK (alarm_events IN (0, 1)),
  profile_events INTEGER NOT NULL DEFAULT 1 CHECK (profile_events IN (0, 1)),
  command_events INTEGER NOT NULL DEFAULT 1 CHECK (command_events IN (0, 1)),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, organization_id)
);

CREATE TABLE notification_states (
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 0 CHECK (active IN (0, 1)),
  changed_at INTEGER NOT NULL,
  last_event_key TEXT,
  PRIMARY KEY (device_id, type)
);

CREATE TABLE notification_deliveries (
  notification_id TEXT NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel TEXT NOT NULL CHECK (channel IN ('email')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'sent', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  provider_id TEXT,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (notification_id, user_id, channel)
);
CREATE INDEX idx_notification_deliveries_status
  ON notification_deliveries(status, updated_at);
