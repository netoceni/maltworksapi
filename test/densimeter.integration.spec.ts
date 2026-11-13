import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import "../src/index";
import { sha256Hex } from "../src/crypto";
import { validateDensimeter, type DensimeterReading } from "../src/densimeter";

const base = "https://api.maltworks.com.br";
const now = Math.floor(Date.now() / 1000);
let serial = 0;
async function fixture(plan = "essential") {
  const id = "densimeter-" + ++serial;
  const session = id.padEnd(64, "s");
  const deviceId = "MW-" + serial.toString(16).padStart(12, "0").toUpperCase();
  const token = serial.toString(16).padStart(64, "a");
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO organizations (id, name, slug, created_at, updated_at)
      VALUES (?1, ?1, ?1, ?2, ?2)`).bind(id, now),
    env.DB.prepare(`INSERT INTO users (id, email, password_hash, password_salt,
      password_iterations, display_name, created_at, updated_at)
      VALUES (?1, ?2, 'test', 'test', 1, 'Sensor QA', ?3, ?3)`).bind(id, id + "@example.test", now),
    env.DB.prepare(`INSERT INTO organization_members (organization_id, user_id, role, created_at)
      VALUES (?1, ?1, 'owner', ?2)`).bind(id, now),
    env.DB.prepare(`INSERT INTO sessions (token_hash, user_id, created_at, expires_at, last_seen_at)
      VALUES (?1, ?2, ?3, ?4, ?3)`).bind(await sha256Hex(session), id, now, now + 3600),
    env.DB.prepare(`INSERT INTO organization_history_plans (organization_id, plan_code, updated_at)
      VALUES (?1, ?2, ?3)`).bind(id, plan, now),
    env.DB.prepare(`INSERT INTO devices (id, organization_id, name, status, firmware_version,
      first_seen_at, last_seen_at, created_at, updated_at)
      VALUES (?1, ?2, 'Sensor QA', 'active', '5.5.6', ?3, ?3, ?3, ?3)`).bind(deviceId, id, now),
    env.DB.prepare(`INSERT INTO device_credentials (device_id, token_hash, pairing_code_hash, created_at)
      VALUES (?1, ?2, ?3, ?4)`).bind(deviceId, await sha256Hex(token), await sha256Hex(token.slice(-16)), now),
  ]);
  let seq = 0;
  return {
    deviceId, cookie: "mw_session=" + session,
    async send(densimeter?: unknown, authenticated = true) {
      const payload: Record<string, unknown> = {
        schemaVersion: 1, deviceId, bootId: "ABCDEF12", sequence: ++seq,
        sentAt: now, uptimeSeconds: seq * 5,
        firmware: { product: "MaltworksController", version: "5.5.6", phase: "Sensor cloud bench" },
        network: { rssi: -58 },
        temperatures: {
          refrigerator: { connected: true, value: 18, raw: 18, offset: 0 },
          thermalWell: { connected: true, value: 18, raw: 18, offset: 0 },
        },
        control: { setpoint: 18, hysteresis: 0.5, state: "ESTAVEL", cooling: false,
          heating: false, compressorProtectionSeconds: 0, compressorProtectionDurationSeconds: 60 },
        profile: { active: false, paused: false, name: "", state: "INATIVO", stage: 0,
          stageCount: 0, remainingSeconds: 0 },
        alarms: { active: false, unacknowledged: false, count: 0, summary: "Nenhum alarme" },
      };
      if (densimeter !== undefined) payload.densimeter = densimeter;
      return exports.default.fetch(base + "/v1/telemetry", {
        method: "POST", headers: { "Content-Type": "application/json",
          "X-Maltworks-Device-ID": deviceId,
          Authorization: "Bearer " + (authenticated ? token : "0".repeat(64)) },
        body: JSON.stringify(payload),
      });
    },
    async history(cookie = "mw_session=" + session) {
      return exports.default.fetch(`${base}/v1/devices/${deviceId}/densimeter`, { headers: { Cookie: cookie } });
    },
  };
}
function reading(index = 1): DensimeterReading {
  return { index, sessionId: "28050cabefb7cb5d", sequence: index,
    sampledAt: now - (4 - index) * 1800, intervalSeconds: 1800,
    angleMdeg: 69552, temperatureMc: 25875, batteryMv: 4120, rssi: -65,
    gravitySg: null, calibrationRevision: 0 };
}
function sensor(...readings: DensimeterReading[]) {
  return { protocolVersion: 1, sensorId: 16356134, readings };
}

describe("native densimeter cloud pipeline", () => {
  it.each(["essential", "plus", "pro"])("stores/reads real-format samples on %s without a plan gate", async plan => {
    const f = await fixture(plan);
    const r = reading();
    const sent = await f.send(sensor(r));
    expect(sent.status).toBe(200);
    expect((await sent.json() as { densimeterAck: unknown }).densimeterAck).toEqual({ sensorId: 16356134, indices: [1] });
    const response = await f.history();
    expect(response.status).toBe(200);
    const history = await response.json() as { sensorId: number; readings: DensimeterReading[] };
    expect(history.sensorId).toBe(16356134);
    expect(history.readings[0]).toMatchObject(r);
    expect(history.readings[0]?.gravitySg).toBeNull();
    expect((await exports.default.fetch(`${base}/v1/devices/${f.deviceId}/latest`, {
      headers: { Cookie: f.cookie },
    })).status).toBe(200);
  });
  it("keeps old firmware compatible and distinguishes no pairing from no support", async () => {
    const f = await fixture();
    expect((await f.send()).status).toBe(200);
    expect(await (await f.history()).json()).toMatchObject({ supported: false, sensorId: null, readings: [] });
    expect((await f.send(null)).status).toBe(200);
    expect(await (await f.history()).json()).toMatchObject({ supported: true, sensorId: null, readings: [] });
    expect((await f.send(sensor())).status).toBe(200);
    expect(await (await f.history()).json()).toMatchObject({ supported: true, sensorId: 16356134, readings: [] });
  });
  it("recovers backlog without duplicating or making old samples fresh", async () => {
    const f = await fixture();
    const latest = reading(3);
    expect((await f.send(sensor(latest, reading(1)))).status).toBe(200);
    expect((await f.send(sensor(latest, reading(1)))).status).toBe(200);
    expect((await f.send(sensor(latest, reading(2)))).status).toBe(200);
    const data = await (await f.history()).json() as { readings: DensimeterReading[] };
    expect(data.readings.map(r => r.sequence)).toEqual([3, 2, 1]);
    expect(data.readings.map(r => r.sampledAt)).toEqual([3, 2, 1].map(i => reading(i).sampledAt));
    expect((await f.send(sensor({ ...latest, batteryMv: 4000 }))).status).toBe(409);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM densimeter_readings WHERE device_id = ?")
      .bind(f.deviceId).first<{ n: number }>())?.n).toBe(3);
  });
  it("requires the device credential and does not expose another account's readings", async () => {
    const a = await fixture(); const b = await fixture();
    expect((await a.send(sensor(reading()), false)).status).toBe(401);
    expect((await a.send(sensor(reading()))).status).toBe(200);
    expect((await a.history(b.cookie)).status).toBe(404);
    expect((await exports.default.fetch(`${base}/v1/devices/${a.deviceId}/densimeter`)).status).toBe(401);
  });
  it("validates bounds, identity, clocks and calibrated density", () => {
    for (const patch of [
      { batteryMv: 5000 }, { temperatureMc: NaN }, { angleMdeg: -1 },
      { sequence: 0 }, { index: 0 }, { intervalSeconds: 120 }, { rssi: 5 },
      { sessionId: "invalid" }, { sampledAt: now + 3600 },
      { gravitySg: 1.012, calibrationRevision: 0 }, { gravitySg: 5, calibrationRevision: 1 },
    ]) expect(() => validateDensimeter(sensor({ ...reading(), ...patch }))).toThrow();
    expect(() => validateDensimeter(sensor(reading(), reading()))).toThrow();
    expect(() => validateDensimeter(sensor(...[1, 2, 3, 4, 5].map(reading)))).toThrow();
    expect(validateDensimeter(sensor({ ...reading(), gravitySg: 1.012, calibrationRevision: 1 })))
      .toMatchObject({ readings: [{ gravitySg: 1.012, calibrationRevision: 1 }] });
  });
});
