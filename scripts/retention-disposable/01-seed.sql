-- ONLY for a newly created, empty disposable D1. NEVER run against staging/production.
-- The fixed clock makes the seven-day boundary deterministic across commands.
CREATE TABLE disposable_retention_clock (
  label TEXT PRIMARY KEY,
  epoch_seconds INTEGER NOT NULL
);
INSERT INTO disposable_retention_clock(label,epoch_seconds)
VALUES ('start', CAST(strftime('%s','now') AS INTEGER));

INSERT INTO organizations(id,name,slug,created_at,updated_at)
SELECT 'org-retention-disposable', 'Disposable Retention Lab',
       'disposable-retention-lab', epoch_seconds,epoch_seconds
FROM disposable_retention_clock WHERE label='start';

INSERT INTO devices
(id,organization_id,name,status,firmware_version,
 first_seen_at,last_seen_at,claimed_at,created_at,updated_at)
SELECT 'MW-RET-DISPOSABLE-ONLY','org-retention-disposable',
       'Disposable Retention Fixture','active','5.19.0',
       epoch_seconds,epoch_seconds,epoch_seconds,epoch_seconds,epoch_seconds
FROM disposable_retention_clock WHERE label='start';

-- Two eight-day-old points, one older than seven days, one exactly at
-- seven days, one recent and one near-current point. The older 3 must be
-- deleted only after both archives are complete. The other 3 must survive.
WITH samples(seq,offset_s,fridge,well,setpt,cooling_flag,alarm_flag) AS (
 VALUES
 (1,-691800,18.0,18.5,18.0,0,0),
 (2,-691680,22.0,21.0,18.0,1,1),
 (3,-608400,NULL,20.0,19.0,0,0),
 (4,-604800,17.0,17.5,17.0,0,0),
 (5,-172800,16.0,16.5,16.0,0,0),
 (6,-60,18.0,18.0,18.0,0,0)
)
INSERT INTO telemetry (
  device_id,boot_id,sequence,received_at,sent_at,uptime_seconds,
  refrigerator_connected,refrigerator_value,refrigerator_raw,refrigerator_offset,
  thermal_well_connected,thermal_well_value,thermal_well_raw,thermal_well_offset,
  setpoint,hysteresis,control_state,cooling,heating,compressor_protection_seconds,
  profile_active,profile_paused,profile_name,profile_state,profile_stage,
  profile_stage_count,profile_remaining_seconds,alarms_active,
  alarms_unacknowledged,alarms_count,rssi,firmware_product,
  firmware_version,firmware_phase,payload_json
)
SELECT 'MW-RET-DISPOSABLE-ONLY','RETEN001',s.seq,
       c.epoch_seconds+s.offset_s,c.epoch_seconds+s.offset_s,100,
       1,s.fridge,s.fridge,0,
       1,s.well,s.well,0,
       s.setpt,0.5,'STABLE',s.cooling_flag,0,0,
       0,0,'','IDLE',0,
       0,0,s.alarm_flag,
       0,s.alarm_flag,-50,'MaltworksController',
       '5.19.0','disposable','{}'
FROM samples s CROSS JOIN disposable_retention_clock c
WHERE c.label='start';

INSERT INTO device_latest_state (
 device_id,received_at,sent_at,boot_id,sequence,
 refrigerator_value,thermal_well_value,setpoint,
 control_state,cooling,heating,alarms_active,rssi,
 firmware_version,state_json
)
SELECT 'MW-RET-DISPOSABLE-ONLY',epoch_seconds-60,epoch_seconds-60,
 'RETEN001',6,18.0,18.0,18.0,'STABLE',0,0,0,-50,'5.19.0','{}'
FROM disposable_retention_clock WHERE label='start';

INSERT INTO notifications (
 id,organization_id,device_id,event_key,category,type,severity,
 title,message,data_json,created_at
)
SELECT 'alarm-disposable','org-retention-disposable','MW-RET-DISPOSABLE-ONLY',
 'event-disposable','alarm','test_alarm','critical',
 'Disposable alarm','Must survive raw retention','{}',epoch_seconds-691680
FROM disposable_retention_clock WHERE label='start';
