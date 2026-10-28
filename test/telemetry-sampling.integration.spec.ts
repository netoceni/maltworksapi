import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import "../src/index";
import { recordOfflineDevice, scanOfflineDevices } from "../src/notifications";

const deviceId = "MW-ABCDEF1234AB";
const token = "abcdef0123456789".repeat(4);
const base = "https://api.maltworks.com.br";

function sample(sequence: number): Record<string, unknown> {
  return {
    schemaVersion: 1, deviceId, bootId: "ABCDEF12", sequence,
    sentAt: 1_785_717_600 + sequence * 5, uptimeSeconds: 100 + sequence * 5,
    firmware: { product: "MaltworksController", version: "5.5.2", phase: "pilot" },
    network: { rssi: -55 },
    temperatures: {
      refrigerator: { connected: true, value: 18.5, raw: 18.5, offset: 0 },
      thermalWell: { connected: true, value: 18.4, raw: 18.4, offset: 0 },
    },
    control: {
      setpoint: 18, hysteresis: 0.5, state: "ESTAVEL",
      cooling: false, heating: false,
      compressorProtectionSeconds: 0, compressorProtectionDurationSeconds: 60,
    },
    profile: {
      active: false, paused: false, name: "",
      state: "INATIVO", stage: 0, stageCount: 0, remainingSeconds: 0,
    },
    alarms: {
      active: false, unacknowledged: false, count: 0, summary: "Nenhum alarme",
      configuration: {
        sensorAlarmEnabled: true, highTemperatureEnabled: true, lowTemperatureEnabled: true,
        responseAlarmEnabled: true, highTemperatureLimit: 35, lowTemperatureLimit: -5,
        minimumExpectedChange: 0.5, responseTimeoutSeconds: 5400,
      },
    },
  };
}

async function send(payload: Record<string, unknown>): Promise<Response> {
  return exports.default.fetch(base + "/v1/telemetry", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + token,
      "X-Maltworks-Device-ID": deviceId,
    },
    body: JSON.stringify(payload),
  });
}

async function countSamples(): Promise<number> {
  const result = await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM telemetry WHERE device_id = ?1",
  ).bind(deviceId).first<{ count: number }>();
  return result?.count ?? 0;
}

