-- Read-only checks. Use with Wrangler --command (not --file) to display results.
SELECT
  (SELECT COUNT(*) FROM telemetry WHERE device_id='MW-RET-DISPOSABLE-ONLY') AS raw_remaining,
  (SELECT COUNT(*) FROM telemetry WHERE device_id='MW-RET-DISPOSABLE-ONLY'
    AND sequence IN (1,2,3)) AS expired_remaining,
  (SELECT COUNT(*) FROM telemetry WHERE device_id='MW-RET-DISPOSABLE-ONLY'
    AND sequence IN (4,5,6)) AS preserved_recent,
  (SELECT COALESCE(SUM(samples),0) FROM history_5min
    WHERE device_id='MW-RET-DISPOSABLE-ONLY') AS archived_five_samples,
  (SELECT COALESCE(SUM(samples),0) FROM history_hourly
    WHERE device_id='MW-RET-DISPOSABLE-ONLY') AS archived_hour_samples,
  (SELECT COUNT(*) FROM history_rollup_watermarks
    WHERE resolution_seconds IN (300,3600)) AS checkpoints,
  (SELECT sequence FROM device_latest_state
    WHERE device_id='MW-RET-DISPOSABLE-ONLY') AS latest_sequence,
  (SELECT COUNT(*) FROM notifications
    WHERE id='alarm-disposable' AND category='alarm') AS alarm_events;
