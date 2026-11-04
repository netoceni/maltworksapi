-- Maltworks Intelligent History v5.19 (staging only until reviewed).
-- Append-only rollup tables; no mutation or deletion of existing telemetry.
-- All buckets use UTC-aligned Unix epoch seconds; summaries are recalculable.
CREATE TABLE IF NOT EXISTS history_5min (
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  bucket_start INTEGER NOT NULL,
  samples INTEGER NOT NULL CHECK (samples > 0),
  refrigerator_count INTEGER NOT NULL,
  refrigerator_sum REAL NOT NULL,
  refrigerator_min REAL,
  refrigerator_max REAL,
  thermal_well_count INTEGER NOT NULL,
  thermal_well_sum REAL NOT NULL,
  thermal_well_min REAL,
  thermal_well_max REAL,
  setpoint_sum REAL NOT NULL,
  setpoint_min REAL NOT NULL,
  setpoint_max REAL NOT NULL,
  cooling_samples INTEGER NOT NULL,
  heating_samples INTEGER NOT NULL,
  alarm_samples INTEGER NOT NULL,
  rssi_sum REAL NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (device_id, bucket_start)
);
CREATE INDEX IF NOT EXISTS idx_history_5min_bucket
  ON history_5min(bucket_start);

CREATE TABLE IF NOT EXISTS history_hourly (
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  bucket_start INTEGER NOT NULL,
  samples INTEGER NOT NULL CHECK (samples > 0),
  refrigerator_count INTEGER NOT NULL,
  refrigerator_sum REAL NOT NULL,
  refrigerator_min REAL,
  refrigerator_max REAL,
  thermal_well_count INTEGER NOT NULL,
  thermal_well_sum REAL NOT NULL,
  thermal_well_min REAL,
  thermal_well_max REAL,
  setpoint_sum REAL NOT NULL,
  setpoint_min REAL NOT NULL,
  setpoint_max REAL NOT NULL,
  cooling_samples INTEGER NOT NULL,
  heating_samples INTEGER NOT NULL,
  alarm_samples INTEGER NOT NULL,
  rssi_sum REAL NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (device_id, bucket_start)
);
CREATE INDEX IF NOT EXISTS idx_history_hourly_bucket
  ON history_hourly(bucket_start);

-- One progress record per resolution. Pruning may remove raw rows only
-- strictly before both completed watermarks (guarded by retention code).
CREATE TABLE IF NOT EXISTS history_rollup_watermarks (
  resolution_seconds INTEGER PRIMARY KEY CHECK (resolution_seconds IN (300, 3600)),
  processed_until INTEGER NOT NULL CHECK (processed_until >= 0),
  updated_at INTEGER NOT NULL
);