describe("sampled HTTP telemetry / DO realtime / D1 integration", () => {
  it("keeps 5s readings live while persisting only snapshots and changes", async () => {
    expect((await send(sample(1))).status).toBe(202);
    expect(await countSamples()).toBe(1);

    const bootstrap = await exports.default.fetch(base + "/v1/auth/bootstrap", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test-bootstrap-secret-with-32-characters",
      },
      body: JSON.stringify({
        organizationName: "Maltworks Sampling",
        displayName: "Controller Test",
        email: "sampling@example.com",
        password: "senha-forte-para-teste-de-sampling",
      }),
    });
    expect(bootstrap.status).toBe(201);
    const cookie = bootstrap.headers.get("Set-Cookie")?.split(";", 1)[0] ?? "";
    const claim = await exports.default.fetch(base + "/v1/devices/claim", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({
        registrationToken: deviceId + "-" + token.slice(-16),
        name: "Teste amostragem",
      }),
    });
    expect(claim.status).toBe(201);

    const user = await exports.default.fetch(base + "/v1/me", { headers: { Cookie: cookie } });
    const userBody = await user.json() as { user: { memberships: Array<{ organizationId: string }> } };
    const org = userBody.user.memberships[0]!.organizationId;

    const second = sample(2);
    (second.temperatures as Record<string, Record<string, unknown>>).refrigerator.value = 17.8;
    (second.temperatures as Record<string, Record<string, unknown>>).refrigerator.raw = 17.8;
    expect((await send(second)).status).toBe(200);
    expect(await countSamples()).toBe(1);
    const stored = await env.DB.prepare(
      "SELECT sequence FROM device_latest_state WHERE device_id = ?1",
    ).bind(deviceId).first<{ sequence: number }>();
    expect(stored?.sequence).toBe(1);

    const live = await env.REALTIME.getByName(org).getDeviceSnapshot(deviceId);
    expect(live?.online).toBe(true);
    expect(live?.state?.sequence).toBe(2);

    const latest = await exports.default.fetch(base + "/v1/devices/" + deviceId + "/latest", {
      headers: { Cookie: cookie },
    });
    expect(latest.status).toBe(200);
    expect(await latest.json()).toMatchObject({
      state: { sequence: 2, temperatures: { refrigerator: { value: 17.8 } } },
    });
    const deviceList = await exports.default.fetch(base + "/v1/devices", {
      headers: { Cookie: cookie },
    });
    expect(deviceList.status).toBe(200);
    expect(await deviceList.json()).toMatchObject({
      devices: [{ id: deviceId, refrigeratorValue: 17.8 }],
    });

    const alarm = sample(3);
    alarm.alarms = {
      ...(alarm.alarms as Record<string, unknown>),
      active: true, unacknowledged: true, count: 1, summary: "Temperatura alta",
    };
    expect((await send(alarm)).status).toBe(200);
    expect(await countSamples()).toBe(2);

    const stableAlarm = sample(4);
    stableAlarm.alarms = alarm.alarms;
    expect((await send(stableAlarm)).status).toBe(200);
    expect(await countSamples()).toBe(2);

    const recovered = sample(5);
    expect((await send(recovered)).status).toBe(200);
    expect(await countSamples()).toBe(3);

    // Devices.last_seen_at is intentionally behind realtime in sampled mode.
    // A stale D1 timestamp must not block authorized commands.
    await env.DB.prepare("UPDATE devices SET last_seen_at = ?1 WHERE id = ?2")
      .bind(Math.floor(Date.now() / 1000) - 100, deviceId).run();
    const refreshedList = await exports.default.fetch(base + "/v1/devices", {
      headers: { Cookie: cookie },
    });
    const refreshedBody = await refreshedList.json() as {
      devices: Array<{ lastSeenAt: number }>;
    };
    expect(refreshedBody.devices[0]!.lastSeenAt).toBeGreaterThan(Math.floor(Date.now() / 1000) - 30);

    const admin = await exports.default.fetch(base + "/v1/admin/overview", {
      headers: { Cookie: cookie },
    });
    expect(admin.status).toBe(200);
    expect(await admin.json()).toMatchObject({ overview: { devicesOnline: 1 } });

    const adminUsers = await exports.default.fetch(base + "/v1/admin/users", {
      headers: { Cookie: cookie },
    });
    expect(adminUsers.status).toBe(200);
    expect(await adminUsers.json()).toMatchObject({
      users: [{ onlineDeviceCount: 1 }],
    });

    // OTA must see the live device as online, even though there is no
    // firmware release available in this isolated test database.
    const preflight = await exports.default.fetch(base + "/v1/devices/" + deviceId + "/firmware/update", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: "{}",
    });
    expect(preflight.status).toBe(404);
    expect(await preflight.json()).toMatchObject({
      error: { code: "FIRMWARE_NOT_AVAILABLE" },
    });

    const otaInventory = await exports.default.fetch(base + "/v1/admin/ota/devices", {
      headers: { Cookie: cookie },
    });
    expect(otaInventory.status).toBe(200);
    expect(await otaInventory.json()).toMatchObject({
      devices: [{ id: deviceId, online: true }],
    });

    const setpoint = await exports.default.fetch(base + "/v1/devices/" + deviceId + "/commands/setpoint", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ setpoint: 16 }),
    });
    expect(setpoint.status).toBe(202);
    const setpointBody = await setpoint.json() as { command: { id: string } };

    const result = sample(6);
    result.commandResult = {
      id: setpointBody.command.id,
      status: "applied", appliedSetpoint: 16, message: "OK",
    };
    result.control = { ...(result.control as Record<string, unknown>), setpoint: 16 };
    expect((await send(result)).status).toBe(200);
    expect(await countSamples()).toBe(4);
    const afterAck = await exports.default.fetch(base + "/v1/devices/" + deviceId + "/latest", {
      headers: { Cookie: cookie },
    });
    expect(await afterAck.json()).toMatchObject({
      latestCommand: { status: "applied" },
      state: { sequence: 6 },
    });

    // Even when D1 is manually made stale, the active DO presence wins.
    await env.DB.prepare("UPDATE devices SET last_seen_at = ?1 WHERE id = ?2")
      .bind(Math.floor(Date.now() / 1000) - 100, deviceId).run();
    expect(await scanOfflineDevices(env)).toEqual([]);
    const falseAlarm = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM notifications WHERE device_id = ?1 AND type = 'device_offline'",
    ).bind(deviceId).first<{ count: number }>();
    expect(falseAlarm?.count).toBe(0);

    const notifications = await exports.default.fetch(base + "/v1/notifications?limit=20", {
      headers: { Cookie: cookie },
    });
    expect(notifications.status).toBe(200);
    const notificationBody = await notifications.json() as { notifications: Array<{ type: string }> };
    expect(notificationBody.notifications.map((item) => item.type)).toEqual(expect.arrayContaining([
      "alarm_activated", "alarm_resolved",
    ]));

    // An authenticated replay must not overwrite the latest D1 / live state.
    const replay = sample(2);
    replay.alarms = {
      ...(replay.alarms as Record<string, unknown>),
      active: true, unacknowledged: true, count: 1, summary: "Antigo",
    };
    expect((await send(replay)).status).toBe(200);
    expect(await countSamples()).toBe(4);
    const afterReplay = await env.REALTIME.getByName(org).getDeviceSnapshot(deviceId);
    expect(afterReplay?.state?.sequence).toBe(6);

    // A repeated packet is still a heartbeat: it must clear an offline alert
    // without writing telemetry again or re-creating past alarm notifications.
    const offlineAt = Math.floor(Date.now() / 1000);
    await env.DB.prepare("UPDATE devices SET last_seen_at = ?1 WHERE id = ?2")
      .bind(offlineAt - 50, deviceId).run();
    expect(await recordOfflineDevice(env, deviceId, offlineAt)).toHaveLength(1);
    expect((await send(result)).status).toBe(200);
    expect(await countSamples()).toBe(4);
    const activeOffline = await env.DB.prepare(
      "SELECT active FROM notification_states WHERE device_id = ?1 AND type = 'offline'",
    ).bind(deviceId).first<{ active: number }>();
    expect(activeOffline?.active).toBe(0);

    // After a reboot, delayed packets from the retired boot must not restore
    // its old sensor state, change the firmware version or create new events.
    const freshBoot = sample(1);
    freshBoot.bootId = "F00DBABE";
    freshBoot.sentAt = (result.sentAt as number) + 30;
    expect((await send(freshBoot)).status).toBe(200);
    expect(await countSamples()).toBe(5);
    const latePreviousBoot = sample(7);
    latePreviousBoot.sentAt = (result.sentAt as number) - 10;
    expect((await send(latePreviousBoot)).status).toBe(200);
    expect(await countSamples()).toBe(5);
    const afterOldBoot = await env.REALTIME.getByName(org).getDeviceSnapshot(deviceId);
    expect(afterOldBoot?.state?.bootId).toBe("F00DBABE");

    // Both HTTP requests can compare the same stored predecessor. The
    // conditional SQL upsert and the DO sequence guard must prevent rollback.
    const frame2 = sample(2);
    frame2.bootId = "F00DBABE";
    frame2.sentAt = (freshBoot.sentAt as number) + 5;
    frame2.control = {
      ...(frame2.control as Record<string, unknown>),
      state: "AQUECENDO", heating: true,
    };
    const frame3 = sample(3);
    frame3.bootId = "F00DBABE";
    frame3.sentAt = (freshBoot.sentAt as number) + 10;
    frame3.control = {
      ...(frame3.control as Record<string, unknown>),
      state: "RESFRIANDO", cooling: true,
    };
    const concurrent = await Promise.all([send(frame2), send(frame3)]);
    expect(concurrent.map((response) => response.status)).toEqual([200, 200]);
    const saved = await env.DB.prepare(
      "SELECT boot_id AS bootId, sequence, control_state AS controlState FROM device_latest_state WHERE device_id = ?1",
    ).bind(deviceId).first<{ bootId: string; sequence: number; controlState: string }>();
    expect(saved).toMatchObject({ bootId: "F00DBABE", sequence: 3, controlState: "RESFRIANDO" });
    const current = await env.REALTIME.getByName(org).getDeviceSnapshot(deviceId);
    expect(current?.state).toMatchObject({ bootId: "F00DBABE", sequence: 3 });
  });
});
