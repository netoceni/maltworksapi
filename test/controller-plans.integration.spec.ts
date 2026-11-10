import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import "../src/index";
import { sha256Hex } from "../src/crypto";
import { authenticateDevice } from "../src/realtime";
import { organizationPlanEntitlements, planEntitlements } from "../src/plan-policy";
import { organizationHistoryEntitlements } from "../src/history-plans";
// @ts-expect-error Portable JavaScript fixture has no declarations.
import { makeLabTelemetry } from "../scripts/maltworks-lab-core.mjs";

const base = "https://api-staging.maltworks.com.br";
const now = Math.floor(Date.now() / 1000);
let serial = 0;

async function account(plan?: "essential" | "plus" | "pro") {
  const id = "quota-" + ++serial;
  const session = id.padEnd(64, "s");
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO organizations (id, name, slug, created_at, updated_at)
      VALUES (?1, ?1, ?1, ?2, ?2)`).bind(id, now),
    env.DB.prepare(`INSERT INTO users (id, email, password_hash, password_salt,
      password_iterations, display_name, created_at, updated_at)
      VALUES (?1, ?2, 'test', 'test', 1, 'Quota QA', ?3, ?3)`)
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
async function pending() {
  const id = "MW-" + (++serial).toString(16).padStart(12, "0").toUpperCase();
  const token = serial.toString(16).padStart(64, "a");
  const pairing = token.slice(-16);
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO devices (id, name, status, firmware_version,
      first_seen_at, last_seen_at, created_at, updated_at)
      VALUES (?1, 'Pending', 'pending', '5.19.0', ?2, ?2, ?2, ?2)`).bind(id, now),
    env.DB.prepare(`INSERT INTO device_credentials (device_id, token_hash, pairing_code_hash, created_at)
      VALUES (?1, ?2, ?3, ?4)`).bind(id, await sha256Hex(token), await sha256Hex(pairing), now),
  ]);
  return { id, token, pairing };
}
type Account = Awaited<ReturnType<typeof account>>;
type Device = Awaited<ReturnType<typeof pending>>;
function claim(a: Account, d: Device, extra: Record<string, unknown> = {}) {
  return exports.default.fetch(base + "/v1/devices/claim", {
    method: "POST", headers: { Cookie: a.cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ organizationId: a.id, name: "Quota controller",
      registrationToken: d.id + "-" + d.pairing, ...extra }),
  });
}
async function linked(id: string) {
  return (await env.DB.prepare("SELECT COUNT(*) AS n FROM devices WHERE organization_id = ?1")
    .bind(id).first<{ n: number }>())!.n;
}
async function audits(id: string) {
  return (await env.DB.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE organization_id = ?1 AND action = 'device.claimed'")
    .bind(id).first<{ n: number }>())!.n;
}
async function denied(response: Response) {
  expect(response.status).toBe(403);
  expect(await response.json()).toMatchObject({ error: { code: "CONTROLLER_PLAN_LIMIT_REACHED" } });
}

