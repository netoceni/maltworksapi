import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import "../src/index";

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

describe("Maltworks Cloud API 5.4.0", () => {
  it("reports a healthy D1 binding", async () => {
    const response = await exports.default.fetch("https://api.maltworks.com.br/health");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, version: "5.4.0" });

    const preflight = await exports.default.fetch(
      "https://api.maltworks.com.br/v1/recipes/rcp_0123456789abcdef0123456789abcdef",
      {
        method: "OPTIONS",
        headers: { Origin: "https://app.maltworks.com.br" },
      },
    );
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("Access-Control-Allow-Methods")).toContain("PUT");
    expect(preflight.headers.get("Access-Control-Allow-Methods")).toContain("DELETE");
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
        deviceId,
        pairingCode: token.slice(-8),
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
      devices: [{ id: deviceId, name: "Fermentador principal", status: "active" }],
    });

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
  });
});
