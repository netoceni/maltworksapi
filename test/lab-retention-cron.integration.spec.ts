import { env } from "cloudflare:workers";
import { createExecutionContext, createScheduledController, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index";
import type { ScheduledJobGateVars } from "../src/retention";

const now = Math.floor(1_800_000_000 / 86_400) * 86_400;
const old = now - 8 * 86_400 + 60;
const deviceId = "MW-CAFE00000001";

async function total(table: string): Promise<number> {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS total FROM ${table}`).first<{ total: number }>();
  return row?.total ?? 0;
}

async function cron(flags: ScheduledJobGateVars): Promise<void> {
  const ctx = createExecutionContext();
  worker.scheduled(createScheduledController({ scheduledTime: now * 1000, cron: "*/5 * * * *" }), { ...env, ...flags }, ctx);
  await waitOnExecutionContext(ctx);
}

describe("Lab retention through the real scheduled handler and isolated D1", () => {
  it("archives first, keeps raw data by default, then prunes only after opt-in without running maintenance", async () => {
    await env.DB.prepare("INSERT INTO organizations(id,name,slug,created_at,updated_at) VALUES ('cron-test','Cron test','cron-test',?1,?1)").bind(old).run();
    // An active device old enough to trigger offline notifications if the
    // staging scheduler accidentally runs production maintenance.
    await env.DB.prepare(`INSERT INTO devices
      (id,organization_id,name,status,firmware_version,first_seen_at,last_seen_at,claimed_at,created_at,updated_at)
      VALUES (?1,'cron-test','Cron fixture','active','5.19.0',?2,?2,?2,?2,?2)`)
      .bind(deviceId, old).run();
    await env.DB.prepare(`INSERT INTO telemetry (
      device_id,boot_id,sequence,received_at,sent_at,uptime_seconds,
      refrigerator_connected,refrigerator_value,refrigerator_offset,
      thermal_well_connected,thermal_well_value,thermal_well_offset,
      setpoint,hysteresis,control_state,cooling,heating,compressor_protection_seconds,
      profile_active,profile_paused,profile_name,profile_state,profile_stage,
      profile_stage_count,profile_remaining_seconds,alarms_active,alarms_unacknowledged,
      alarms_count,rssi,firmware_product,firmware_version,firmware_phase,payload_json
    ) VALUES (?1,'CAFE0001',1,?2,?2,100,1,18,0,1,18,0,18,0.5,'STABLE',0,0,0,
      0,0,'','IDLE',0,0,0,0,0,0,-50,'MaltworksController','5.19.0','test','{}')`)
      .bind(deviceId, old).run();

    await cron({ LAB_STAGING_ROLLUP_ONLY: "true", LAB_STAGING_ENABLE_RETENTION: "false",
      TELEMETRY_RETENTION_DAYS: "0", HISTORY_5MIN_RETENTION_DAYS: "0", HISTORY_HOURLY_RETENTION_DAYS: "0" });
    expect(await total("telemetry")).toBe(1);
    expect(await total("history_5min")).toBe(1);
    expect(await total("history_hourly")).toBe(1);
    expect(await total("history_rollup_watermarks")).toBe(2);
    expect(await total("notifications")).toBe(0);
    expect(await total("notification_states")).toBe(0);
    expect(await total("d1_health_daily")).toBe(0);

    await cron({ LAB_STAGING_ROLLUP_ONLY: "true", LAB_STAGING_ENABLE_RETENTION: "true",
      TELEMETRY_RETENTION_DAYS: "7", HISTORY_5MIN_RETENTION_DAYS: "90", HISTORY_HOURLY_RETENTION_DAYS: "365" });
    expect(await total("telemetry")).toBe(0);
    for (const table of ["history_5min", "history_hourly"]) {
      expect(await total(table)).toBe(1);
      expect((await env.DB.prepare(`SELECT samples FROM ${table}`).first<{ samples: number }>())?.samples).toBe(1);
    }
    expect(await total("devices")).toBe(1);
    expect(await total("notifications")).toBe(0);
    expect(await total("notification_states")).toBe(0);
    expect(await total("d1_health_daily")).toBe(0);
  });
});
