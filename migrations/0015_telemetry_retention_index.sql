-- The retention cron filters by received_at across all devices.
-- The existing (device_id, received_at DESC) index cannot efficiently
-- satisfy this predicate without a device_id filter.
CREATE INDEX IF NOT EXISTS idx_telemetry_received_at_id
  ON telemetry(received_at ASC, id ASC);
