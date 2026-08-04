import { constantTimeEqual, isHex, sha256Hex } from "./crypto";
import { nextCommandForDevice, processCommandResult } from "./commands";
import { getBearerToken, jsonResponse, readJson } from "./http";
import { ApiError, type CommandResult, type SensorTelemetry, type TelemetryPayload } from "./types";

const DEVICE_ID_PATTERN = /^MW-[0-9A-F]{12}$/;
const BOOT_ID_PATTERN = /^[0-9A-F]{8}$/;

export async function ingestTelemetry(request: Request, env: Env, requestId: string): Promise<Response> {
  const headerDeviceId = (request.headers.get("X-Maltworks-Device-ID") ?? "").toUpperCase();
  if (!DEVICE_ID_PATTERN.test(headerDeviceId)) {
    throw new ApiError(400, "INVALID_DEVICE_ID", "Device ID ausente ou invalido.");
  }

  const token = getBearerToken(request) ?? "";
  if (!isHex(token, 64)) {
    throw new ApiError(401, "INVALID_DEVICE_TOKEN", "Token do dispositivo ausente ou invalido.");
  }

  const raw = await readJson(request, 16_384);
  const payload = validateTelemetry(raw);
  if (payload.deviceId !== headerDeviceId) {
    throw new ApiError(400, "DEVICE_ID_MISMATCH", "O Device ID do cabecalho difere do JSON.");
  }

  const now = Math.floor(Date.now() / 1000);
  const tokenHash = await sha256Hex(token.toLowerCase());
  const pairingCodeHash = await sha256Hex(token.slice(-8).toLowerCase());
  const registeredNow = await ensurePendingDevice(
    env.DB,
    payload,
    tokenHash,
    pairingCodeHash,
    now,
  );

  const credential = await env.DB.prepare(
    `SELECT d.status, c.token_hash AS tokenHash
       FROM devices d
       JOIN device_credentials c ON c.device_id = d.id
      WHERE d.id = ?1`,
  ).bind(payload.deviceId).first<{ status: string; tokenHash: string }>();

  if (!credential || !constantTimeEqual(credential.tokenHash, tokenHash)) {
    throw new ApiError(401, "DEVICE_AUTHENTICATION_FAILED", "Credencial do dispositivo rejeitada.");
  }
  if (credential.status === "disabled") {
    throw new ApiError(403, "DEVICE_DISABLED", "Este dispositivo esta desabilitado.");
  }

  const payloadJson = JSON.stringify(payload);
  const statements = [
    env.DB.prepare(
      `INSERT INTO telemetry (
        device_id, boot_id, sequence, received_at, sent_at, uptime_seconds,
        refrigerator_connected, refrigerator_value, refrigerator_raw, refrigerator_offset,
        thermal_well_connected, thermal_well_value, thermal_well_raw, thermal_well_offset,
        setpoint, hysteresis, control_state, cooling, heating, compressor_protection_seconds,
        profile_active, profile_paused, profile_name, profile_state, profile_stage,
        profile_stage_count, profile_remaining_seconds, alarms_active,
        alarms_unacknowledged, alarms_count, rssi, firmware_product, firmware_version,
        firmware_phase, payload_json
      ) VALUES (
        ?1, ?2, ?3, ?4, ?5, ?6,
        ?7, ?8, ?9, ?10,
        ?11, ?12, ?13, ?14,
        ?15, ?16, ?17, ?18, ?19, ?20,
        ?21, ?22, ?23, ?24, ?25,
        ?26, ?27, ?28,
        ?29, ?30, ?31, ?32, ?33,
        ?34, ?35
      ) ON CONFLICT(device_id, boot_id, sequence) DO NOTHING`,
    ).bind(
      payload.deviceId,
      payload.bootId,
      payload.sequence,
      now,
      payload.sentAt,
      payload.uptimeSeconds,
      boolInt(payload.temperatures.refrigerator.connected),
      payload.temperatures.refrigerator.value,
      payload.temperatures.refrigerator.raw,
      payload.temperatures.refrigerator.offset,
      boolInt(payload.temperatures.thermalWell.connected),
      payload.temperatures.thermalWell.value,
      payload.temperatures.thermalWell.raw,
      payload.temperatures.thermalWell.offset,
      payload.control.setpoint,
      payload.control.hysteresis,
      payload.control.state,
      boolInt(payload.control.cooling),
      boolInt(payload.control.heating),
      payload.control.compressorProtectionSeconds,
      boolInt(payload.profile.active),
      boolInt(payload.profile.paused),
      payload.profile.name,
      payload.profile.state,
      payload.profile.stage,
      payload.profile.stageCount,
      payload.profile.remainingSeconds,
      boolInt(payload.alarms.active),
      boolInt(payload.alarms.unacknowledged),
      payload.alarms.count,
      payload.network.rssi,
      payload.firmware.product,
      payload.firmware.version,
      payload.firmware.phase,
      payloadJson,
    ),
    env.DB.prepare(
      `UPDATE devices
          SET last_seen_at = ?2,
              firmware_version = ?3,
              updated_at = ?2
        WHERE id = ?1`,
    ).bind(payload.deviceId, now, payload.firmware.version),
    env.DB.prepare(
      `INSERT INTO device_latest_state (
        device_id, received_at, sent_at, boot_id, sequence,
        refrigerator_value, thermal_well_value, setpoint,
        control_state, cooling, heating, alarms_active,
        rssi, firmware_version, state_json
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)
      ON CONFLICT(device_id) DO UPDATE SET
        received_at = excluded.received_at,
        sent_at = excluded.sent_at,
        boot_id = excluded.boot_id,
        sequence = excluded.sequence,
        refrigerator_value = excluded.refrigerator_value,
        thermal_well_value = excluded.thermal_well_value,
        setpoint = excluded.setpoint,
        control_state = excluded.control_state,
        cooling = excluded.cooling,
        heating = excluded.heating,
        alarms_active = excluded.alarms_active,
        rssi = excluded.rssi,
        firmware_version = excluded.firmware_version,
        state_json = excluded.state_json`,
    ).bind(
      payload.deviceId,
      now,
      payload.sentAt,
      payload.bootId,
      payload.sequence,
      payload.temperatures.refrigerator.value,
      payload.temperatures.thermalWell.value,
      payload.control.setpoint,
      payload.control.state,
      boolInt(payload.control.cooling),
      boolInt(payload.control.heating),
      boolInt(payload.alarms.active),
      payload.network.rssi,
      payload.firmware.version,
      payloadJson,
    ),
  ];

  await env.DB.batch(statements);
  if (payload.commandResult) {
    await processCommandResult(env.DB, payload.deviceId, payload.commandResult, now);
  }
  const command = await nextCommandForDevice(env.DB, payload.deviceId, now);
  return jsonResponse(
    {
      ok: true,
      accepted: true,
      deviceStatus: registeredNow ? "pending" : credential.status,
      serverTime: now,
      command,
      requestId,
    },
    registeredNow ? 202 : 200,
  );
}

