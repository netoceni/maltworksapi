-- Independent sensor samples: Controller heartbeats must not duplicate them.
CREATE TABLE densimeter_readings (
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  sensor_id INTEGER NOT NULL,
  session_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  history_index INTEGER NOT NULL,
  sampled_at INTEGER NOT NULL,
  received_at INTEGER NOT NULL,
  interval_seconds INTEGER NOT NULL,
  angle_mdeg INTEGER NOT NULL,
  temperature_mc INTEGER NOT NULL,
  battery_mv INTEGER NOT NULL,
  rssi INTEGER NOT NULL,
  gravity_sg REAL,
  calibration_revision INTEGER NOT NULL,
  PRIMARY KEY (device_id, sensor_id, session_id, sequence)
);
CREATE INDEX idx_densimeter_device_sensor_history
  ON densimeter_readings(device_id, sensor_id, history_index DESC);