// All claims use the real HTTP router, auth, policy and SQL, never a mock DB.
describe("controller plan quotas (isolated real D1)", () => {
  for (const [plan, limit] of [["essential", 1], ["plus", 2], ["pro", 5]] as const) {
    it(`${plan}: admits ${limit}, rejects the next and ignores client entitlement overrides`, async () => {
      const a = await account(plan);
      for (let i = 0; i < limit; i++) expect((await claim(a, await pending())).status).toBe(201);
      const overflow = await pending();
      await denied(await claim(a, overflow, { plan: "pro", planCode: "pro", maxControllers: 999 }));
      expect(await linked(a.id)).toBe(limit);
      expect(await audits(a.id)).toBe(limit);
      expect(await env.DB.prepare("SELECT organization_id AS org, status FROM devices WHERE id = ?1")
        .bind(overflow.id).first()).toEqual({ org: null, status: "pending" });
      expect(await organizationPlanEntitlements(env.DB, a.id)).toMatchObject({ plan, maxControllers: limit });
    });

    it(`${plan}: simultaneous claims compete for the final slot atomically`, async () => {
      const a = await account(plan);
      for (let i = 0; i < limit - 1; i++) expect((await claim(a, await pending())).status).toBe(201);
      const devices = [];
      for (let i = 0; i < 8; i++) devices.push(await pending());
      const responses = await Promise.all(devices.map(d => claim(a, d)));
      expect(responses.filter(r => r.status === 201)).toHaveLength(1);
      for (const r of responses.filter(r => r.status !== 201)) await denied(r);
      expect(await linked(a.id)).toBe(limit);
      expect(await audits(a.id)).toBe(limit);
    });
  }

  it("defaults missing/invalid plans to Essential and shares the history policy", async () => {
    for (const raw of [undefined, null, "", "PRO", "invalid", { plan: "pro" }]) {
      expect(planEntitlements(raw)).toMatchObject({ plan: "essential", maxControllers: 1 });
    }
    const a = await account();
    expect((await claim(a, await pending())).status).toBe(201);
    await denied(await claim(a, await pending()));
    for (const [plan, days] of [["essential", 7], ["plus", 90], ["pro", 365]] as const) {
      await setPlan(a.id, plan);
      expect(await organizationHistoryEntitlements(env.DB, a.id)).toMatchObject({ plan, maxRangeSeconds: days * 86400 });
    }
    const query = await env.DB.prepare("EXPLAIN QUERY PLAN SELECT COUNT(*) FROM devices WHERE organization_id = ?1")
      .bind(a.id).all<{ detail: string }>();
    expect(query.results.some(row => row.detail.includes("idx_devices_organization"))).toBe(true);
  });

  it("isolates organizations, rejects bad credentials and prevents both registration formats bypassing quotas", async () => {
    const a = await account();
    const b = await account("pro");
    const d = await pending();
    expect((await claim(a, d, { organizationId: b.id })).status).toBe(403);
    expect((await claim(a, d, { registrationToken: d.id + "-" + "0".repeat(16) })).status).toBe(401);
    expect((await claim(a, d)).status).toBe(201);
    expect((await claim(b, d)).status).toBe(409);
    const extra = await pending();
    await denied(await claim(a, extra, { registrationToken: undefined, deviceId: extra.id, pairingCode: extra.pairing }));
    expect((await claim(b, extra, { registrationToken: undefined, deviceId: extra.id, pairingCode: extra.pairing })).status).toBe(201);
    expect(await linked(a.id)).toBe(1);
    expect(await linked(b.id)).toBe(1);
  });

  it("does not move one device between organizations under concurrent claims", async () => {
    const a = await account(); const b = await account(); const d = await pending();
    const responses = await Promise.all([claim(a, d), claim(b, d)]);
    expect(responses.map(r => r.status).sort()).toEqual([201, 409]);
    expect(await linked(a.id) + await linked(b.id)).toBe(1);
    expect(await audits(a.id) + await audits(b.id)).toBe(1);
  });

  it("downgrades preserve linked hardware, telemetry, authentication, retries and rebinds", async () => {
    const a = await account("pro"); const devices = [];
    for (let i = 0; i < 5; i++) {
      const d = await pending(); devices.push(d);
      expect((await claim(a, d)).status).toBe(201);
    }
    const first = devices[0]!;
    const credentials = await env.DB.prepare("SELECT token_hash FROM device_credentials WHERE device_id = ?1")
      .bind(first.id).first();
    for (const plan of ["plus", "essential"] as const) {
      await setPlan(a.id, plan);
      await denied(await claim(a, await pending()));
      expect((await claim(a, first)).status).toBe(200);
      expect(await linked(a.id)).toBe(5);
      expect(await audits(a.id)).toBe(5);
    }
    // Revoking a manual grant also defaults to Essential; no hardware is revoked.
    await env.DB.prepare("DELETE FROM organization_history_plans WHERE organization_id = ?1").bind(a.id).run();
    await denied(await claim(a, await pending()));
    for (const [i, d] of devices.entries()) {
      const headers = { Authorization: "Bearer " + d.token, "X-Maltworks-Device-ID": d.id };
      expect(await authenticateDevice(new Request(base, { headers }), env)).toEqual({ deviceId: d.id, organizationId: a.id });
      const payload = makeLabTelemetry(i, 0, { sessionId: 125 }); payload.deviceId = d.id;
      const response = await exports.default.fetch(base + "/v1/telemetry", {
        method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify(payload),
      });
      expect(response.status).toBe(200);
      expect(await env.DB.prepare("SELECT 1 FROM telemetry WHERE device_id = ?1").bind(d.id).first()).not.toBeNull();
    }
    const listing = await exports.default.fetch(base + "/v1/devices", { headers: { Cookie: a.cookie } });
    expect(listing.status).toBe(200);
    expect((await listing.json() as { devices: unknown[] }).devices).toHaveLength(5);
    const latest = await exports.default.fetch(base + "/v1/devices/" + first.id + "/latest", { headers: { Cookie: a.cookie } });
    expect(latest.status).toBe(200);
    expect(await env.DB.prepare("SELECT token_hash FROM device_credentials WHERE device_id = ?1")
      .bind(first.id).first()).toEqual(credentials);
    expect((await claim(a, first, { registrationToken: first.id + "-" + "f".repeat(16) })).status).toBe(202);
    expect(await linked(a.id)).toBe(5);
  });

  it("counts disabled devices, frees a deleted slot and respects an upgrade", async () => {
    const a = await account(); const d = await pending();
    expect((await claim(a, d)).status).toBe(201);
    await env.DB.prepare("UPDATE devices SET status = 'disabled' WHERE id = ?1").bind(d.id).run();
    await denied(await claim(a, await pending()));
    await setPlan(a.id, "plus");
    const second = await pending();
    expect((await claim(a, second)).status).toBe(201);
    await denied(await claim(a, await pending()));
    const removed = await exports.default.fetch(base + "/v1/devices/" + d.id, {
      method: "DELETE", headers: { Cookie: a.cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ organizationId: a.id, confirmDeviceId: d.id }),
    });
    expect(removed.status).toBe(200);
    expect((await claim(a, await pending())).status).toBe(201);
    expect(await linked(a.id)).toBe(2);
  });

  it("rolls back the assignment if its audit cannot be saved", async () => {
    const a = await account(); const d = await pending();
    await env.DB.prepare(`CREATE TRIGGER quota_audit_failure BEFORE INSERT ON audit_log
      WHEN NEW.action = 'device.claimed' BEGIN SELECT RAISE(ABORT, 'test audit failure'); END`).run();
    try {
      expect((await claim(a, d)).status).toBe(500);
      expect(await linked(a.id)).toBe(0);
      expect(await audits(a.id)).toBe(0);
    } finally {
      await env.DB.prepare("DROP TRIGGER quota_audit_failure").run();
    }
    expect((await claim(a, d)).status).toBe(201);
  });

  it("a plan change racing claims cannot leave later requests using the old tier", async () => {
    const a = await account("pro");
    expect((await claim(a, await pending())).status).toBe(201);
    const devices = [];
    for (let i = 0; i < 8; i++) devices.push(await pending());
    const [, ...responses] = await Promise.all([setPlan(a.id, "essential"), ...devices.map(d => claim(a, d))]);
    // Requests serialized before the downgrade may succeed, up to the old cap.
    expect(await linked(a.id)).toBeLessThanOrEqual(5);
    expect(responses.every(r => r.status === 201 || r.status === 403)).toBe(true);
    await denied(await claim(a, await pending()));
    expect(await organizationPlanEntitlements(env.DB, a.id)).toMatchObject({ plan: "essential" });
    expect(await audits(a.id)).toBe(await linked(a.id));
  });
});
