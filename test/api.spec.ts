import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import "../src/index";
import { scanOfflineDevices } from "../src/notifications";

const deviceId = "MW-A1B2C3D4E5F6";
const token = "0123456789abcdef".repeat(4);

function telemetry(sequence = 1): Record<string, unknown> {
  return {
    schemaVersion: 1,
    deviceId,
    bootId: "ABCDEF12",
    sequence,
    sentAt: 1_785_717_600,
    uptimeSeconds: 120,
    firmware: { product: "MaltworksController", version: "5.0.0", phase: "Cloud Ready" },
    network: { rssi: -58 },
    temperatures: {
      refrigerator: { connected: true, value: 18.25, raw: 18.0, offset: 0.25 },
      thermalWell: { connected: true, value: 18.5, raw: 18.5, offset: 0 },
    },
    control: {
      setpoint: 18,
      hysteresis: 0.5,
      state: "ESTAVEL",
      cooling: false,
      heating: false,
      compressorProtectionSeconds: 0,
      compressorProtectionDurationSeconds: 60,
    },
    profile: {
      active: false,
      paused: false,
      name: "",
      state: "INATIVO",
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

async function sendTelemetry(payload = telemetry(), suppliedToken = token): Promise<Response> {
  return exports.default.fetch("https://api.maltworks.com.br/v1/telemetry", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${suppliedToken}`,
      "X-Maltworks-Device-ID": deviceId,
      "X-Maltworks-Firmware": "5.0.0",
    },
    body: JSON.stringify(payload),
  });
}

describe("Maltworks Cloud API 5.10.0", () => {
  it("reports a healthy D1 binding", async () => {
    const response = await exports.default.fetch("https://api.maltworks.com.br/health");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, version: "5.10.0" });

    const preflight = await exports.default.fetch(
      "https://api.maltworks.com.br/v1/recipes/rcp_0123456789abcdef0123456789abcdef",
      {
        method: "OPTIONS",
        headers: { Origin: "https://app.maltworks.com.br" },
      },
    );
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("Access-Control-Allow-Methods")).toContain("PUT");

    const localPreflight = await exports.default.fetch("http://127.0.0.1:8787/v1/devices", {
      method: "OPTIONS",
      headers: {
        Origin: "http://127.0.0.1:8788",
        "Access-Control-Request-Method": "GET",
      },
    });
    expect(localPreflight.status).toBe(204);
    expect(localPreflight.headers.get("Access-Control-Allow-Origin")).toBe("http://127.0.0.1:8788");

    const productionRejectsLocalOrigin = await exports.default.fetch(
      "https://api.maltworks.com.br/v1/devices",
      {
        method: "OPTIONS",
        headers: {
          Origin: "http://127.0.0.1:8788",
          "Access-Control-Request-Method": "GET",
        },
      },
    );
    expect(productionRejectsLocalOrigin.status).toBe(403);
    expect(preflight.headers.get("Access-Control-Allow-Methods")).toContain("DELETE");
  });

  it("stores, normalizes and deduplicates public sales leads", async () => {
    const request = (body: Record<string, unknown>) => exports.default.fetch(
      "https://api.maltworks.com.br/v1/sales/leads",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://app.maltworks.com.br",
        },
        body: JSON.stringify(body),
      },
    );
    const lead = {
      name: "  Maria   da Silva  ",
      email: "MARIA@EXAMPLE.COM",
      phone: "(11) 99999-8888",
      consent: true,
      website: "",
    };

    const created = await request(lead);
    expect(created.status).toBe(202);
    expect(created.headers.get("Access-Control-Allow-Origin")).toBe("https://app.maltworks.com.br");
    expect(await created.json()).toMatchObject({ ok: true, accepted: true });

    const stored = await env.DB.prepare(
      `SELECT name, email, phone, status, notification_status AS notificationStatus
         FROM sales_leads WHERE email = ?1`,
    ).bind("maria@example.com").first<{
      name: string;
      email: string;
      phone: string;
      status: string;
      notificationStatus: string;
    }>();
    expect(stored).toEqual({
      name: "Maria da Silva",
      email: "maria@example.com",
      phone: "+5511999998888",
      status: "new",
      notificationStatus: "sent",
    });

    const duplicate = await request(lead);
    expect(duplicate.status).toBe(202);
    const count = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM sales_leads WHERE email = ?1",
    ).bind("maria@example.com").first<{ count: number }>();
    expect(count?.count).toBe(1);

    const missingConsent = await request({ ...lead, email: "outra@example.com", consent: false });
    expect(missingConsent.status).toBe(400);

    const honeypot = await request({ ...lead, email: "bot@example.com", website: "spam.example" });
    expect(honeypot.status).toBe(202);
    const bot = await env.DB.prepare(
      "SELECT id FROM sales_leads WHERE email = ?1",
    ).bind("bot@example.com").first<{ id: string }>();
    expect(bot).toBeNull();
  });

  it("registers a pending ESP32, authenticates it and deduplicates telemetry", async () => {
    const legacyTelemetry = telemetry();
    delete (legacyTelemetry.control as Record<string, unknown>).compressorProtectionDurationSeconds;
    delete (legacyTelemetry.alarms as Record<string, unknown>).summary;
    delete (legacyTelemetry.alarms as Record<string, unknown>).configuration;
    const first = await sendTelemetry(legacyTelemetry);
    expect(first.status).toBe(202);
    expect(await first.json()).toMatchObject({ ok: true, accepted: true, deviceStatus: "pending" });

    const credential = await env.DB.prepare(
      "SELECT token_hash AS tokenHash, pairing_code_hash AS pairingCodeHash FROM device_credentials WHERE device_id = ?1",
    ).bind(deviceId).first<{ tokenHash: string; pairingCodeHash: string }>();
    expect(credential?.tokenHash).toHaveLength(64);
    expect(credential?.tokenHash).not.toBe(token);
    expect(credential?.pairingCodeHash).toHaveLength(64);

    const duplicate = await sendTelemetry();
    expect(duplicate.status).toBe(200);
    const count = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM telemetry WHERE device_id = ?1",
    ).bind(deviceId).first<{ count: number }>();
    expect(count?.count).toBe(1);

    const wrongToken = await sendTelemetry(telemetry(2), "f".repeat(64));
    expect(wrongToken.status).toBe(401);
  });

  it("creates the first owner, claims the ESP32 and exposes its state", async () => {
    const bootstrap = await exports.default.fetch("https://api.maltworks.com.br/v1/auth/bootstrap", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test-bootstrap-secret-with-32-characters",
        Origin: "https://app.maltworks.com.br",
      },
      body: JSON.stringify({
        organizationName: "Maltworks",
        displayName: "Neto",
        email: "neto@example.com",
        password: "uma-senha-de-teste-forte",
      }),
    });
    expect(bootstrap.status).toBe(201);
    const cookie = bootstrap.headers.get("Set-Cookie")?.split(";", 1)[0];
    expect(cookie).toMatch(/^mw_session=/);

    const storedPassword = await env.DB.prepare(
      "SELECT password_hash AS passwordHash, password_iterations AS passwordIterations FROM users WHERE email = ?1",
    ).bind("neto@example.com").first<{ passwordHash: string; passwordIterations: number }>();
    expect(storedPassword?.passwordHash).toHaveLength(64);
    expect(storedPassword?.passwordHash).not.toContain("uma-senha-de-teste-forte");
    expect(storedPassword?.passwordIterations).toBe(100_000);

    const login = await exports.default.fetch("https://api.maltworks.com.br/v1/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://app.maltworks.com.br" },
      body: JSON.stringify({ email: "neto@example.com", password: "uma-senha-de-teste-forte" }),
    });
    expect(login.status).toBe(200);

    const claim = await exports.default.fetch("https://api.maltworks.com.br/v1/devices/claim", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie ?? "" },
      body: JSON.stringify({
        registrationToken: `${deviceId}-${token.slice(-16)}`,
        name: "Fermentador principal",
      }),
    });
    expect(claim.status).toBe(201);

    const devices = await exports.default.fetch("https://api.maltworks.com.br/v1/devices", {
      headers: { Cookie: cookie ?? "" },
    });
    expect(devices.status).toBe(200);
    expect(await devices.json()).toMatchObject({
      ok: true,
      devices: [{ id: deviceId, name: "Fermentador principal", status: "active", favorite: false }],
    });

    const updateDevice = await exports.default.fetch(
      `https://api.maltworks.com.br/v1/devices/${deviceId}`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json", Cookie: cookie ?? "" },
        body: JSON.stringify({ name: "Camara piloto", favorite: true }),
      },
    );
    expect(updateDevice.status).toBe(200);
    expect(await updateDevice.json()).toMatchObject({
      ok: true,
      device: { id: deviceId, name: "Camara piloto", favorite: true },
    });

    const updatedDevices = await exports.default.fetch("https://api.maltworks.com.br/v1/devices", {
      headers: { Cookie: cookie ?? "" },
    });
    expect(await updatedDevices.json()).toMatchObject({
      devices: [{ id: deviceId, name: "Camara piloto", favorite: true }],
    });

    const invalidFavorite = await exports.default.fetch(
      `https://api.maltworks.com.br/v1/devices/${deviceId}`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json", Cookie: cookie ?? "" },
        body: JSON.stringify({ favorite: "yes" }),
      },
    );
    expect(invalidFavorite.status).toBe(400);

    const invalidDeviceName = await exports.default.fetch(
      `https://api.maltworks.com.br/v1/devices/${deviceId}`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json", Cookie: cookie ?? "" },
        body: JSON.stringify({ name: 123 }),
      },
    );
    expect(invalidDeviceName.status).toBe(400);

    const latest = await exports.default.fetch(
      `https://api.maltworks.com.br/v1/devices/${deviceId}/latest`,
      { headers: { Cookie: cookie ?? "" } },
    );
    expect(latest.status).toBe(200);
    expect(await latest.json()).toMatchObject({
      ok: true,
      deviceId,
      state: { control: { setpoint: 18 } },
    });

    const rangedHistory = await exports.default.fetch(
      `https://api.maltworks.com.br/v1/devices/${deviceId}/telemetry?range=15&maxPoints=720`,
      { headers: { Cookie: cookie ?? "" } },
    );
    expect(rangedHistory.status).toBe(200);
    expect(await rangedHistory.json()).toMatchObject({
      ok: true,
      deviceId,
      range: "15",
      bucketSeconds: 1,
      totalPoints: 1,
      points: [{ refrigeratorValue: 18.25, setpoint: 18 }],
    });

    const invalidHistoryRange = await exports.default.fetch(
      `https://api.maltworks.com.br/v1/devices/${deviceId}/telemetry?range=10`,
      { headers: { Cookie: cookie ?? "" } },
    );
    expect(invalidHistoryRange.status).toBe(400);

    const createCommand = await exports.default.fetch(
      `https://api.maltworks.com.br/v1/devices/${deviceId}/commands/setpoint`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie ?? "" },
        body: JSON.stringify({ setpoint: 17.5 }),
      },
    );
    expect(createCommand.status).toBe(202);
    const createdCommand = await createCommand.json() as { command: { id: string } };
    expect(createdCommand.command.id).toMatch(/^cmd_[0-9a-f]{32}$/);

    const duplicateCommand = await exports.default.fetch(
      `https://api.maltworks.com.br/v1/devices/${deviceId}/commands/setpoint`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie ?? "" },
        body: JSON.stringify({ setpoint: 16.5 }),
      },
    );
    expect(duplicateCommand.status).toBe(409);

    const commandDelivery = await sendTelemetry(telemetry(2));
    expect(commandDelivery.status).toBe(200);
    expect(await commandDelivery.json()).toMatchObject({
      ok: true,
      command: {
        id: createdCommand.command.id,
        type: "set_setpoint",
        setpoint: 17.5,
      },
    });

    const acknowledgedTelemetry = telemetry(3);
    (acknowledgedTelemetry.control as Record<string, unknown>).setpoint = 17.5;
    acknowledgedTelemetry.commandResult = {
      id: createdCommand.command.id,
      status: "applied",
      appliedSetpoint: 17.5,
      message: "Setpoint remoto aplicado.",
    };
    const commandAcknowledgement = await sendTelemetry(acknowledgedTelemetry);
    expect(commandAcknowledgement.status).toBe(200);
    expect(await commandAcknowledgement.json()).toMatchObject({ ok: true, command: null });

    const latestAfterCommand = await exports.default.fetch(
      `https://api.maltworks.com.br/v1/devices/${deviceId}/latest`,
      { headers: { Cookie: cookie ?? "" } },
    );
    expect(latestAfterCommand.status).toBe(200);
    expect(await latestAfterCommand.json()).toMatchObject({
      state: { control: { setpoint: 17.5 } },
      latestCommand: {
        id: createdCommand.command.id,
        status: "applied",
        result: { appliedSetpoint: 17.5 },
      },
    });

    const configurationBody = {
      hysteresis: 0.7,
      compressorProtectionSeconds: 180,
      refrigeratorOffset: 0.25,
      thermalWellOffset: -0.15,
      sensorAlarmEnabled: true,
      highTemperatureEnabled: true,
      lowTemperatureEnabled: true,
      responseAlarmEnabled: true,
      highTemperatureLimit: 32,
      lowTemperatureLimit: -2,
      minimumExpectedChange: 0.4,
      responseTimeoutSeconds: 3600,
    };
    const invalidConfiguration = await exports.default.fetch(
      `https://api.maltworks.com.br/v1/devices/${deviceId}/commands/configuration`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie ?? "" },
        body: JSON.stringify({
          ...configurationBody,
          highTemperatureLimit: -5,
          lowTemperatureLimit: 5,
        }),
      },
    );
    expect(invalidConfiguration.status).toBe(400);

    const createConfiguration = await exports.default.fetch(
      `https://api.maltworks.com.br/v1/devices/${deviceId}/commands/configuration`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie ?? "" },
        body: JSON.stringify(configurationBody),
      },
    );
    expect(createConfiguration.status).toBe(202);
    const createdConfiguration = await createConfiguration.json() as {
      command: { id: string; payload: { configurationVersion: number } };
    };
    expect(createdConfiguration.command.payload.configurationVersion).toBe(1);

    const configurationDelivery = await sendTelemetry(telemetry(4));
    expect(configurationDelivery.status).toBe(200);
    expect(await configurationDelivery.json()).toMatchObject({
      command: {
        id: createdConfiguration.command.id,
        type: "set_configuration",
        configurationVersion: 1,
        hysteresis: 0.7,
        compressorProtectionSeconds: 180,
        refrigeratorOffset: 0.25,
        highTemperatureLimit: 32,
        responseTimeoutSeconds: 3600,
      },
    });

    const configurationAppliedTelemetry = telemetry(5);
    (configurationAppliedTelemetry.control as Record<string, unknown>).hysteresis = 0.7;
    (configurationAppliedTelemetry.control as Record<string, unknown>)
      .compressorProtectionDurationSeconds = 180;
    const appliedTemperatures = configurationAppliedTelemetry.temperatures as Record<string, Record<string, unknown>>;
    appliedTemperatures.refrigerator.offset = 0.25;
    appliedTemperatures.thermalWell.offset = -0.15;
    const appliedAlarms = configurationAppliedTelemetry.alarms as Record<string, unknown>;
    appliedAlarms.configuration = {
      sensorAlarmEnabled: true,
      highTemperatureEnabled: true,
      lowTemperatureEnabled: true,
      responseAlarmEnabled: true,
      highTemperatureLimit: 32,
      lowTemperatureLimit: -2,
      minimumExpectedChange: 0.4,
      responseTimeoutSeconds: 3600,
    };
    configurationAppliedTelemetry.commandResult = {
      id: createdConfiguration.command.id,
      status: "applied",
      appliedSetpoint: 17.5,
      message: "Configuracao cloud aplicada.",
    };
    const configurationAcknowledgement = await sendTelemetry(configurationAppliedTelemetry);
    expect(configurationAcknowledgement.status).toBe(200);

    const storedConfiguration = await env.DB.prepare(
      `SELECT version, status, compressor_protection_seconds AS compressorProtectionSeconds
         FROM device_configurations WHERE device_id = ?1`,
    ).bind(deviceId).first<{
      version: number;
      status: string;
      compressorProtectionSeconds: number;
    }>();
    expect(storedConfiguration).toMatchObject({
      version: 1,
      status: "applied",
      compressorProtectionSeconds: 180,
    });

    const acknowledgeAlarms = await exports.default.fetch(
      `https://api.maltworks.com.br/v1/devices/${deviceId}/commands/alarms`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie ?? "" },
        body: JSON.stringify({ action: "acknowledge" }),
      },
    );
    expect(acknowledgeAlarms.status).toBe(202);
    const acknowledgeBody = await acknowledgeAlarms.json() as { command: { id: string } };
    const alarmCommandDelivery = await sendTelemetry(telemetry(6));
    expect(await alarmCommandDelivery.json()).toMatchObject({
      command: {
        id: acknowledgeBody.command.id,
        type: "acknowledge_alarms",
      },
    });
    const alarmAcknowledgedTelemetry = telemetry(7);
    alarmAcknowledgedTelemetry.commandResult = {
      id: acknowledgeBody.command.id,
      status: "applied",
      appliedSetpoint: 17.5,
      message: "Alarmes reconhecidos pela nuvem.",
    };
    expect((await sendTelemetry(alarmAcknowledgedTelemetry)).status).toBe(200);

    const createRecipe = await exports.default.fetch(
      "https://api.maltworks.com.br/v1/recipes",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie ?? "" },
        body: JSON.stringify({
          name: "APA Cloud",
          description: "Perfil criado no painel.",
          stages: [
            { name: "Fermentacao", targetTemperature: 18, durationSeconds: 604800 },
            { name: "Descanso", targetTemperature: 20, durationSeconds: 172800 },
            { name: "Cold crash", targetTemperature: 2, durationSeconds: 86400 },
          ],
        }),
      },
    );
    expect(createRecipe.status).toBe(201);
    const createdRecipe = await createRecipe.json() as { recipe: { id: string } };
    expect(createdRecipe.recipe.id).toMatch(/^rcp_[0-9a-f]{32}$/);

    const recipes = await exports.default.fetch(
      "https://api.maltworks.com.br/v1/recipes",
      { headers: { Cookie: cookie ?? "" } },
    );
    expect(recipes.status).toBe(200);
    expect(await recipes.json()).toMatchObject({
      ok: true,
      recipes: [{
        id: createdRecipe.recipe.id,
        name: "APA Cloud",
        version: 1,
        stages: [
          { position: 0, targetTemperature: 18, durationSeconds: 604800 },
          { position: 1, targetTemperature: 20, durationSeconds: 172800 },
          { position: 2, targetTemperature: 2, durationSeconds: 86400 },
        ],
      }],
    });

    const startProfile = await exports.default.fetch(
      `https://api.maltworks.com.br/v1/devices/${deviceId}/commands/profile`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie ?? "" },
        body: JSON.stringify({ action: "start", recipeId: createdRecipe.recipe.id }),
      },
    );
    expect(startProfile.status).toBe(202);
    const startProfileBody = await startProfile.json() as { command: { id: string } };

    const profileDelivery = await sendTelemetry(telemetry(8));
    expect(profileDelivery.status).toBe(200);
    expect(await profileDelivery.json()).toMatchObject({
      command: {
        id: startProfileBody.command.id,
        type: "start_profile",
        profileName: "APA Cloud",
        stageCount: 3,
        stagePlan: "18.0,604800;20.0,172800;2.0,86400",
      },
    });

    const profileAppliedTelemetry = telemetry(9);
    profileAppliedTelemetry.profile = {
      active: true,
      paused: false,
      name: "APA Cloud",
      state: "EM EXECUCAO",
      stage: 0,
      stageCount: 3,
      remainingSeconds: 864000,
    };
    profileAppliedTelemetry.commandResult = {
      id: startProfileBody.command.id,
      status: "applied",
      appliedSetpoint: 18,
      message: "Perfil cloud iniciado.",
    };
    const profileAcknowledgement = await sendTelemetry(profileAppliedTelemetry);
    expect(profileAcknowledgement.status).toBe(200);

    const configurationDuringProfile = await exports.default.fetch(
      `https://api.maltworks.com.br/v1/devices/${deviceId}/commands/configuration`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie ?? "" },
        body: JSON.stringify(configurationBody),
      },
    );
    expect(configurationDuringProfile.status).toBe(409);

    const pauseProfile = await exports.default.fetch(
      `https://api.maltworks.com.br/v1/devices/${deviceId}/commands/profile`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie ?? "" },
        body: JSON.stringify({ action: "pause" }),
      },
    );
    expect(pauseProfile.status).toBe(202);

    const fermentationStartedAt = Math.floor(Date.now() / 1000) - 3600;
    const startFermentation = await exports.default.fetch(
      `https://api.maltworks.com.br/v1/devices/${deviceId}/fermentation`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie ?? "" },
        body: JSON.stringify({
          name: "APA lote 0002",
          originalGravity: 1.052,
          startedAt: fermentationStartedAt,
        }),
      },
    );
    expect(startFermentation.status).toBe(201);
    const startedFermentation = await startFermentation.json() as {
      fermentation: { id: string; active: boolean };
    };
    expect(startedFermentation.fermentation.id).toMatch(/^fer_[0-9a-f]{32}$/);
    expect(startedFermentation.fermentation.active).toBe(true);

    const duplicateFermentation = await exports.default.fetch(
      `https://api.maltworks.com.br/v1/devices/${deviceId}/fermentation`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie ?? "" },
        body: JSON.stringify({ name: "Outro lote", originalGravity: 1.048 }),
      },
    );
    expect(duplicateFermentation.status).toBe(409);

    const invalidGravity = await exports.default.fetch(
      `https://api.maltworks.com.br/v1/devices/${deviceId}/fermentation/readings`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie ?? "" },
        body: JSON.stringify({ gravity: 1.300 }),
      },
    );
    expect(invalidGravity.status).toBe(400);

    const firstGravityReading = await exports.default.fetch(
      `https://api.maltworks.com.br/v1/devices/${deviceId}/fermentation/readings`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie ?? "" },
        body: JSON.stringify({
          gravity: 1.030,
          measuredAt: fermentationStartedAt + 1800,
          note: "Primeira medicao manual",
        }),
      },
    );
    expect(firstGravityReading.status).toBe(201);
    const firstReadingBody = await firstGravityReading.json() as {
      fermentation: { readings: Array<{ id: string }> };
    };
    const firstReadingId = firstReadingBody.fermentation.readings[0]?.id;
    expect(firstReadingId).toMatch(/^grv_[0-9a-f]{32}$/);

    const secondGravityReading = await exports.default.fetch(
      `https://api.maltworks.com.br/v1/devices/${deviceId}/fermentation/readings`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie ?? "" },
        body: JSON.stringify({ gravity: 1.018, note: "Leitura atual" }),
      },
    );
    expect(secondGravityReading.status).toBe(201);

    const fermentationState = await exports.default.fetch(
      `https://api.maltworks.com.br/v1/devices/${deviceId}/fermentation`,
      { headers: { Cookie: cookie ?? "" } },
    );
    expect(fermentationState.status).toBe(200);
    expect(await fermentationState.json()).toMatchObject({
      fermentation: {
        name: "APA lote 0002",
        originalGravity: 1.052,
        active: true,
        readings: [
          { gravity: 1.030, note: "Primeira medicao manual" },
          { gravity: 1.018, note: "Leitura atual" },
        ],
      },
    });

    const deleteReading = await exports.default.fetch(
      `https://api.maltworks.com.br/v1/devices/${deviceId}/fermentation/readings/${firstReadingId ?? ""}`,
      { method: "DELETE", headers: { Cookie: cookie ?? "" } },
    );
    expect(deleteReading.status).toBe(200);
    expect(await deleteReading.json()).toMatchObject({
      deleted: true,
      fermentation: { readings: [{ gravity: 1.018 }] },
    });

    const finishFermentation = await exports.default.fetch(
      `https://api.maltworks.com.br/v1/devices/${deviceId}/fermentation/finish`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie ?? "" },
        body: "{}",
      },
    );
    expect(finishFermentation.status).toBe(200);
    expect(await finishFermentation.json()).toMatchObject({
      fermentation: { active: false, originalGravity: 1.052 },
    });

    const readingAfterFinish = await exports.default.fetch(
      `https://api.maltworks.com.br/v1/devices/${deviceId}/fermentation/readings`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie ?? "" },
        body: JSON.stringify({ gravity: 1.010 }),
      },
    );
    expect(readingAfterFinish.status).toBe(409);

    const nextFermentation = await exports.default.fetch(
      `https://api.maltworks.com.br/v1/devices/${deviceId}/fermentation`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie ?? "" },
        body: JSON.stringify({ name: "Lager lote 0003", originalGravity: 1.046 }),
      },
    );
    expect(nextFermentation.status).toBe(201);
    expect(await nextFermentation.json()).toMatchObject({
      fermentation: { name: "Lager lote 0003", originalGravity: 1.046, active: true },
    });

    const replacementToken = "fedcba9876543210".repeat(4);
    const requestCredentialRebind = await exports.default.fetch(
      "https://api.maltworks.com.br/v1/devices/claim",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie ?? "" },
        body: JSON.stringify({
          registrationToken: `${deviceId}-${replacementToken.slice(-16)}`,
          name: "Fermentador principal",
        }),
      },
    );
    expect(requestCredentialRebind.status).toBe(202);
    expect(await requestCredentialRebind.json()).toMatchObject({
      device: { id: deviceId, status: "reconnecting" },
    });

    const reauthenticatedTelemetry = await sendTelemetry(
      telemetry(99),
      replacementToken,
    );
    expect(reauthenticatedTelemetry.status).toBe(200);
    const rejectedOldCredential = await sendTelemetry(telemetry(100), token);
    expect(rejectedOldCredential.status).toBe(401);

    const unauthenticatedDelete = await exports.default.fetch(
      `https://api.maltworks.com.br/v1/devices/${deviceId}`,
      {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirmDeviceId: deviceId }),
      },
    );
    expect(unauthenticatedDelete.status).toBe(401);

    const unconfirmedDelete = await exports.default.fetch(
      `https://api.maltworks.com.br/v1/devices/${deviceId}`,
      {
        method: "DELETE",
        headers: { "Content-Type": "application/json", Cookie: cookie ?? "" },
        body: JSON.stringify({ confirmDeviceId: "MW-000000000000" }),
      },
    );
    expect(unconfirmedDelete.status).toBe(400);

    const deleteController = await exports.default.fetch(
      `https://api.maltworks.com.br/v1/devices/${deviceId}`,
      {
        method: "DELETE",
        headers: { "Content-Type": "application/json", Cookie: cookie ?? "" },
        body: JSON.stringify({ confirmDeviceId: deviceId }),
      },
    );
    expect(deleteController.status).toBe(200);
    expect(await deleteController.json()).toMatchObject({
      ok: true,
      deleted: true,
      readyForRegistration: true,
      device: { id: deviceId, name: "Fermentador principal" },
    });

    const deletedDevice = await env.DB.prepare(
      "SELECT id FROM devices WHERE id = ?1",
    ).bind(deviceId).first();
    const deletedCredential = await env.DB.prepare(
      "SELECT device_id FROM device_credentials WHERE device_id = ?1",
    ).bind(deviceId).first();
    const deletedTelemetry = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM telemetry WHERE device_id = ?1",
    ).bind(deviceId).first<{ count: number }>();
    const deletedLatestState = await env.DB.prepare(
      "SELECT device_id FROM device_latest_state WHERE device_id = ?1",
    ).bind(deviceId).first();
    const deletedConfiguration = await env.DB.prepare(
      "SELECT device_id FROM device_configurations WHERE device_id = ?1",
    ).bind(deviceId).first();
    const deletedCommands = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM device_commands WHERE device_id = ?1",
    ).bind(deviceId).first<{ count: number }>();
    const deletedFermentations = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM fermentation_sessions WHERE device_id = ?1",
    ).bind(deviceId).first<{ count: number }>();
    const deletedFermentationReadings = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM fermentation_readings",
    ).first<{ count: number }>();
    const deletionAudit = await env.DB.prepare(
      `SELECT device_id AS deviceId, details_json AS detailsJson
         FROM audit_log
        WHERE organization_id IS NOT NULL AND action = 'device.deleted'
        ORDER BY id DESC LIMIT 1`,
    ).first<{ deviceId: string | null; detailsJson: string }>();
    expect(deletedDevice).toBeNull();
    expect(deletedCredential).toBeNull();
    expect(deletedTelemetry?.count).toBe(0);
    expect(deletedLatestState).toBeNull();
    expect(deletedConfiguration).toBeNull();
    expect(deletedCommands?.count).toBe(0);
    expect(deletedFermentations?.count).toBe(0);
    expect(deletedFermentationReadings?.count).toBe(0);
    expect(deletionAudit?.deviceId).toBeNull();
    expect(JSON.parse(deletionAudit?.detailsJson ?? "{}")).toMatchObject({
      deviceId,
      name: "Fermentador principal",
    });

    const pendingAgain = await sendTelemetry(telemetry(101), replacementToken);
    expect(pendingAgain.status).toBe(202);
    expect(await pendingAgain.json()).toMatchObject({
      ok: true,
      deviceStatus: "pending",
    });

    const claimAgain = await exports.default.fetch(
      "https://api.maltworks.com.br/v1/devices/claim",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie ?? "" },
        body: JSON.stringify({
          registrationToken: `${deviceId}-${replacementToken.slice(-16)}`,
          name: "Fermentador recadastrado",
        }),
      },
    );
    expect(claimAgain.status).toBe(201);
    expect(await claimAgain.json()).toMatchObject({
      device: { id: deviceId, name: "Fermentador recadastrado", status: "active" },
    });

    const rejectedReset = await exports.default.fetch(
      "https://api.maltworks.com.br/v1/auth/recovery/reset-password",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer segredo-incorreto",
        },
        body: JSON.stringify({
          email: "neto@example.com",
          newPassword: "uma-nova-senha-de-teste-forte",
        }),
      },
    );
    expect(rejectedReset.status).toBe(401);

    const reset = await exports.default.fetch(
      "https://api.maltworks.com.br/v1/auth/recovery/reset-password",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer test-password-reset-secret-with-32-characters",
        },
        body: JSON.stringify({
          email: "neto@example.com",
          newPassword: "uma-nova-senha-de-teste-forte",
        }),
      },
    );
    expect(reset.status).toBe(200);
    expect(await reset.json()).toMatchObject({
      ok: true,
      passwordReset: true,
      sessionsRevoked: true,
    });

    const oldPasswordLogin = await exports.default.fetch(
      "https://api.maltworks.com.br/v1/auth/login",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: "neto@example.com",
          password: "uma-senha-de-teste-forte",
        }),
      },
    );
    expect(oldPasswordLogin.status).toBe(401);

    const newPasswordLogin = await exports.default.fetch(
      "https://api.maltworks.com.br/v1/auth/login",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: "neto@example.com",
          password: "uma-nova-senha-de-teste-forte",
        }),
      },
    );
    expect(newPasswordLogin.status).toBe(200);

    const portalMe = await exports.default.fetch(
      "https://api.maltworks.com.br/v1/me",
      { headers: { Cookie: newPasswordLogin.headers.get("Set-Cookie")?.split(";", 1)[0] ?? "" } },
    );
    expect(portalMe.status).toBe(200);
    expect(await portalMe.json()).toMatchObject({
      user: { email: "neto@example.com", memberships: [{ role: "owner" }] },
      capabilities: { systemAdmin: true },
    });

    const adminMe = await exports.default.fetch(
      "https://api.maltworks.com.br/v1/admin/me",
      { headers: { Cookie: newPasswordLogin.headers.get("Set-Cookie")?.split(";", 1)[0] ?? "" } },
    );
    expect(adminMe.status).toBe(200);
    expect(await adminMe.json()).toMatchObject({
      ok: true,
      admin: { displayName: "Neto", role: "superadmin" },
    });

    const adminUsers = await exports.default.fetch(
      "https://api.maltworks.com.br/v1/admin/users?page=1&limit=25",
      { headers: { Cookie: newPasswordLogin.headers.get("Set-Cookie")?.split(";", 1)[0] ?? "" } },
    );
    expect(adminUsers.status).toBe(200);
    const adminUsersBody = await adminUsers.json() as {
      users: Array<Record<string, unknown>>;
      privacy: { personalDataIncluded: boolean };
    };
    expect(adminUsersBody.users).toHaveLength(1);
    expect(adminUsersBody.users[0]).not.toHaveProperty("email");
    expect(adminUsersBody.users[0]).not.toHaveProperty("displayName");
    expect(adminUsersBody.privacy.personalDataIncluded).toBe(false);

    const adminOverview = await exports.default.fetch(
      "https://api.maltworks.com.br/v1/admin/overview",
      { headers: { Cookie: newPasswordLogin.headers.get("Set-Cookie")?.split(";", 1)[0] ?? "" } },
    );
    expect(adminOverview.status).toBe(200);
    expect(await adminOverview.json()).toMatchObject({
      ok: true,
      overview: { users: 1, organizations: 1, devices: 1 },
    });

    const authenticatedCookie = newPasswordLogin.headers.get("Set-Cookie")?.split(";", 1)[0] ?? "";
    const notificationBaseline = telemetry(102);
    expect((await sendTelemetry(notificationBaseline, replacementToken)).status).toBe(200);

    const incidentTelemetry = telemetry(103);
    incidentTelemetry.alarms = {
      ...(incidentTelemetry.alarms as Record<string, unknown>),
      active: true,
      unacknowledged: true,
      count: 2,
      summary: "Falha de sensor e temperatura alta",
    };
    (incidentTelemetry.temperatures as Record<string, Record<string, unknown>>).thermalWell = {
      connected: false,
      value: null,
      raw: null,
      offset: 0,
    };
    incidentTelemetry.profile = {
      active: true,
      paused: false,
      name: "APA Cloud",
      state: "EXECUTANDO",
      stage: 0,
      stageCount: 3,
      remainingSeconds: 3_600,
    };
    expect((await sendTelemetry(incidentTelemetry, replacementToken)).status).toBe(200);

    const recoveredTelemetry = telemetry(104);
    recoveredTelemetry.profile = {
      active: true,
      paused: false,
      name: "APA Cloud",
      state: "EXECUTANDO",
      stage: 1,
      stageCount: 3,
      remainingSeconds: 1_800,
    };
    expect((await sendTelemetry(recoveredTelemetry, replacementToken)).status).toBe(200);

    const offlineCheckNow = Math.floor(Date.now() / 1_000);
    await env.DB.prepare("UPDATE devices SET last_seen_at = ?1 WHERE id = ?2")
      .bind(offlineCheckNow - 90, deviceId).run();
    await scanOfflineDevices(env);
    const prematureOfflineNotification = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM notifications WHERE device_id = ?1 AND type = 'device_offline'",
    ).bind(deviceId).first<{ count: number }>();
    expect(prematureOfflineNotification?.count).toBe(0);

    await env.DB.prepare("UPDATE devices SET last_seen_at = ?1 WHERE id = ?2")
      .bind(offlineCheckNow - 180, deviceId).run();
    await scanOfflineDevices(env);
    expect((await sendTelemetry(telemetry(105), replacementToken)).status).toBe(200);

    const notificationList = await exports.default.fetch(
      "https://api.maltworks.com.br/v1/notifications?limit=20",
      { headers: { Cookie: authenticatedCookie } },
    );
    expect(notificationList.status).toBe(200);
    const notificationBody = await notificationList.json() as {
      notifications: Array<{ id: string; type: string; message: string; isRead: boolean }>;
      unreadCount: number;
    };
    expect(notificationBody.unreadCount).toBeGreaterThanOrEqual(7);
    expect(notificationBody.notifications.map((item) => item.type)).toEqual(expect.arrayContaining([
      "alarm_activated",
      "alarm_resolved",
      "sensor_disconnected",
      "sensor_reconnected",
      "profile_stage_changed",
      "device_offline",
      "device_online",
    ]));
    expect(notificationBody.notifications.find((item) => item.type === "device_offline")?.message)
      .toContain("mais de 2 minutos");

    const defaultPreferences = await exports.default.fetch(
      "https://api.maltworks.com.br/v1/notifications/preferences",
      { headers: { Cookie: authenticatedCookie } },
    );
    expect(await defaultPreferences.json()).toMatchObject({
      preferences: { emailEnabled: false, alarmEvents: true, deviceEvents: true },
    });
    const updatePreferences = await exports.default.fetch(
      "https://api.maltworks.com.br/v1/notifications/preferences",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json", Cookie: authenticatedCookie },
        body: JSON.stringify({
          emailEnabled: true,
          deviceEvents: true,
          sensorEvents: true,
          alarmEvents: true,
          profileEvents: false,
          commandEvents: true,
        }),
      },
    );
    expect(updatePreferences.status).toBe(200);
    expect(await updatePreferences.json()).toMatchObject({
      preferences: { emailEnabled: true, profileEvents: false },
    });

    const firstNotificationId = notificationBody.notifications[0]?.id ?? "";
    const markRead = await exports.default.fetch(
      `https://api.maltworks.com.br/v1/notifications/${firstNotificationId}/read`,
      { method: "POST", headers: { Cookie: authenticatedCookie } },
    );
    expect(markRead.status).toBe(200);
    const markAllRead = await exports.default.fetch(
      "https://api.maltworks.com.br/v1/notifications/read-all",
      { method: "POST", headers: { Cookie: authenticatedCookie } },
    );
    expect(await markAllRead.json()).toMatchObject({ ok: true, unreadCount: 0 });

    const deleteOneNotification = await exports.default.fetch(
      `https://api.maltworks.com.br/v1/notifications/${firstNotificationId}`,
      { method: "DELETE", headers: { Cookie: authenticatedCookie } },
    );
    expect(deleteOneNotification.status).toBe(200);
    const afterDeleteOne = await exports.default.fetch(
      "https://api.maltworks.com.br/v1/notifications?limit=20",
      { headers: { Cookie: authenticatedCookie } },
    );
    const afterDeleteOneBody = await afterDeleteOne.json() as { notifications: Array<{ id: string }> };
    expect(afterDeleteOneBody.notifications.some((item) => item.id === firstNotificationId)).toBe(false);

    const deleteAllNotifications = await exports.default.fetch(
      "https://api.maltworks.com.br/v1/notifications",
      { method: "DELETE", headers: { Cookie: authenticatedCookie } },
    );
    expect(await deleteAllNotifications.json()).toMatchObject({ ok: true, unreadCount: 0 });
    const afterDeleteAll = await exports.default.fetch(
      "https://api.maltworks.com.br/v1/notifications?limit=20",
      { headers: { Cookie: authenticatedCookie } },
    );
    expect(await afterDeleteAll.json()).toMatchObject({ notifications: [], unreadCount: 0 });

    await env.DB.prepare("DELETE FROM system_admins WHERE user_id = (SELECT id FROM users LIMIT 1)").run();
    const forbiddenAdmin = await exports.default.fetch(
      "https://api.maltworks.com.br/v1/admin/overview",
      { headers: { Cookie: newPasswordLogin.headers.get("Set-Cookie")?.split(";", 1)[0] ?? "" } },
    );
    expect(forbiddenAdmin.status).toBe(403);
    expect(await forbiddenAdmin.json()).toMatchObject({
      ok: false,
      error: { code: "SYSTEM_ADMIN_REQUIRED" },
    });
  });

  it("creates a customer account with an empty controller list", async () => {
    const signup = await exports.default.fetch(
      "https://api.maltworks.com.br/v1/auth/signup",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://app.maltworks.com.br",
        },
        body: JSON.stringify({
          displayName: "Maria da Silva",
          birthDate: "1990-05-10",
          phone: "(11) 99999-8888",
          email: "maria.cliente@example.com",
          password: "uma-senha-segura-de-cliente",
          termsAccepted: true,
        }),
      },
    );
    expect(signup.status).toBe(201);
    expect(signup.headers.get("Access-Control-Allow-Origin")).toBe("https://app.maltworks.com.br");
    const signupBody = await signup.json();
    expect(signupBody).toMatchObject({
      ok: true,
      user: {
        displayName: "Maria da Silva",
        birthDate: "1990-05-10",
        phone: "+5511999998888",
      },
    });

    const cookie = signup.headers.get("Set-Cookie")?.split(";", 1)[0] ?? "";
    const me = await exports.default.fetch("https://api.maltworks.com.br/v1/me", {
      headers: { Cookie: cookie },
    });
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({
      user: { email: "maria.cliente@example.com", memberships: [{ role: "owner" }] },
      capabilities: { systemAdmin: false },
    });

    const devices = await exports.default.fetch("https://api.maltworks.com.br/v1/devices", {
      headers: { Cookie: cookie },
    });
    expect(devices.status).toBe(200);
    expect(await devices.json()).toMatchObject({ devices: [] });

    const duplicate = await exports.default.fetch(
      "https://api.maltworks.com.br/v1/auth/signup",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          displayName: "Outra Maria",
          birthDate: "1992-02-20",
          email: "MARIA.CLIENTE@example.com",
          password: "outra-senha-segura-de-cliente",
          termsAccepted: true,
        }),
      },
    );
    expect(duplicate.status).toBe(409);

    const underage = await exports.default.fetch(
      "https://api.maltworks.com.br/v1/auth/signup",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          displayName: "Cliente Menor",
          birthDate: "2012-01-01",
          email: "menor@example.com",
          password: "senha-segura-nao-utilizada",
          termsAccepted: true,
        }),
      },
    );
    expect(underage.status).toBe(400);
    expect(await underage.json()).toMatchObject({
      error: { code: "MINIMUM_AGE_REQUIRED" },
    });
  });
});
