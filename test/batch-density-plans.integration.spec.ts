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
  const id = "batch-plan-" + ++serial;
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
  const payload = makeLabTelemetry(0, d.tick++, { sessionId: 131, startAt: now });
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

const ingredient = { name: "Simulated malt", category: "malte", plannedQuantity: 2, unit: "kg", plannedCost: 20 };
const journal = { kind: "observacao", title: "Simulated journal", details: "Development only" };
const batchInput = { name: "Simulated batch", originalGravity: 1.05, plannedFinalGravity: 1.01 };
interface Detail { id: string; readings: Array<{ id: string }>; ingredients: Array<{ id: string }>;
  journal: Array<{ id: string }>; attachments: Array<{ id: string }> }
async function upload(a: Account, batchId: string) {
  const bytes = new TextEncoder().encode("simulated batch attachment");
  return exports.default.fetch(`${base}/v1/batches/${batchId}/attachments`, { method: "POST",
    headers: { Cookie: a.cookie, "Content-Type": "text/plain", "Content-Length": String(bytes.length), "X-File-Name": "simulated.txt" }, body: bytes });
}
async function fixture() {
  const a = await account("pro"); const d = await device(a); const recipeId = await created(a);
  const started = await call(a, `/v1/devices/${d.id}/fermentation`, "POST", { ...batchInput, recipeId });
  expect(started.status).toBe(201);
  const batchId = (await started.json() as { fermentation: { id: string } }).fermentation.id;
  expect((await call(a, `/v1/devices/${d.id}/fermentation/readings`, "POST", { gravity: 1.02 })).status).toBe(201);
  expect((await call(a, `/v1/batches/${batchId}/ingredients`, "POST", ingredient)).status).toBe(201);
  expect((await call(a, `/v1/batches/${batchId}/journal`, "POST", journal)).status).toBe(201);
  const uploaded = await upload(a, batchId); expect(uploaded.status).toBe(201);
  const detail = (await uploaded.json() as { batch: Detail }).batch;
  return { a, d, recipeId, batchId, readingId: detail.readings[0]!.id,
    ingredientId: detail.ingredients[0]!.id, journalId: detail.journal[0]!.id, attachmentId: detail.attachments[0]!.id };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function routes(f: Fixture) {
  const b = `/v1/batches/${f.batchId}`; const ferm = `/v1/devices/${f.d.id}/fermentation`;
  return [
    ["/v1/batches", "GET", undefined],
    [`/v1/batches/compare?recipeId=${f.recipeId}`, "GET", undefined],
    [b, "GET", undefined], [b, "PUT", { finalGravity: 1.011, canUseBatches: true, plan: "pro" }],
    [b + "/ingredients", "POST", ingredient], [b + "/ingredients/" + f.ingredientId, "DELETE", undefined],
    [b + "/journal", "POST", journal], [b + "/journal/" + f.journalId, "DELETE", undefined],
    [b + "/attachments", "UPLOAD", undefined], [b + "/attachments/" + f.attachmentId, "GET", undefined],
    [b + "/attachments/" + f.attachmentId, "DELETE", undefined],
    [ferm, "GET", undefined], [ferm, "POST", { ...batchInput, planCode: "pro", canUseDensity: true }],
    [ferm + "/finish", "POST", { finalGravity: 1.01 }],
    [ferm + "/readings", "POST", { gravity: 1.015, canUseDensity: true }],
    [ferm + "/readings/" + f.readingId, "DELETE", undefined],
  ] as const;
}
async function invoke(a: Account, f: Fixture, route: ReturnType<typeof routes>[number]) {
  const [path, method, body] = route;
  if (method === "UPLOAD") return upload(a, f.batchId);
  return call(a, path + (path.includes("?") ? "&" : "?") + "plan=pro&canUseBatches=true&canUseDensity=true", method, body);
}
async function snapshot(f: Fixture) {
  const tables = ["fermentation_readings", "batch_ingredients", "batch_journal", "batch_attachments"];
  const children = await Promise.all(tables.map(table => env.DB.prepare(`SELECT * FROM ${table} WHERE session_id = ?1 ORDER BY id`).bind(f.batchId).all()));
  const rows = await env.DB.prepare("SELECT * FROM fermentation_sessions WHERE id = ?1").bind(f.batchId).first();
  const audits = await env.DB.prepare("SELECT * FROM audit_log WHERE organization_id = ?1 ORDER BY id").bind(f.a.id).all();
  const objects = await env.BATCH_FILES.list({ prefix: `batches/${f.a.id}/` });
  return { rows, children: children.map(c => c.results), audits: audits.results, objects: objects.objects.map(o => o.key) };
}

describe("Pro batches and density (simulated devices, isolated D1/R2)", () => {
  for (const plan of [undefined, "essential", "plus"] as const) {
    it(`${plan ?? "revoked/missing grant"}: blocks every batch/density route without data or object mutations`, async () => {
      const f = await fixture();
      if (plan) await setPlan(f.a.id, plan);
      else await env.DB.prepare("DELETE FROM organization_history_plans WHERE organization_id = ?1").bind(f.a.id).run();
      const before = await snapshot(f);
      for (const route of routes(f)) {
        const response = await invoke(f.a, f, route);
        await denied(response, route[0].includes("/readings") ? "DENSITY_PLAN_REQUIRED" : "BATCH_PLAN_REQUIRED");
      }
      expect(await snapshot(f)).toEqual(before);
      const object = await env.DB.prepare("SELECT object_key AS objectKey FROM batch_attachments WHERE id = ?1")
        .bind(f.attachmentId).first<{ objectKey: string }>();
      expect(await (await env.BATCH_FILES.get(object!.objectKey))!.text()).toBe("simulated batch attachment");
      await setPlan(f.a.id, "pro");
      const restored = await call(f.a, `/v1/batches/${f.batchId}`); expect(restored.status).toBe(200);
      expect(await restored.json()).toMatchObject({ batch: { id: f.batchId, active: true, originalGravity: 1.05,
        recipeSnapshot: { id: f.recipeId }, readings: [{ gravity: 1.02 }] } });
    });
  }
  it("Pro supports lifecycle, gravity, batch metrics, ingredients, journal and attachments", async () => {
    const f = await fixture(); const { a, d, batchId } = f; const b = `/v1/batches/${batchId}`;
    expect((await call(a, "/v1/batches")).status).toBe(200);
    const comparison = await call(a, `/v1/batches/compare?recipeId=${f.recipeId}`); expect(comparison.status).toBe(200);
    expect(await comparison.json()).toMatchObject({ batches: [{ id: batchId }] });
    expect((await call(a, `/v1/devices/${d.id}/fermentation`)).status).toBe(200);
    const updated = await call(a, b, "PUT", { finalGravity: 1.01 }); expect(updated.status).toBe(200);
    expect(await updated.json()).toMatchObject({ batch: { metrics: { abv: 5.25, attenuation: 80 } } });
    const downloaded = await call(a, b + "/attachments/" + f.attachmentId); expect(downloaded.status).toBe(200);
    expect(await downloaded.text()).toBe("simulated batch attachment");
    for (const path of [b + "/ingredients/" + f.ingredientId, b + "/journal/" + f.journalId, b + "/attachments/" + f.attachmentId,
      `/v1/devices/${d.id}/fermentation/readings/${f.readingId}`]) expect((await call(a, path, "DELETE")).status).toBe(200);
    expect((await env.BATCH_FILES.list({ prefix: `batches/${a.id}/` })).objects).toHaveLength(0);
    expect((await call(a, `/v1/devices/${d.id}/fermentation/readings`, "POST", { gravity: 1.015 })).status).toBe(201);
    expect((await call(a, `/v1/devices/${d.id}/fermentation/finish`, "POST", { finalGravity: 1.01 })).status).toBe(200);
    expect((await call(a, `/v1/devices/${d.id}/fermentation/readings`, "POST", { gravity: 1.01 })).status).toBe(409);
    expect((await call(a, `/v1/devices/${d.id}/fermentation`, "POST", batchInput)).status).toBe(201);
  });
  it("Pro never overrides viewer restrictions or cross-organization ownership, across all routes", async () => {
    const f = await fixture(); const foreign = await account("pro");
    for (const route of routes(f)) {
      const r = await invoke(foreign, f, route);
      // Lists are scoped to the caller and comparisons may be empty.
      expect(r.status).toBe(route[0].startsWith("/v1/batches/compare") || route[0] === "/v1/batches" ? 200 : 404);
      if (r.status === 200) expect(await r.json()).toMatchObject({ batches: [] });
    }
    await denied(await call(foreign, `/v1/batches?organizationId=${f.a.id}`), "ORGANIZATION_ACCESS_DENIED");
    await env.DB.prepare("UPDATE organization_members SET role = 'viewer' WHERE organization_id = ?1").bind(f.a.id).run();
    const before = await snapshot(f);
    for (const route of routes(f)) {
      const r = await invoke(f.a, f, route);
      if (route[1] === "GET") expect(r.status).toBe(200);
      else await denied(r, route[0].includes("/fermentation") ? "FERMENTATION_WRITE_DENIED" : "BATCH_WRITE_DENIED");
    }
    expect(await snapshot(f)).toEqual(before);
    for (const route of routes(f)) expect((await invoke({ ...f.a, cookie: "" }, f, route)).status).toBe(401);
  });
  it("downgrades leave simulated device telemetry, profile delivery/ack and basic control independent", async () => {
    const f = await fixture(); const { a, d } = f;
    const r = await call(a, `/v1/devices/${d.id}/commands/profile`, "POST", { action: "start", recipeId: f.recipeId });
    expect(r.status).toBe(202); const cmd = (await r.json() as { command: { id: string } }).command.id;
    await setPlan(a.id, "essential");
    expect(await (await ingest(d)).json()).toMatchObject({ command: { id: cmd, type: "start_profile" } });
    await ingest(d, true, false, cmd);
    for (const [action, active, paused] of [["pause", true, true], ["resume", true, false], ["stop", false, false]] as const) {
      const c = await call(a, `/v1/devices/${d.id}/commands/profile`, "POST", { action }); expect(c.status).toBe(202);
      await ingest(d, active, paused, (await c.json() as { command: { id: string } }).command.id);
    }
    expect((await call(a, `/v1/devices/${d.id}/latest`)).status).toBe(200);
    expect((await call(a, `/v1/devices/${d.id}/commands/setpoint`, "POST", { setpoint: 17 })).status).toBe(202);
    const batch = await env.DB.prepare("SELECT finished_at AS finishedAt FROM fermentation_sessions WHERE id = ?1").bind(f.batchId).first();
    expect(batch).toEqual({ finishedAt: null }); // No automatic finishing or deletion.
  });
  it("resolves explicit organization grants and defaults unknown values to no batch/density access", async () => {
    for (const code of [undefined, null, "PRO", "invalid", { plan: "pro" }, "essential", "plus"]) {
      expect(planEntitlements(code)).toMatchObject({ canUseBatches: false, canUseDensity: false });
    }
    expect(planEntitlements("pro")).toMatchObject({ canUseBatches: true, canUseDensity: true });
    const f = await fixture(); const a = await account("plus");
    await env.DB.prepare("INSERT INTO organization_members (organization_id, user_id, role, created_at) VALUES (?1, ?2, 'viewer', ?3)")
      .bind(f.a.id, a.id, now + 1).run();
    await denied(await call(a, "/v1/batches"), "BATCH_PLAN_REQUIRED");
    expect((await call(a, `/v1/batches/${f.batchId}?organizationId=${f.a.id}`)).status).toBe(200);
    await denied(await call(a, `/v1/batches/${f.batchId}`, "PUT", { organizationId: f.a.id, finalGravity: 1.011 }), "BATCH_WRITE_DENIED");
  });
});
