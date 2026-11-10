import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import "../src/index";
import { sha256Hex } from "../src/crypto";
import { planEntitlements } from "../src/plan-policy";
// @ts-expect-error Portable simulator fixture has no declarations.
import { makeLabTelemetry } from "../scripts/maltworks-lab-core.mjs";

const base = "https://api-staging.maltworks.com.br";
const now = Math.floor(Date.now() / 1000);
let serial = 0;
async function account(plan?: "essential" | "plus" | "pro") {
  const id = "recipe-plan-" + ++serial;
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
const input = { name: "Recipe QA", description: "Simulated recipe",
  stages: [{ name: "Stage QA", targetTemperature: 18, durationSeconds: 3600 }] };
const missing = "rcp_" + "0".repeat(32);
function call(a: Account, path: string, method = "GET", body?: Record<string, unknown>) {
  return exports.default.fetch(base + path, { method,
    headers: { Cookie: a.cookie, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify({ organizationId: a.id, ...body }),
  });
}
async function created(a: Account) {
  const response = await call(a, "/v1/recipes", "POST", input);
  expect(response.status).toBe(201);
  return (await response.json() as { recipe: { id: string } }).recipe.id;
}
async function denied(response: Response, code = "RECIPE_PLAN_REQUIRED") {
  expect(response.status).toBe(403);
  expect(await response.json()).toMatchObject({ error: { code } });
}
async function device(a: Account) {
  const id = "MW-" + (++serial).toString(16).toUpperCase().padStart(12, "0");
  const token = serial.toString(16).padStart(64, "a");
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO devices (id, organization_id, name, status, firmware_version,
      first_seen_at, last_seen_at, claimed_at, created_at, updated_at)
      VALUES (?1, ?2, 'Simulated recipe controller', 'active', '5.19.0', ?3, ?3, ?3, ?3, ?3)`)
      .bind(id, a.id, Math.floor(Date.now() / 1000)),
    env.DB.prepare(`INSERT INTO device_credentials (device_id, token_hash, pairing_code_hash, created_at)
      VALUES (?1, ?2, ?3, ?4)`).bind(id, await sha256Hex(token), await sha256Hex(token.slice(-16)), now),
  ]);
  return { id, token, tick: 0 };
}
type Device = Awaited<ReturnType<typeof device>>;
async function ingest(d: Device, active = false, paused = false, commandId?: string) {
  const payload = makeLabTelemetry(0, d.tick++, { sessionId: 129, startAt: now });
  payload.deviceId = d.id;
  payload.profile = { active, paused, name: active ? "Recipe QA" : "", state: paused ? "PAUSED" : active ? "RUNNING" : "IDLE",
    stage: 0, stageCount: active ? 1 : 0, remainingSeconds: active ? 3500 : 0 };
  if (commandId) payload.commandResult = { id: commandId, status: "applied", appliedSetpoint: 18, message: "Simulated confirmation" };
  const r = await exports.default.fetch(base + "/v1/telemetry", { method: "POST",
    headers: { Authorization: "Bearer " + d.token, "X-Maltworks-Device-ID": d.id, "Content-Type": "application/json" },
    body: JSON.stringify(payload) });
  expect(r.status).toBe(200);
  return r;
}
async function state(a: Account) {
  return env.DB.prepare(`SELECT
    (SELECT COUNT(*) FROM cloud_recipes WHERE organization_id = ?1) AS recipes,
    (SELECT COUNT(*) FROM cloud_recipe_stages s JOIN cloud_recipes r ON s.recipe_id = r.id WHERE r.organization_id = ?1) AS stages,
    (SELECT COUNT(*) FROM audit_log WHERE organization_id = ?1) AS audits,
    (SELECT COUNT(*) FROM device_commands WHERE organization_id = ?1) AS commands,
    (SELECT COUNT(*) FROM fermentation_sessions WHERE organization_id = ?1) AS batches`).bind(a.id).first();
}

describe("cloud recipe plan gates (simulated devices, real isolated HTTP/D1)", () => {
  for (const plan of [undefined, "essential"] as const) {
    it(`${plan ?? "missing grant"}: rejects library CRUD, profile start and new batch recipe association`, async () => {
      const a = await account(plan); const d = await device(a);
      const before = await state(a);
      await denied(await call(a, "/v1/recipes?plan=pro&canUseRecipes=true"));
      await denied(await call(a, "/v1/recipes", "POST", { ...input, planCode: "pro", canUseRecipes: true }));
      await denied(await call(a, "/v1/recipes/" + missing, "PUT", input));
      await denied(await call(a, "/v1/recipes/" + missing, "DELETE"));
      await denied(await call(a, `/v1/devices/${d.id}/commands/profile`, "POST", { action: "start", recipeId: missing, plan: "pro" }));
      await denied(await call(a, `/v1/devices/${d.id}/fermentation`, "POST", { name: "Batch QA", originalGravity: 1.05, recipeId: missing }), "BATCH_PLAN_REQUIRED");
      expect(await state(a)).toEqual(before);
      // Basic device controls and telemetry do not require a recipe entitlement.
      expect((await call(a, `/v1/devices/${d.id}/commands/setpoint`, "POST", { setpoint: 18 })).status).toBe(202);
      await ingest(d);
    });
  }
  for (const plan of ["plus", "pro"] as const) {
    it(`${plan}: permits library CRUD, starting a recipe and associating a new batch`, async () => {
      const a = await account(plan); const d = await device(a); const id = await created(a);
      const listed = await call(a, "/v1/recipes"); expect(listed.status).toBe(200);
      expect(await listed.json()).toMatchObject({ recipes: [{ id, stages: [{ targetTemperature: 18 }] }] });
      const updated = await call(a, "/v1/recipes/" + id, "PUT", { ...input, name: "Updated QA" });
      expect(updated.status).toBe(200);
      expect(await updated.json()).toMatchObject({ recipe: { id, version: 2, name: "Updated QA" } });
      expect((await call(a, `/v1/devices/${d.id}/commands/profile`, "POST", { action: "start", recipeId: id })).status).toBe(202);
      const associated = await call(a, `/v1/devices/${d.id}/fermentation`, "POST", { name: "Batch QA", originalGravity: 1.05, recipeId: id });
      if (plan === "pro") expect(associated.status).toBe(201);
      else await denied(associated, "BATCH_PLAN_REQUIRED");
      expect((await call(a, "/v1/recipes/" + id, "DELETE")).status).toBe(200);
      expect(await env.DB.prepare("SELECT 1 FROM cloud_recipe_stages WHERE recipe_id = ?1").bind(id).first()).toBeNull();
    });
  }
  it("retains viewer and tenant restrictions even with premium access, including explicit org selection", async () => {
    const a = await account("plus"); const b = await account("pro"); const id = await created(b); const d = await device(b); const own = await device(a);
    expect((await call(a, "/v1/recipes/" + id, "PUT", input)).status).toBe(404);
    expect((await call(a, "/v1/recipes/" + id, "DELETE")).status).toBe(404);
    await denied(await call(a, "/v1/recipes?organizationId=" + b.id), "ORGANIZATION_ACCESS_DENIED");
    expect((await call(a, `/v1/devices/${d.id}/commands/profile`, "POST", { action: "start", recipeId: id })).status).toBe(404);
    expect((await call(a, `/v1/devices/${own.id}/commands/profile`, "POST", { action: "start", recipeId: id })).status).toBe(404);
    await setPlan(a.id, "pro");
    expect((await call(a, `/v1/devices/${own.id}/fermentation`, "POST", { name: "Foreign recipe QA", originalGravity: 1.05, recipeId: id })).status).toBe(404);
    await env.DB.prepare("UPDATE organization_members SET role = 'viewer' WHERE organization_id = ?1").bind(b.id).run();
    expect((await call(b, "/v1/recipes")).status).toBe(200);
    for (const [path, method, body] of [["/v1/recipes", "POST", input], ["/v1/recipes/" + id, "PUT", input], ["/v1/recipes/" + id, "DELETE", undefined]] as const) {
      await denied(await call(b, path, method, body), "RECIPE_WRITE_DENIED");
    }
    await denied(await call(b, `/v1/devices/${d.id}/commands/profile`, "POST", { action: "start", recipeId: id }), "DEVICE_CONTROL_DENIED");
    const response = await exports.default.fetch(base + "/v1/recipes"); expect(response.status).toBe(401);
    // Same authenticated user, two different organization tiers.
    await setPlan(a.id, "essential");
    await env.DB.prepare("INSERT INTO organization_members (organization_id, user_id, role, created_at) VALUES (?1, ?2, 'viewer', ?3)")
      .bind(b.id, a.id, now + 1).run();
    await denied(await call(a, "/v1/recipes"));
    expect((await call(a, "/v1/recipes?organizationId=" + b.id)).status).toBe(200);
  });
  it("downgrade preserves recipes, in-flight profile delivery/ack and pause/resume/stop on a simulated device", async () => {
    const a = await account("plus"); const d = await device(a); const id = await created(a);
    const start = await call(a, `/v1/devices/${d.id}/commands/profile`, "POST", { action: "start", recipeId: id });
    expect(start.status).toBe(202);
    const startId = (await start.json() as { command: { id: string } }).command.id;
    await setPlan(a.id, "essential");
    const before = await state(a);
    await denied(await call(a, "/v1/recipes"));
    await denied(await call(a, "/v1/recipes/" + id, "PUT", { ...input, name: "Blocked edit" }));
    await denied(await call(a, "/v1/recipes/" + id, "DELETE"));
    await denied(await call(a, `/v1/devices/${d.id}/commands/profile`, "POST", { action: "start", recipeId: id }));
    expect(await state(a)).toEqual(before);
    expect(await (await ingest(d)).json()).toMatchObject({ command: { id: startId, type: "start_profile" } });
    await ingest(d, true, false, startId);
    for (const [action, active, paused] of [["pause", true, true], ["resume", true, false], ["stop", false, false]] as const) {
      const r = await call(a, `/v1/devices/${d.id}/commands/profile`, "POST", { action });
      expect(r.status).toBe(202);
      const commandId = (await r.json() as { command: { id: string } }).command.id;
      await ingest(d, active, paused, commandId);
    }
    expect((await call(a, `/v1/devices/${d.id}/latest`)).status).toBe(200);
    expect((await call(a, `/v1/devices/${d.id}/commands/setpoint`, "POST", { setpoint: 17 })).status).toBe(202);
    await env.DB.prepare("DELETE FROM organization_history_plans WHERE organization_id = ?1").bind(a.id).run();
    await denied(await call(a, "/v1/recipes"));
    await setPlan(a.id, "pro");
    const restored = await call(a, "/v1/recipes"); expect(restored.status).toBe(200);
    expect(await restored.json()).toMatchObject({ recipes: [{ id, version: 1, name: input.name }] });
    const samples = await env.DB.prepare("SELECT COUNT(*) AS n FROM telemetry WHERE device_id = ?1").bind(d.id).first<{ n: number }>();
    expect(samples!.n).toBeGreaterThan(0);
    const commands = await env.DB.prepare("SELECT type, status FROM device_commands WHERE device_id = ?1 AND type != 'set_setpoint'").bind(d.id).all();
    expect(commands.results).toHaveLength(4);
    expect(commands.results.every(c => c.status === "applied")).toBe(true);
  });
  it("unknown/malformed entitlement codes never grant cloud recipes", () => {
    for (const code of [undefined, null, "", "PRO", "invalid", { plan: "pro" }]) expect(planEntitlements(code).canUseRecipes).toBe(false);
    expect(planEntitlements("plus").canUseRecipes).toBe(true);
    expect(planEntitlements("pro").canUseRecipes).toBe(true);
  });
});
