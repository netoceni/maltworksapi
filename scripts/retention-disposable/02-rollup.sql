-- Disposable D1 only. SQL-level equivalent of both aggregation SELECTs.
-- For six fixture rows this covers all completed UTC windows in one pass.
-- Production TypeScript bounded/checkpoint logic is separately exercised by Vitest.
INSERT INTO history_5min (
 device_id,bucket_start,samples,refrigerator_count,refrigerator_sum,
 refrigerator_min,refrigerator_max,thermal_well_count,thermal_well_sum,
 thermal_well_min,thermal_well_max,setpoint_sum,setpoint_min,setpoint_max,
 cooling_samples,heating_samples,alarm_samples,rssi_sum,updated_at
)
SELECT device_id,CAST(received_at/300 AS INTEGER)*300,COUNT(*),
 COUNT(refrigerator_value),COALESCE(SUM(refrigerator_value),0),
 MIN(refrigerator_value),MAX(refrigerator_value),
 COUNT(thermal_well_value),COALESCE(SUM(thermal_well_value),0),
 MIN(thermal_well_value),MAX(thermal_well_value),
 SUM(setpoint),MIN(setpoint),MAX(setpoint),
 SUM(cooling),SUM(heating),SUM(alarms_active),SUM(rssi),
 (SELECT epoch_seconds FROM disposable_retention_clock WHERE label='start')
FROM telemetry
WHERE device_id='MW-RET-DISPOSABLE-ONLY' AND
 received_at < (
 SELECT CAST((epoch_seconds-300)/300 AS INTEGER)*300
 FROM disposable_retention_clock WHERE label='start'
 )
GROUP BY device_id,CAST(received_at/300 AS INTEGER)*300;

INSERT INTO history_hourly (
 device_id,bucket_start,samples,refrigerator_count,refrigerator_sum,
 refrigerator_min,refrigerator_max,thermal_well_count,thermal_well_sum,
 thermal_well_min,thermal_well_max,setpoint_sum,setpoint_min,setpoint_max,
 cooling_samples,heating_samples,alarm_samples,rssi_sum,updated_at
)
SELECT device_id,CAST(received_at/3600 AS INTEGER)*3600,COUNT(*),
 COUNT(refrigerator_value),COALESCE(SUM(refrigerator_value),0),
 MIN(refrigerator_value),MAX(refrigerator_value),
 COUNT(thermal_well_value),COALESCE(SUM(thermal_well_value),0),
 MIN(thermal_well_value),MAX(thermal_well_value),
 SUM(setpoint),MIN(setpoint),MAX(setpoint),
 SUM(cooling),SUM(heating),SUM(alarms_active),SUM(rssi),
 (SELECT epoch_seconds FROM disposable_retention_clock WHERE label='start')
FROM telemetry
WHERE device_id='MW-RET-DISPOSABLE-ONLY' AND
 received_at < (
 SELECT CAST((epoch_seconds-3600)/3600 AS INTEGER)*3600
 FROM disposable_retention_clock WHERE label='start'
 )
GROUP BY device_id,CAST(received_at/3600 AS INTEGER)*3600;

-- Checkpoints are inserted only when the corresponding archive sample count
-- equals the number of source samples inside its processed time window.
INSERT INTO history_rollup_watermarks(resolution_seconds,processed_until,updated_at)
SELECT 300,
 CAST((epoch_seconds-300)/300 AS INTEGER)*300,epoch_seconds
FROM disposable_retention_clock
WHERE label='start' AND (
 SELECT COALESCE(SUM(samples),0) FROM history_5min
 WHERE device_id='MW-RET-DISPOSABLE-ONLY'
) = (
 SELECT COUNT(*) FROM telemetry
 WHERE device_id='MW-RET-DISPOSABLE-ONLY' AND received_at <
 (SELECT CAST((epoch_seconds-300)/300 AS INTEGER)*300
  FROM disposable_retention_clock WHERE label='start')
);

INSERT INTO history_rollup_watermarks(resolution_seconds,processed_until,updated_at)
SELECT 3600,
 CAST((epoch_seconds-3600)/3600 AS INTEGER)*3600,epoch_seconds
FROM disposable_retention_clock
WHERE label='start' AND (
 SELECT COALESCE(SUM(samples),0) FROM history_hourly
 WHERE device_id='MW-RET-DISPOSABLE-ONLY'
) = (
 SELECT COUNT(*) FROM telemetry
 WHERE device_id='MW-RET-DISPOSABLE-ONLY' AND received_at <
 (SELECT CAST((epoch_seconds-3600)/3600 AS INTEGER)*3600
  FROM disposable_retention_clock WHERE label='start')
);
