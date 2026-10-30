import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import "../src/index";
// Node CLI has no TS declarations; the frame schema is checked by the API.
// @ts-expect-error import of the Node ESM simulator for isolated Worker tests
import { labDeviceId, makeLabTelemetry } from "../scripts/maltworks-lab.mjs";

const base = "https://api-staging.maltworks.com.br";
const TOKEN = "ba".repeat(32);
const DEVICE_ID = labDeviceId(0);

function ingest(tick: number, scenario = "alarm"): Promise<Response> {
  const payload = makeLabTelemetry(0, tick, {
    scenario, sessionId: 83, startAt: 1_800_000_000,
  });
  return exports.default.fetch(base + "/v1/telemetry", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + TOKEN,
      "Content-Type": "application/json",
      "X-Maltworks-Device-ID": DEVICE_ID,
    },
    body: JSON.stringify(payload),
  });
}

describe("Maltworks Lab uses the genuine API contract in isolated D1", () => {
  it("registers, claims and streams alarm transitions without any public Lab route", async () => {
    const unregistered = await ingest(0);
    expect(unregistered.status).toBe(202);
    expect(await unregistered.json()).toMatchObject({
      ok: true, accepted: true, deviceStatus: "pending",
    });

    const bootstrap = await exports.default.fetch(base + "/v1/auth/bootstrap", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test-bootstrap-secret-with-32-characters",
      },
      body: JSON.stringify({
        organizationName: "Maltworks Internal Test Only",
        displayName: "Lab QA",
        email: "lab-contract@example.test",
        password: "lab-test-password-with-adequate-length",
      }),
    });
    expect(bootstrap.status).toBe(201);
    const cookie = bootstrap.headers.get("Set-Cookie")?.split(";", 1)[0] ?? "";

    const claim = await exports.default.fetch(base + "/v1/devices/claim", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({
        registrationToken: DEVICE_ID + "-" + TOKEN.slice(-16),
        name: "LAB / Controller 01",
      }),
    });
    expect(claim.status).toBe(201);

    for (let tick = 1; tick < 10; tick++) {
      const response = await ingest(tick);
      expect(response.status).toBe(200);
    }

    const state = await env.DB.prepare(
      "SELECT COUNT(*) AS samples, SUM(alarms_active) AS alarms FROM telemetry WHERE device_id = ?1",
    ).bind(DEVICE_ID).first<{ samples: number; alarms: number }>();
    expect(state?.samples).toBeGreaterThanOrEqual(3);
    expect(state?.samples).toBeLessThan(10);
    expect(state?.alarms).toBeGreaterThanOrEqual(1);

    const latest = await exports.default.fetch(base + "/v1/devices/" + DEVICE_ID + "/latest", {
      headers: { Cookie: cookie },
    });
    expect(latest.status).toBe(200);
    expect(await latest.json()).toMatchObject({
      state: { deviceId: DEVICE_ID, sequence: 10, alarms: { active: false } },
    });

    // The Lab is a test utility in scripts/, not a customer-facing endpoint.
    const labRoute = await exports.default.fetch(base + "/v1/lab", {
      headers: { Cookie: cookie },
    });
    expect(labRoute.status).toBe(404);
  });
});
