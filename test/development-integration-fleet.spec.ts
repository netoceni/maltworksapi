import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index";
import { runD1DailyHealth } from "../src/d1-health";
// @ts-expect-error Portable JS simulator fixture.
import { labDeviceId, makeLabTelemetry } from "../scripts/maltworks-lab-core.mjs";

const base = "https://api-staging.maltworks.com.br";
const origin = "https://admin-staging.maltworks.com.br";
// Local-only bindings. No remote requests: call the Worker entrypoint directly.
const staging = Object.assign({}, env, { APP_ORIGIN: "https://app-staging.maltworks.com.br",
  ADMIN_ORIGIN: origin, D1_BILLING_PLAN: "paid" });
async function request(path: string, method = "GET", body?: unknown, cookie = "", extra: Record<string, string> = {}) {
  const ctx = createExecutionContext();
  const r = await worker.fetch(new Request(base + path, { method,
    headers: { "Content-Type": "application/json", Origin: origin, Cookie: cookie, ...extra },
    body: body === undefined ? undefined : JSON.stringify(body) }), staging, ctx);
  await waitOnExecutionContext(ctx);
  return r;
}
const recipe = { name: "Integration recipe", stages: [{ name: "Primary", targetTemperature: 18, durationSeconds: 3600 }] };
function token(index: number) { return (index + 1).toString(16).padStart(64, "a"); }
function ingest(index: number, tick: number) {
  return request("/v1/telemetry", "POST", makeLabTelemetry(index, tick, { scenario: "alarm", sessionId: 133 }), "", {
    Authorization: "Bearer " + token(index), "X-Maltworks-Device-ID": labDeviceId(index),
  });
}
async function signup(index: number, plan: "essential" | "plus" | "pro", limit: number) {
  const r = await request("/v1/auth/signup", "POST", { displayName: "Integration QA " + index,
    email: `integration-${index}@example.test`, password: "development-integration-password-2026",
    birthDate: "1990-01-01", termsAccepted: true });
  expect(r.status).toBe(201);
  const sessionCookie = r.headers.get("Set-Cookie")!;
  expect(sessionCookie).toContain("HttpOnly"); expect(sessionCookie).toContain("Secure"); expect(sessionCookie).toContain("SameSite=Strict");
  const cookie = sessionCookie.split(";", 1)[0]!;
  const data = await r.json() as { organization: { id: string }; user: { id: string } };
  await env.DB.prepare("INSERT INTO organization_history_plans (organization_id, plan_code, updated_at) VALUES (?1, ?2, ?3)")
    .bind(data.organization.id, plan, Math.floor(Date.now() / 1000)).run();
  return { id: data.organization.id, userId: data.user.id, cookie, plan, limit, indices: [] as number[] };
}

