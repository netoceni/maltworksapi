import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import "../src/index";
import { recordDeviceOnline, recordOfflineDevice } from "../src/notifications";

const BASE = "https://api-staging.maltworks.com.br";
// Stable fixture identity: avoid eager simulator evaluation during Windows workerd module loading.
const DEVICE_ID = "MW-C00000000001";
const TOKEN = "ce".repeat(32);

// A pure fixture avoids loading the Node CLI simulator (node:url / process.argv)
// into the Windows workerd test runtime. It is never sent to real staging.
function makePayload(tick: number): Record<string, unknown> {
  return {
    schemaVersion: 1,
    deviceId: DEVICE_ID,
    bootId: "A1270001",
    sequence: tick + 1,
    sentAt: 1_800_000_000 + tick * 30,
    uptimeSeconds: (tick + 1) * 30,
    firmware: { product: "MaltworksController", version: "5.5.2", phase: "lab" },
    network: { rssi: -58 },
    temperatures: {
      refrigerator: { connected: true, value: 18.25, raw: 18.25, offset: 0 },
      thermalWell: { connected: true, value: 18.1, raw: 18.1, offset: 0 },
    },
    control: {
      setpoint: 18,
      hysteresis: 0.5,
      state: "STABLE",
      cooling: false,
      heating: false,
      compressorProtectionSeconds: 0,
      compressorProtectionDurationSeconds: 180,
    },
    profile: {
      active: false,
      paused: false,
      name: "",
      state: "IDLE",
      stage: 0,
      stageCount: 0,
      remainingSeconds: 0,
    },
    alarms: {
      active: false,
      unacknowledged: false,
      count: 0,
      summary: "Nenhum alarme",
      configuration: {
        sensorAlarmEnabled: true,
        highTemperatureEnabled: true,
        lowTemperatureEnabled: true,
        responseAlarmEnabled: true,
        highTemperatureLimit: 35,
        lowTemperatureLimit: -5,
        minimumExpectedChange: 0.5,
        responseTimeoutSeconds: 5400,
      },
    },
  };
}

async function transmit(tick: number): Promise<Response> {
  const payload = makePayload(tick);
  return exports.default.fetch(BASE + "/v1/telemetry", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + TOKEN,
      "X-Maltworks-Device-ID": DEVICE_ID,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
}

async function onlineCount(): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS total FROM notifications WHERE device_id=?1 AND type='device_online'",
  ).bind(DEVICE_ID).first<{ total: number }>();
  return row?.total ?? 0;
}

async function offlineActive(): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT active FROM notification_states WHERE device_id=?1 AND type='offline'",
  ).bind(DEVICE_ID).first<{ active: number }>();
  return row?.active ?? 0;
}

describe("Realtime device recovery synchronizes D1 notifications", () => {
  it("recovers on authenticated WebSocket upgrade and deduplicates later HTTP/WS events", async () => {
    expect((await transmit(0)).status).toBe(202);

    const bootstrap = await exports.default.fetch(BASE + "/v1/auth/bootstrap", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test-bootstrap-secret-with-32-characters",
      },
      body: JSON.stringify({
        organizationName: "Lab WS Recovery",
        displayName: "Recovery Tester",
        email: "ws-recovery@example.test",
        password: "lab-ws-recovery-password-long-enough",
      }),
    });
    expect(bootstrap.status).toBe(201);
    const cookie = bootstrap.headers.get("Set-Cookie")?.split(";", 1)[0] ?? "";

    const claimed = await exports.default.fetch(BASE + "/v1/devices/claim", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({
        registrationToken: DEVICE_ID + "-" + TOKEN.slice(-16),
        name: "Lab WS Device",
      }),
    });
    expect(claimed.status).toBe(201);
    expect((await transmit(1)).status).toBe(200);

    // A device was offline before the authenticated WS-only reconnect.
    const now = Math.floor(Date.now() / 1_000);
    await env.DB.prepare("UPDATE devices SET last_seen_at=?1 WHERE id=?2")
      .bind(now - 120, DEVICE_ID).run();
    expect(await recordOfflineDevice(env, DEVICE_ID, now)).toHaveLength(1);
    expect(await offlineActive()).toBe(1);
    expect(await onlineCount()).toBe(0);

    // An unauthenticated socket must not clear the offline state.
    const unauthenticated = await exports.default.fetch(BASE + "/v1/device/realtime", {
      headers: { Upgrade: "websocket", "X-Maltworks-Device-ID": DEVICE_ID },
    });
    expect(unauthenticated.status).toBe(401);
    expect(await offlineActive()).toBe(1);

    const connected = await exports.default.fetch(BASE + "/v1/device/realtime", {
      headers: {
        Upgrade: "websocket",
        Authorization: "Bearer " + TOKEN,
        "X-Maltworks-Device-ID": DEVICE_ID,
      },
    });
    expect(connected.status).toBe(101);
    expect(connected.webSocket).toBeDefined();
    expect(await offlineActive()).toBe(0);
    expect(await onlineCount()).toBe(1);

    // A later authenticated HTTP packet must not create another online event.
    expect((await transmit(2)).status).toBe(200);
    expect(await onlineCount()).toBe(1);
    expect(await recordDeviceOnline(env, DEVICE_ID, now + 1)).toEqual([]);

    // A new incident creates exactly one new recovery event even with
    // two simultaneous paths racing to acknowledge the same transition.
    // Use a different last_seen_at from the first incident: notification
    // event keys intentionally deduplicate identical offline episodes.
    await env.DB.prepare("UPDATE devices SET last_seen_at=?1 WHERE id=?2")
      .bind(now - 115, DEVICE_ID).run();
    expect(await recordOfflineDevice(env, DEVICE_ID, now + 1)).toHaveLength(1);
    expect(await offlineActive()).toBe(1);
    const raced = await Promise.all([
      recordDeviceOnline(env, DEVICE_ID, now + 2),
      recordDeviceOnline(env, DEVICE_ID, now + 2),
    ]);
    expect(raced.flat()).toHaveLength(1);
    expect(await offlineActive()).toBe(0);
    expect(await onlineCount()).toBe(2);

    // Always release the simulated client; no real staging resources exist here.
    try {
      connected.webSocket?.accept();
      connected.webSocket?.close(1000, "test complete");
    } catch {
      // A test socket may already have been closed by the fixture runtime.
    }
  });
});
