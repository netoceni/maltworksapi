import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../src/index";
import { sha256Hex } from "../src/crypto";
// @ts-expect-error Portable JS test fixture.
import { makeLabTelemetry } from "../scripts/maltworks-lab-core.mjs";

const base = "https://api-staging.maltworks.com.br";
const now = 1_800_000_000;
const day = 86400;
let serial = 0;
beforeEach(() => { vi.spyOn(Date, "now").mockReturnValue(now * 1000); });
afterEach(() => { vi.restoreAllMocks(); });

async function account(plan?: "essential" | "plus" | "pro") {
  const id = "raw-history-" + ++serial;
  const session = id.padEnd(64, "s");
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO organizations (id, name, slug, created_at, updated_at)
      VALUES (?1, ?1, ?1, ?2, ?2)`).bind(id, now),
    env.DB.prepare(`INSERT INTO users (id, email, password_hash, password_salt,
      password_iterations, display_name, created_at, updated_at)
      VALUES (?1, ?2, 'test', 'test', 1, 'Raw history QA', ?3, ?3)`)
      .bind(id, id + "@example.test", now),
    env.DB.prepare(`INSERT INTO organization_members (organization_id, user_id, role, created_at)
      VALUES (?1, ?1, 'owner', ?2)`).bind(id, now),
    env.DB.prepare(`INSERT INTO sessions (token_hash, user_id, created_at, expires_at, last_seen_at)
      VALUES (?1, ?2, ?3, ?4, ?3)`).bind(await sha256Hex(session), id, now, now + 3600),
  ]);
  if (plan) await setPlan(id, plan);
  return { id, cookie: "mw_session=" + session };
}
async function setPlan(id: string, plan: "essential" | "plus" | "pro") {
  await env.DB.prepare(`INSERT INTO organization_history_plans (organization_id, plan_code, updated_at)
    VALUES (?1, ?2, ?3) ON CONFLICT(organization_id) DO UPDATE
    SET plan_code = excluded.plan_code, updated_at = excluded.updated_at`).bind(id, plan, now).run();
}

type Account = Awaited<ReturnType<typeof account>>;
async function fixture(plan?: "essential" | "plus" | "pro", days = 7) {
  const a = await account(plan);
  const id = "MW-" + (++serial).toString(16).toUpperCase().padStart(12, "0");
  const token = serial.toString(16).padStart(64, "a");
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO devices (id, organization_id, name, status, firmware_version,
      first_seen_at, last_seen_at, claimed_at, created_at, updated_at)
      VALUES (?1, ?2, 'Raw history QA', 'active', '5.19.0', ?3, ?3, ?3, ?3, ?3)`).bind(id, a.id, now),
    env.DB.prepare(`INSERT INTO device_credentials (device_id, token_hash, pairing_code_hash, created_at)
      VALUES (?1, ?2, ?3, ?4)`).bind(id, await sha256Hex(token), await sha256Hex(token.slice(-16)), now),
  ]);
  const insert = env.DB.prepare(`INSERT INTO telemetry (
         device_id, boot_id, sequence, received_at, sent_at, uptime_seconds,
         refrigerator_connected, refrigerator_value, refrigerator_raw, refrigerator_offset,
         thermal_well_connected, thermal_well_value, thermal_well_raw, thermal_well_offset,
         setpoint, hysteresis, control_state, cooling, heating, compressor_protection_seconds,
         profile_active, profile_paused, profile_name, profile_state, profile_stage,
         profile_stage_count, profile_remaining_seconds, alarms_active,
         alarms_unacknowledged, alarms_count, rssi, firmware_product,
         firmware_version, firmware_phase, payload_json
      ) VALUES (
        ?1, 'AA000011', ?2, ?3, ?3, 100,
        1, ?4, ?4, 0, 1, ?5, ?5, 0,
        18, 0.5, 'STABLE', 0, 0, 0,
        0, 0, '', 'IDLE', 0, 0, 0, 0,
        0, 0, -51, 'MaltworksController', '5.19.0', 'test', '{}'
      )`);
  // Exact lower boundary, one second too old, recent/mid-window, and future.
  const times = [now - days * day - 1, now - days * day, now - day, now - 10, now + 1];
  await env.DB.batch(times.map((at, i) => insert.bind(id, i + 1, at, 18 + i, 17 + i)));
  return { ...a, deviceId: id, token, times };
}
function history(a: Account & { deviceId: string }, query = "", cookie = a.cookie) {
  return exports.default.fetch(`${base}/v1/devices/${a.deviceId}/telemetry${query}`, {
    headers: { Cookie: cookie },
  });
}
interface History { points: Array<{ receivedAt: number }>; totalPoints?: number; from?: number; to?: number }
async function read(response: Response): Promise<History> {
  expect(response.status).toBe(200);
  return response.json() as Promise<History>;
}
async function count(id: string) {
  return (await env.DB.prepare("SELECT COUNT(*) AS n FROM telemetry WHERE device_id = ?1")
    .bind(id).first<{ n: number }>())!.n;
}