async function ensurePendingDevice(
  db: D1Database,
  payload: TelemetryPayload,
  tokenHash: string,
  pairingCodeHash: string,
  now: number,
): Promise<boolean> {
  const existing = await db.prepare("SELECT id FROM devices WHERE id = ?1")
    .bind(payload.deviceId)
    .first<{ id: string }>();
  if (existing) return false;

  await db.batch([
    db.prepare(
      `INSERT INTO devices (
        id, organization_id, name, status, firmware_version,
        first_seen_at, last_seen_at, claimed_at, created_at, updated_at
      ) VALUES (?1, NULL, ?1, 'pending', ?2, ?3, ?3, NULL, ?3, ?3)
      ON CONFLICT(id) DO NOTHING`,
    ).bind(payload.deviceId, payload.firmware.version, now),
    db.prepare(
      `INSERT INTO device_credentials (
        device_id, token_hash, pairing_code_hash, created_at, rotated_at
      ) VALUES (?1, ?2, ?3, ?4, NULL)
      ON CONFLICT(device_id) DO NOTHING`,
    ).bind(payload.deviceId, tokenHash, pairingCodeHash, now),
  ]);
  return true;
}

export function validateTelemetry(value: unknown): TelemetryPayload {
  const root = objectValue(value, "telemetry");
  const firmware = objectValue(root.firmware, "firmware");
  const network = objectValue(root.network, "network");
  const temperatures = objectValue(root.temperatures, "temperatures");
  const control = objectValue(root.control, "control");
  const profile = objectValue(root.profile, "profile");
  const alarms = objectValue(root.alarms, "alarms");
  const alarmConfiguration = alarms.configuration === undefined
    ? null
    : objectValue(alarms.configuration, "alarms.configuration");

  const schemaVersion = integerValue(root.schemaVersion, "schemaVersion", 1, 1);
  const deviceId = stringValue(root.deviceId, "deviceId", 32).toUpperCase();
  const bootId = stringValue(root.bootId, "bootId", 8).toUpperCase();
  if (!DEVICE_ID_PATTERN.test(deviceId)) invalid("deviceId");
  if (!BOOT_ID_PATTERN.test(bootId)) invalid("bootId");

  const commandResult = root.commandResult === undefined
    ? undefined
    : commandResultValue(root.commandResult);

  return {
    schemaVersion: schemaVersion as 1,
    deviceId,
    bootId,
    sequence: integerValue(root.sequence, "sequence", 1, 4_294_967_295),
    sentAt: integerValue(root.sentAt, "sentAt", 0, 4_294_967_295),
    uptimeSeconds: integerValue(root.uptimeSeconds, "uptimeSeconds", 0, 4_294_967_295),
    firmware: {
      product: stringValue(firmware.product, "firmware.product", 64),
      version: stringValue(firmware.version, "firmware.version", 24),
      phase: stringValue(firmware.phase, "firmware.phase", 64),
    },
    network: {
      rssi: numberValue(network.rssi, "network.rssi", -150, 20),
    },
    temperatures: {
      refrigerator: sensorValue(temperatures.refrigerator, "temperatures.refrigerator"),
      thermalWell: sensorValue(temperatures.thermalWell, "temperatures.thermalWell"),
    },
    control: {
      setpoint: numberValue(control.setpoint, "control.setpoint", -60, 100),
      hysteresis: numberValue(control.hysteresis, "control.hysteresis", 0, 30),
      state: stringValue(control.state, "control.state", 48),
      cooling: booleanValue(control.cooling, "control.cooling"),
      heating: booleanValue(control.heating, "control.heating"),
      compressorProtectionSeconds: integerValue(
        control.compressorProtectionSeconds,
        "control.compressorProtectionSeconds",
        0,
        86_400,
      ),
      compressorProtectionDurationSeconds: control.compressorProtectionDurationSeconds === undefined
        ? 60
        : integerValue(
          control.compressorProtectionDurationSeconds,
          "control.compressorProtectionDurationSeconds",
          60,
          900,
        ),
    },
    profile: {
      active: booleanValue(profile.active, "profile.active"),
      paused: booleanValue(profile.paused, "profile.paused"),
      name: stringValue(profile.name, "profile.name", 96, true),
      state: stringValue(profile.state, "profile.state", 48),
      stage: integerValue(profile.stage, "profile.stage", 0, 255),
      stageCount: integerValue(profile.stageCount, "profile.stageCount", 0, 255),
      remainingSeconds: integerValue(profile.remainingSeconds, "profile.remainingSeconds", 0, 31_536_000),
    },
    alarms: {
      active: booleanValue(alarms.active, "alarms.active"),
      unacknowledged: booleanValue(alarms.unacknowledged, "alarms.unacknowledged"),
      count: integerValue(alarms.count, "alarms.count", 0, 255),
      summary: alarms.summary === undefined
        ? (booleanValue(alarms.active, "alarms.active") ? "Alarme ativo" : "Nenhum alarme")
        : stringValue(alarms.summary, "alarms.summary", 120, true),
      configuration: alarmConfiguration
        ? {
          sensorAlarmEnabled: booleanValue(
            alarmConfiguration.sensorAlarmEnabled,
            "alarms.configuration.sensorAlarmEnabled",
          ),
          highTemperatureEnabled: booleanValue(
            alarmConfiguration.highTemperatureEnabled,
            "alarms.configuration.highTemperatureEnabled",
          ),
          lowTemperatureEnabled: booleanValue(
            alarmConfiguration.lowTemperatureEnabled,
            "alarms.configuration.lowTemperatureEnabled",
          ),
          responseAlarmEnabled: booleanValue(
            alarmConfiguration.responseAlarmEnabled,
            "alarms.configuration.responseAlarmEnabled",
          ),
          highTemperatureLimit: numberValue(
            alarmConfiguration.highTemperatureLimit,
            "alarms.configuration.highTemperatureLimit",
            -30,
            60,
          ),
          lowTemperatureLimit: numberValue(
            alarmConfiguration.lowTemperatureLimit,
            "alarms.configuration.lowTemperatureLimit",
            -30,
            60,
          ),
          minimumExpectedChange: numberValue(
            alarmConfiguration.minimumExpectedChange,
            "alarms.configuration.minimumExpectedChange",
            0.1,
            10,
          ),
          responseTimeoutSeconds: integerValue(
            alarmConfiguration.responseTimeoutSeconds,
            "alarms.configuration.responseTimeoutSeconds",
            60,
            86_400,
          ),
        }
        : {
          sensorAlarmEnabled: true,
          highTemperatureEnabled: true,
          lowTemperatureEnabled: true,
          responseAlarmEnabled: true,
          highTemperatureLimit: 35,
          lowTemperatureLimit: -5,
          minimumExpectedChange: 0.5,
          responseTimeoutSeconds: 5_400,
        },
    },
    ...(commandResult ? { commandResult } : {}),
  };
}

