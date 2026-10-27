-- Daily snapshots of D1 health. Existing data and retention are unchanged.
CREATE TABLE IF NOT EXISTS d1_health_daily (
  day_utc TEXT PRIMARY KEY,
  sampled_at INTEGER NOT NULL,
  size_bytes INTEGER NOT NULL,
  telemetry_rows INTEGER NOT NULL,
  rows_last_24h INTEGER NOT NULL,
  expired_rows INTEGER NOT NULL,
  level TEXT NOT NULL CHECK (level IN ('normal', 'warning', 'critical'))
);
