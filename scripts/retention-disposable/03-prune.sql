-- Disposable D1 ONLY. Mirrors raw retention cutoff and 250-row batch.
-- Without both 300 and 3600 watermarks this deletes NOTHING.
-- This file must first run before rollup (expect 0 removed), and again
-- after 02-rollup.sql (expect 3 removed).
DELETE FROM telemetry WHERE id IN (
 SELECT id FROM telemetry
 WHERE device_id='MW-RET-DISPOSABLE-ONLY'
   AND received_at < (
     SELECT MIN(
       (SELECT epoch_seconds-7*86400 FROM disposable_retention_clock WHERE label='start'),
       CASE WHEN COUNT(*)=2 THEN MIN(processed_until) ELSE 0 END
     )
     FROM history_rollup_watermarks
     WHERE resolution_seconds IN (300,3600)
   )
 ORDER BY received_at ASC,id ASC
 LIMIT 250
);