describe("raw history plan authorization (real HTTP + isolated D1)", () => {
  for (const [plan, days] of [[undefined, 7], ["essential", 7], ["plus", 90], ["pro", 365]] as const) {
    it(`${plan ?? "missing grant"}: enforces ${days} days across numeric, all, and paginated reads`, async () => {
      const a = await fixture(plan, days);
      const expected = [now - 10, now - day, now - days * day];
      const all = await read(await history(a, "?range=all&maxPoints=1000&plan=pro"));
      expect(all.points.map(p => p.receivedAt)).toEqual(expected);
      expect(all).toMatchObject({ totalPoints: 3, from: expected[2], to: expected[0] });
      const ranged = await read(await history(a, `?range=${days * day}&maxPoints=1000`));
      expect(ranged.points.map(p => p.receivedAt)).toEqual(expected);
      expect(ranged).toMatchObject({ totalPoints: 3, from: now - days * day, to: now });
      if (days < 365) {
        const denied = await history(a, `?range=${days * day + 1}&planCode=pro`);
        expect(denied.status).toBe(403);
        expect(await denied.json()).toMatchObject({ error: { code: "HISTORY_PLAN_REQUIRED" } });
      }
      expect((await read(await history(a))).points.map(p => p.receivedAt)).toEqual(expected);
      const first = await read(await history(a, "?limit=1"));
      expect(first.points.map(p => p.receivedAt)).toEqual(expected.slice(0, 1));
      const second = await read(await history(a, `?limit=1&before=${first.points[0]!.receivedAt}`));
      expect(second.points.map(p => p.receivedAt)).toEqual(expected.slice(1, 2));
      const third = await read(await history(a, `?before=${second.points[0]!.receivedAt}`));
      expect(third.points.map(p => p.receivedAt)).toEqual(expected.slice(2));
      for (const before of [now - days * day, now - 400 * day]) {
        expect((await read(await history(a, `?before=${before}&limit=500`))).points).toEqual([]);
      }
      expect((await read(await history(a, "?before=9007199254740991"))).points.map(p => p.receivedAt)).toEqual(expected);
      expect(await count(a.deviceId)).toBe(5); // Authorization never prunes rows.
    });
  }

  it("re-evaluates downgrades/revoked grants without deleting data or blocking telemetry/latest state", async () => {
    const a = await fixture("pro", 365);
    // Add an intermediate point that is available to Plus but not Essencial.
    await env.DB.prepare("UPDATE telemetry SET received_at = ?2 WHERE device_id = ?1 AND sequence = 2")
      .bind(a.deviceId, now - 30 * day).run();
    expect((await read(await history(a, "?range=all"))).totalPoints).toBe(3);
    await setPlan(a.id, "plus");
    expect((await history(a, `?range=${365 * day}`)).status).toBe(403);
    expect((await read(await history(a, "?range=all"))).totalPoints).toBe(3);
    await setPlan(a.id, "essential");
    expect((await read(await history(a, "?range=all"))).totalPoints).toBe(2);
    await env.DB.prepare("DELETE FROM organization_history_plans WHERE organization_id = ?1").bind(a.id).run();
    expect((await read(await history(a, `?before=${now - 7 * day}`))).points).toEqual([]);
    expect((await history(a, `?range=${90 * day}`)).status).toBe(403);
    expect(await count(a.deviceId)).toBe(5);
    const payload = makeLabTelemetry(0, 0, { startAt: now, sessionId: 127 });
    payload.deviceId = a.deviceId;
    const ingested = await exports.default.fetch(base + "/v1/telemetry", {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + a.token,
        "X-Maltworks-Device-ID": a.deviceId }, body: JSON.stringify(payload),
    });
    expect(ingested.status).toBe(200);
    expect(await count(a.deviceId)).toBe(6);
    expect((await read(await history(a, "?range=600"))).points[0]?.receivedAt).toBe(now);
    const latest = await exports.default.fetch(`${base}/v1/devices/${a.deviceId}/latest`, { headers: { Cookie: a.cookie } });
    expect(latest.status).toBe(200);
    expect(await latest.json()).toMatchObject({ state: { deviceId: a.deviceId, sequence: 1 } });
    await setPlan(a.id, "pro");
    expect((await read(await history(a, "?range=all"))).totalPoints).toBe(4);
  });

  it("keeps tenant authorization ahead of historical access and requires a session", async () => {
    const a = await fixture("essential"); const b = await account("pro");
    for (const query of ["", "?range=all", `?range=${365 * day}`, `?before=${now - 400 * day}`]) {
      expect((await history(a, query, b.cookie)).status).toBe(404);
      expect((await history(a, query, "")).status).toBe(401);
    }
    expect((await history(a, `?organizationId=${b.id}&range=all`)).status).toBe(403);
  });

  it("rejects invalid ranges and cursors without producing server errors", async () => {
    const a = await fixture("pro", 365);
    for (const range of ["", "NaN", "-1", "14", "15x", "Infinity", "1.5", String(366 * day)]) {
      expect((await history(a, "?range=" + range)).status).toBe(400);
    }
    for (const before of ["", "NaN", "-1", "123x", "Infinity", "1.5", "9007199254740992"]) {
      expect((await history(a, "?before=" + before)).status).toBe(400);
    }
    await env.DB.prepare("DELETE FROM telemetry WHERE device_id = ?1 AND received_at >= ?2")
      .bind(a.deviceId, now - 365 * day).run();
    expect(await read(await history(a, "?range=all"))).toMatchObject({ points: [], totalPoints: 0, from: null, to: now });
    expect((await read(await history(a))).points).toEqual([]);
  });
});