describe("combined development release: ten simulated controllers across organizations", () => {
  it("integrates Lab, plan limits/gates, sampled telemetry, staging Admin API and Paid D1 health", async () => {
    const accounts = [await signup(0, "essential", 1), await signup(1, "plus", 2),
      await signup(2, "pro", 5), await signup(3, "plus", 2)];
    let index = 0;
    for (const a of accounts) {
      for (let i = 0; i < a.limit; i++) a.indices.push(index++);
    }
    expect(index).toBe(10);
    const pending = await Promise.all(Array.from({ length: 10 }, (_, i) => ingest(i, 0)));
    expect(pending.every(r => r.status === 202)).toBe(true);
    // All organizations claim concurrently through real session authentication.
    const claims = await Promise.all(accounts.flatMap(a => a.indices.map(i => request("/v1/devices/claim", "POST", {
      organizationId: a.id, name: "Simulated controller " + i,
      registrationToken: labDeviceId(i) + "-" + token(i).slice(-16),
    }, a.cookie))));
    expect(claims.every(r => r.status === 201)).toBe(true);
    for (const [n, a] of accounts.entries()) {
      const overflow = 10 + n; expect((await ingest(overflow, 0)).status).toBe(202);
      const rejected = await request("/v1/devices/claim", "POST", { organizationId: a.id, name: "Overflow",
        registrationToken: labDeviceId(overflow) + "-" + token(overflow).slice(-16), plan: "pro", maxControllers: 999 }, a.cookie);
      expect(rejected.status).toBe(403);
      expect(await rejected.json()).toMatchObject({ error: { code: "CONTROLLER_PLAN_LIMIT_REACHED" } });
    }
    for (const tick of [1, 5, 9]) {
      const responses = await Promise.all(Array.from({ length: 10 }, (_, i) => ingest(i, tick)));
      expect(responses.every(r => r.status === 200)).toBe(true);
    }
    const total = await env.DB.prepare("SELECT COUNT(*) AS n FROM devices WHERE organization_id IS NOT NULL").first<{ n: number }>();
    expect(total!.n).toBe(10);
    for (const a of accounts) {
      const list = await request("/v1/devices", "GET", undefined, a.cookie); expect(list.status).toBe(200);
      const rows = (await list.json() as { devices: Array<{ id: string }> }).devices;
      expect(rows.map(d => d.id).sort()).toEqual(a.indices.map(labDeviceId).sort());
      for (const i of a.indices) {
        const latest = await request(`/v1/devices/${labDeviceId(i)}/latest`, "GET", undefined, a.cookie);
        expect(latest.status).toBe(200);
        expect(await latest.json()).toMatchObject({ state: { sequence: 10, alarms: { active: false } } });
        const samples = await env.DB.prepare("SELECT COUNT(*) AS n, SUM(alarms_active) AS alarms FROM telemetry WHERE device_id = ?1")
          .bind(labDeviceId(i)).first<{ n: number; alarms: number }>();
        expect(samples!.n).toBeGreaterThanOrEqual(3); expect(samples!.alarms).toBeGreaterThan(0);
      }
      const id = labDeviceId(a.indices[0]!);
      expect((await request(`/v1/devices/${id}/telemetry?range=all`, "GET", undefined, a.cookie)).status).toBe(200);
      const created = await request("/v1/recipes", "POST", { organizationId: a.id, ...recipe }, a.cookie);
      expect(created.status).toBe(a.plan === "essential" ? 403 : 201);
      const batch = await request(`/v1/devices/${id}/fermentation`, "POST", { organizationId: a.id,
        name: "Simulated integration batch", originalGravity: 1.05 }, a.cookie);
      expect(batch.status).toBe(a.plan === "pro" ? 201 : 403);
      const reading = await request(`/v1/devices/${id}/fermentation/readings`, "POST", { organizationId: a.id, gravity: 1.02 }, a.cookie);
      expect(reading.status).toBe(a.plan === "pro" ? 201 : 403);
    }
    expect((await request(`/v1/devices/${labDeviceId(3)}/latest`, "GET", undefined, accounts[0]!.cookie)).status).toBe(404);
    const pro = accounts[2]!;
    await env.DB.prepare("UPDATE organization_history_plans SET plan_code = 'essential' WHERE organization_id = ?1").bind(pro.id).run();
    expect((await request("/v1/recipes", "GET", undefined, pro.cookie)).status).toBe(403);
    expect((await request("/v1/batches", "GET", undefined, pro.cookie)).status).toBe(403);
    for (const i of pro.indices) expect((await ingest(i, 10)).status).toBe(200);
    expect((await request("/v1/devices", "GET", undefined, pro.cookie)).status).toBe(200);

    // Source-equivalent Admin staging origins, not a browser/Access deployment test.
    const preflight = await request("/v1/admin/overview", "OPTIONS"); expect(preflight.status).toBe(204);
    expect(preflight.headers.get("Access-Control-Allow-Origin")).toBe(origin);
    const foreignOrigin = await request("/v1/admin/overview", "OPTIONS", undefined, "", { Origin: "https://admin.maltworks.com.br" });
    expect(foreignOrigin.status).toBe(403);
    expect((await request("/v1/admin/overview")).status).toBe(401);
    expect((await request("/v1/admin/overview", "GET", undefined, pro.cookie)).status).toBe(403);
    await env.DB.prepare("INSERT INTO system_admins (user_id, role, created_at) VALUES (?1, 'superadmin', ?2)")
      .bind(pro.userId, Math.floor(Date.now() / 1000)).run();
    const overview = await request("/v1/admin/overview", "GET", undefined, pro.cookie); expect(overview.status).toBe(200);
    expect(overview.headers.get("Access-Control-Allow-Origin")).toBe(origin);
    expect(overview.headers.get("Access-Control-Allow-Credentials")).toBe("true");
    expect(await overview.json()).toMatchObject({ overview: { organizations: 4, devices: 14, devicesOnline: 10, devicesPending: 4 } });
    const users = await request("/v1/admin/users", "GET", undefined, pro.cookie); expect(users.status).toBe(200);
    const userBody = await users.json() as { users: Array<{ deviceCount: number }> };
    expect(userBody.users.reduce((sum, u) => sum + u.deviceCount, 0)).toBe(10);
    expect(JSON.stringify(userBody)).not.toContain("@example.test");

    // PR #22 is exercised together with claims, telemetry and premium gates.
    const before = await env.DB.prepare("SELECT COUNT(*) AS n FROM telemetry").first();
    const report = await runD1DailyHealth(staging, Date.now());
    expect(report.billingPlan).toBe("paid"); expect(report.level).toBe("normal");
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM telemetry").first()).toEqual(before);
    expect(await env.DB.prepare("SELECT 1 FROM d1_health_daily WHERE day_utc = ?1").bind(report.dayUtc).first()).not.toBeNull();
  });
});