function commandResultValue(value: unknown): CommandResult {
  const result = objectValue(value, "commandResult");
  const id = stringValue(result.id, "commandResult.id", 36);
  if (!/^cmd_[0-9a-f]{32}$/.test(id)) invalid("commandResult.id");
  const status = stringValue(result.status, "commandResult.status", 8);
  if (status !== "applied" && status !== "rejected") invalid("commandResult.status");
  return {
    id,
    status,
    appliedSetpoint: numberValue(result.appliedSetpoint, "commandResult.appliedSetpoint", -10, 40),
    message: stringValue(result.message, "commandResult.message", 160, true),
  };
}

function sensorValue(value: unknown, path: string): SensorTelemetry {
  const sensor = objectValue(value, path);
  const connected = booleanValue(sensor.connected, `${path}.connected`);
  const measured = nullableNumberValue(sensor.value, `${path}.value`, -100, 150);
  const raw = nullableNumberValue(sensor.raw, `${path}.raw`, -100, 150);
  if (connected && (measured === null || raw === null)) invalid(path);
  return {
    connected,
    value: measured,
    raw,
    offset: numberValue(sensor.offset, `${path}.offset`, -30, 30),
  };
}

function objectValue(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(path);
  return value as Record<string, unknown>;
}

function stringValue(value: unknown, path: string, maxLength: number, allowEmpty = false): string {
  if (typeof value !== "string" || value.length > maxLength || (!allowEmpty && value.length === 0)) invalid(path);
  return value;
}

function booleanValue(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") invalid(path);
  return value;
}

function numberValue(value: unknown, path: string, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) invalid(path);
  return value;
}

function nullableNumberValue(
  value: unknown,
  path: string,
  minimum: number,
  maximum: number,
): number | null {
  if (value === null) return null;
  return numberValue(value, path, minimum, maximum);
}

function integerValue(value: unknown, path: string, minimum: number, maximum: number): number {
  const result = numberValue(value, path, minimum, maximum);
  if (!Number.isInteger(result)) invalid(path);
  return result;
}

function invalid(path: string): never {
  throw new ApiError(400, "INVALID_TELEMETRY", `Campo de telemetria invalido: ${path}.`);
}

function boolInt(value: boolean): number {
  return value ? 1 : 0;
}
