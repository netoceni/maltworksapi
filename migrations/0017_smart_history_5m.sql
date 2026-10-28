-- Smart History v1. Additive only: no deletion or change to raw retention.
-- One row per controller and 5-minute UTC bucket. Idempotent upserts.
CREATE TABLE IF NOT EXISTS telemetry_5m (
 device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
 bucket_start INTEGER NOT NULL,
 first_received_at INTEGER NOT NULL,
 last_received_at INTEGER NOT NULL,
 sample_count INTEGER NOT NULL CHECK(sample_count > 0),
 refrigerator_count INTEGER NOT NULL CHECK(refrigerator_count >= 0),
 refrigerator_avg REAL,
 refrigerator_min REAL,
 refrigerator_max REAL,
 thermal_well_count INTEGER NOT NULL CHECK(thermal_well_count >= 0),
 thermal_well_avg REAL,
 thermal_well_min REAL,
 thermal_well_max REAL,
 setpoint_avg REAL NOT NULL,
 setpoint_min REAL NOT NULL,
 setpoint_max REAL NOT NULL,
 cooling_samples INTEGER NOT NULL,
 heating_samples INTEGER NOT NULL,
 alarm_samples INTEGER NOT NULL,
 updated_at INTEGER NOT NULL,
 PRIMARY KEY(device_id, bucket_start)
);
CREATE INDEX IF NOT EXISTS idx_telemetry_5m_bucket ON telemetry_5m(bucket_start);

-- Checkpoint is a completed bucket (exclusive cursor). The backfill walks
-- sequentially; a bucket is considered covered only after a successful write.
CREATE TABLE IF NOT EXISTS telemetry_rollup_cursors (
 device_id TEXT PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
 next_bucket_start INTEGER NOT NULL,
 updated_at INTEGER NOT NULL
);
