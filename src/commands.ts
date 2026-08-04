import { requireSession, selectOrganization } from "./auth";
import { jsonResponse, readJson } from "./http";
import { recipeById } from "./recipes";
import { ApiError, type CommandResult, type SessionContext } from "./types";

const DEVICE_ID_PATTERN = /^MW-[0-9A-F]{12}$/;
const RECIPE_ID_PATTERN = /^rcp_[0-9a-f]{32}$/;
const COMMAND_ID_PATTERN = /^cmd_[0-9a-f]{32}$/;
const COMMAND_TTL_SECONDS = 120;
const ONLINE_WINDOW_SECONDS = 65;

type CommandStatus = "pending" | "delivered" | "applied" | "rejected" | "expired";
type CommandType =
  | "set_setpoint"
  | "start_profile"
  | "pause_profile"
  | "resume_profile"
  | "stop_profile"
  | "set_configuration"
  | "acknowledge_alarms";

interface DeviceConfigurationPayload {
  configurationVersion: number;
  hysteresis: number;
  compressorProtectionSeconds: number;
  refrigeratorOffset: number;
  thermalWellOffset: number;
  sensorAlarmEnabled: boolean;
  highTemperatureEnabled: boolean;
  lowTemperatureEnabled: boolean;
  responseAlarmEnabled: boolean;
  highTemperatureLimit: number;
  lowTemperatureLimit: number;
  minimumExpectedChange: number;
  responseTimeoutSeconds: number;
}

interface CommandRow {
  id: string;
  type: CommandType;
  payloadJson: string;
  status: CommandStatus;
  createdAt: number;
  expiresAt: number;
  deliveredAt: number | null;
  completedAt: number | null;
  resultJson: string | null;
}

interface DeviceContext {
  session: SessionContext;
  organizationId: string;
  deviceId: string;
  now: number;
  profile: {
    active: boolean;
    paused: boolean;
    name: string;
    state: string;
  };
}

export async function createSetpointCommand(
  request: Request,
  env: Env,
  requestId: string,
  deviceId: string,
): Promise<Response> {
  const raw = objectValue(await readJson(request));
  const context = await deviceContext(request, env, deviceId, raw.organizationId);
  if (context.profile.active) {
    throw new ApiError(
      409,
      "PROFILE_ACTIVE",
      "Interrompa o perfil ativo antes de alterar manualmente o setpoint.",
    );
  }
  const setpoint = normalizedSetpoint(raw.setpoint);
  return queueCommand(
    env.DB,
    context,
    "set_setpoint",
    { setpoint },
    requestId,
  );
}

export async function createProfileCommand(
  request: Request,
  env: Env,
  requestId: string,
  deviceId: string,
): Promise<Response> {
  const raw = objectValue(await readJson(request));
  const context = await deviceContext(request, env, deviceId, raw.organizationId);
  const action = typeof raw.action === "string" ? raw.action.trim().toLowerCase() : "";

  if (action === "start") {
    if (context.profile.active) {
      throw new ApiError(409, "PROFILE_ALREADY_ACTIVE", "Ja existe um perfil ativo no controlador.");
    }
    const recipeId = typeof raw.recipeId === "string" ? raw.recipeId.trim() : "";
    if (!RECIPE_ID_PATTERN.test(recipeId)) {
      throw new ApiError(400, "INVALID_RECIPE_ID", "Selecione uma receita valida.");
    }
    const recipe = await recipeById(env.DB, recipeId, context.organizationId);
    if (!recipe) throw new ApiError(404, "RECIPE_NOT_FOUND", "Receita nao encontrada.");
    const stagePlan = recipe.stages
      .map((stage) => `${stage.targetTemperature.toFixed(1)},${stage.durationSeconds}`)
      .join(";");
    return queueCommand(
      env.DB,
      context,
      "start_profile",
      {
        recipeId: recipe.id,
        recipeVersion: recipe.version,
        profileName: recipe.name,
        stageCount: recipe.stages.length,
        stagePlan,
      },
      requestId,
    );
  }

  if (action === "pause") {
    if (!context.profile.active || context.profile.paused) {
      throw new ApiError(409, "PROFILE_NOT_RUNNING", "O perfil nao esta em execucao.");
    }
    return queueCommand(env.DB, context, "pause_profile", {}, requestId);
  }

  if (action === "resume") {
    if (!context.profile.active || !context.profile.paused) {
      throw new ApiError(409, "PROFILE_NOT_PAUSED", "O perfil nao esta pausado.");
    }
    return queueCommand(env.DB, context, "resume_profile", {}, requestId);
  }

  if (action === "stop") {
    if (!context.profile.active) {
      throw new ApiError(409, "PROFILE_NOT_ACTIVE", "Nao existe perfil ativo para interromper.");
    }
    return queueCommand(env.DB, context, "stop_profile", {}, requestId);
  }

  throw new ApiError(400, "INVALID_PROFILE_ACTION", "Acao de perfil invalida.");
}

export async function createConfigurationCommand(
  request: Request,
  env: Env,
  requestId: string,
  deviceId: string,
): Promise<Response> {
  const raw = objectValue(await readJson(request));
  const context = await deviceContext(request, env, deviceId, raw.organizationId);
  if (context.profile.active) {
    throw new ApiError(
      409,
      "PROFILE_ACTIVE",
      "Interrompa o perfil ativo antes de alterar a configuracao do controlador.",
    );
  }

  const current = await env.DB.prepare(
    "SELECT version FROM device_configurations WHERE device_id = ?1 AND organization_id = ?2",
  ).bind(context.deviceId, context.organizationId).first<{ version: number }>();
  const configuration = normalizedConfiguration(raw, (current?.version ?? 0) + 1);

  return queueCommand(
    env.DB,
    context,
    "set_configuration",
    { ...configuration },
    requestId,
    (commandId) => [
      env.DB.prepare(
        `INSERT INTO device_configurations (
           device_id, organization_id, version, status, hysteresis,
           compressor_protection_seconds, refrigerator_offset, thermal_well_offset,
           sensor_alarm_enabled, high_temperature_enabled, low_temperature_enabled,
           response_alarm_enabled, high_temperature_limit, low_temperature_limit,
           minimum_expected_change, response_timeout_seconds, last_command_id,
           updated_by_user_id, updated_at, applied_at
         ) VALUES (
           ?1, ?2, ?3, 'pending', ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11,
           ?12, ?13, ?14, ?15, ?16, ?17, ?18, NULL
         ) ON CONFLICT(device_id) DO UPDATE SET
           organization_id = excluded.organization_id,
           version = excluded.version,
           status = 'pending',
           hysteresis = excluded.hysteresis,
           compressor_protection_seconds = excluded.compressor_protection_seconds,
           refrigerator_offset = excluded.refrigerator_offset,
           thermal_well_offset = excluded.thermal_well_offset,
           sensor_alarm_enabled = excluded.sensor_alarm_enabled,
           high_temperature_enabled = excluded.high_temperature_enabled,
           low_temperature_enabled = excluded.low_temperature_enabled,
           response_alarm_enabled = excluded.response_alarm_enabled,
           high_temperature_limit = excluded.high_temperature_limit,
           low_temperature_limit = excluded.low_temperature_limit,
           minimum_expected_change = excluded.minimum_expected_change,
           response_timeout_seconds = excluded.response_timeout_seconds,
           last_command_id = excluded.last_command_id,
           updated_by_user_id = excluded.updated_by_user_id,
           updated_at = excluded.updated_at,
           applied_at = NULL`,
      ).bind(
        context.deviceId,
        context.organizationId,
        configuration.configurationVersion,
        configuration.hysteresis,
        configuration.compressorProtectionSeconds,
        configuration.refrigeratorOffset,
        configuration.thermalWellOffset,
        boolInt(configuration.sensorAlarmEnabled),
        boolInt(configuration.highTemperatureEnabled),
        boolInt(configuration.lowTemperatureEnabled),
        boolInt(configuration.responseAlarmEnabled),
        configuration.highTemperatureLimit,
        configuration.lowTemperatureLimit,
        configuration.minimumExpectedChange,
        configuration.responseTimeoutSeconds,
        commandId,
        context.session.userId,
        context.now,
      ),
    ],
  );
}

export async function createAlarmCommand(
  request: Request,
  env: Env,
  requestId: string,
  deviceId: string,
): Promise<Response> {
  const raw = objectValue(await readJson(request));
  const context = await deviceContext(request, env, deviceId, raw.organizationId);
  const action = typeof raw.action === "string" ? raw.action.trim().toLowerCase() : "";
  if (action !== "acknowledge") {
    throw new ApiError(400, "INVALID_ALARM_ACTION", "Acao de alarme invalida.");
  }
  return queueCommand(env.DB, context, "acknowledge_alarms", {}, requestId);
}

export async function nextCommandForDevice(
  db: D1Database,
  deviceId: string,
  now: number,
): Promise<Record<string, unknown> | null> {
  const row = await db.prepare(
    `SELECT id, type, payload_json AS payloadJson, status, expires_at AS expiresAt
       FROM device_commands
      WHERE device_id = ?1 AND status IN ('pending', 'delivered')
      ORDER BY created_at ASC LIMIT 1`,
  ).bind(deviceId).first<{
    id: string;
    type: CommandType;
    payloadJson: string;
    status: "pending" | "delivered";
    expiresAt: number;
  }>();
  if (!row) return null;

  if (row.expiresAt <= now) {
    await expireCommand(db, row.id, now);
    return null;
  }

  if (row.status === "pending") {
    await db.prepare(
      `UPDATE device_commands
          SET status = 'delivered', delivered_at = COALESCE(delivered_at, ?2)
        WHERE id = ?1 AND status = 'pending'`,
    ).bind(row.id, now).run();
  }

  const payload = parseObject(row.payloadJson);
  const command: Record<string, unknown> = {
    id: row.id,
    type: row.type,
    expiresAt: row.expiresAt,
  };
  if (row.type === "set_setpoint") {
    command.setpoint = payload.setpoint;
  } else if (row.type === "start_profile") {
    command.recipeId = payload.recipeId;
    command.recipeVersion = payload.recipeVersion;
    command.profileName = payload.profileName;
    command.stageCount = payload.stageCount;
    command.stagePlan = payload.stagePlan;
  } else if (row.type === "set_configuration") {
    command.configurationVersion = payload.configurationVersion;
    command.hysteresis = payload.hysteresis;
    command.compressorProtectionSeconds = payload.compressorProtectionSeconds;
    command.refrigeratorOffset = payload.refrigeratorOffset;
    command.thermalWellOffset = payload.thermalWellOffset;
    command.sensorAlarmEnabled = payload.sensorAlarmEnabled;
    command.highTemperatureEnabled = payload.highTemperatureEnabled;
    command.lowTemperatureEnabled = payload.lowTemperatureEnabled;
    command.responseAlarmEnabled = payload.responseAlarmEnabled;
    command.highTemperatureLimit = payload.highTemperatureLimit;
    command.lowTemperatureLimit = payload.lowTemperatureLimit;
    command.minimumExpectedChange = payload.minimumExpectedChange;
    command.responseTimeoutSeconds = payload.responseTimeoutSeconds;
  }
  return command;
}

export async function processCommandResult(
  db: D1Database,
  deviceId: string,
  result: CommandResult,
  now: number,
): Promise<void> {
  if (!COMMAND_ID_PATTERN.test(result.id)) {
    throw new ApiError(400, "INVALID_COMMAND_RESULT", "Identificador de comando invalido.");
  }
  const command = await db.prepare(
    `SELECT status, organization_id AS organizationId, type, payload_json AS payloadJson
       FROM device_commands
      WHERE id = ?1 AND device_id = ?2`,
  ).bind(result.id, deviceId).first<{
    status: CommandStatus;
    organizationId: string;
    type: CommandType;
    payloadJson: string;
  }>();
  if (!command || command.status === result.status) return;
  if (command.status !== "pending" && command.status !== "delivered") return;

  const resultJson = JSON.stringify({
    appliedSetpoint: result.appliedSetpoint,
    message: result.message,
  });
  const update = await db.prepare(
    `UPDATE device_commands
        SET status = ?3, completed_at = ?4, result_json = ?5
      WHERE id = ?1 AND device_id = ?2 AND status IN ('pending', 'delivered')`,
  ).bind(result.id, deviceId, result.status, now, resultJson).run();

  if ((update.meta.changes ?? 0) === 1) {
    const commandPayload = parseObject(command.payloadJson);
    if (command.type === "set_configuration") {
      await db.prepare(
        `UPDATE device_configurations
            SET status = ?3,
                applied_at = CASE WHEN ?3 = 'applied' THEN ?4 ELSE NULL END
          WHERE device_id = ?1 AND last_command_id = ?2`,
      ).bind(deviceId, result.id, result.status, now).run();
    }

    await db.prepare(
      `INSERT INTO audit_log (
         organization_id, user_id, device_id, action, details_json, created_at
       ) VALUES (?1, NULL, ?2, ?3, ?4, ?5)`,
    ).bind(
      command.organizationId,
      deviceId,
      result.status === "applied" ? "device.command_applied" : "device.command_rejected",
      JSON.stringify({
        commandId: result.id,
        type: command.type,
        ...(command.type === "set_configuration"
          ? { configurationVersion: commandPayload.configurationVersion }
          : {}),
        ...JSON.parse(resultJson) as Record<string, unknown>,
      }),
      now,
    ).run();
  }
}

export async function latestCommandForDevice(
  db: D1Database,
  deviceId: string,
  organizationId: string,
  now: number,
): Promise<Record<string, unknown> | null> {
  const row = await db.prepare(
    `SELECT id, type, payload_json AS payloadJson, status,
            created_at AS createdAt, expires_at AS expiresAt,
            delivered_at AS deliveredAt, completed_at AS completedAt,
            result_json AS resultJson
       FROM device_commands
      WHERE device_id = ?1 AND organization_id = ?2
      ORDER BY created_at DESC LIMIT 1`,
  ).bind(deviceId, organizationId).first<CommandRow>();
  if (!row) return null;

  if (
    (row.status === "pending" || row.status === "delivered") &&
    row.expiresAt <= now
  ) {
    await expireCommand(db, row.id, now);
    row.status = "expired";
    row.completedAt = now;
    row.resultJson = JSON.stringify({ message: "Prazo de confirmacao esgotado." });
  }
  return {
    id: row.id,
    type: row.type,
    status: row.status,
    payload: parseObject(row.payloadJson),
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    deliveredAt: row.deliveredAt,
    completedAt: row.completedAt,
    result: row.resultJson ? parseObject(row.resultJson) : null,
  };
}

export async function expireActiveCommands(
  db: D1Database,
  deviceId: string,
  now: number,
): Promise<void> {
  const active = await db.prepare(
    `SELECT id, expires_at AS expiresAt
       FROM device_commands
      WHERE device_id = ?1 AND status IN ('pending', 'delivered')
      ORDER BY created_at ASC LIMIT 1`,
  ).bind(deviceId).first<{ id: string; expiresAt: number }>();
  if (active && active.expiresAt <= now) await expireCommand(db, active.id, now);
}

async function deviceContext(
  request: Request,
  env: Env,
  deviceId: string,
  requestedOrganizationId: unknown,
): Promise<DeviceContext> {
  const normalizedDeviceId = deviceId.toUpperCase();
  if (!DEVICE_ID_PATTERN.test(normalizedDeviceId)) {
    throw new ApiError(400, "INVALID_DEVICE_ID", "Device ID invalido.");
  }
  const session = await requireSession(request, env);
  const organizationId = selectOrganization(session, requestedOrganizationId);
  const membership = session.memberships.find((item) => item.organizationId === organizationId);
  if (!membership || membership.role === "viewer") {
    throw new ApiError(403, "DEVICE_CONTROL_DENIED", "Seu perfil nao pode controlar dispositivos.");
  }
  const now = Math.floor(Date.now() / 1000);
  const device = await env.DB.prepare(
    `SELECT d.status, d.last_seen_at AS lastSeenAt, s.state_json AS stateJson
       FROM devices d
       LEFT JOIN device_latest_state s ON s.device_id = d.id
      WHERE d.id = ?1 AND d.organization_id = ?2`,
  ).bind(normalizedDeviceId, organizationId).first<{
    status: string;
    lastSeenAt: number;
    stateJson: string | null;
  }>();
  if (!device) throw new ApiError(404, "DEVICE_NOT_FOUND", "Controlador nao encontrado.");
  if (device.status !== "active") {
    throw new ApiError(409, "DEVICE_NOT_ACTIVE", "O controlador nao esta ativo.");
  }
  if (now - device.lastSeenAt > ONLINE_WINDOW_SECONDS) {
    throw new ApiError(409, "DEVICE_OFFLINE", "O controlador esta offline. Aguarde a reconexao.");
  }
  return {
    session,
    organizationId,
    deviceId: normalizedDeviceId,
    now,
    profile: profileState(device.stateJson),
  };
}

async function queueCommand(
  db: D1Database,
  context: DeviceContext,
  type: CommandType,
  payload: Record<string, unknown>,
  requestId: string,
  additionalStatements: (
    commandId: string,
    expiresAt: number,
  ) => D1PreparedStatement[] = () => [],
): Promise<Response> {
  await expireActiveCommands(db, context.deviceId, context.now);
  const active = await db.prepare(
    `SELECT id FROM device_commands
      WHERE device_id = ?1 AND status IN ('pending', 'delivered') AND expires_at > ?2
      ORDER BY created_at ASC LIMIT 1`,
  ).bind(context.deviceId, context.now).first<{ id: string }>();
  if (active) {
    throw new ApiError(
      409,
      "COMMAND_IN_PROGRESS",
      "Ja existe um comando aguardando confirmacao do controlador.",
    );
  }

  const commandId = `cmd_${crypto.randomUUID().replaceAll("-", "")}`;
  const expiresAt = context.now + COMMAND_TTL_SECONDS;
  try {
    await db.batch([
      db.prepare(
        `INSERT INTO device_commands (
           id, device_id, organization_id, created_by_user_id, type, payload_json,
           status, created_at, expires_at, delivered_at, completed_at, result_json
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'pending', ?7, ?8, NULL, NULL, NULL)`,
      ).bind(
        commandId,
        context.deviceId,
        context.organizationId,
        context.session.userId,
        type,
        JSON.stringify(payload),
        context.now,
        expiresAt,
      ),
      db.prepare(
        `INSERT INTO audit_log (
           organization_id, user_id, device_id, action, details_json, created_at
         ) VALUES (?1, ?2, ?3, 'device.command_created', ?4, ?5)`,
      ).bind(
        context.organizationId,
        context.session.userId,
        context.deviceId,
        JSON.stringify({ commandId, type, ...payload }),
        context.now,
      ),
      ...additionalStatements(commandId, expiresAt),
    ]);
  } catch (error) {
    if (error instanceof Error && error.message.toLowerCase().includes("unique")) {
      throw new ApiError(
        409,
        "COMMAND_IN_PROGRESS",
        "Ja existe um comando aguardando confirmacao do controlador.",
      );
    }
    throw error;
  }

  return jsonResponse(
    {
      ok: true,
      command: {
        id: commandId,
        type,
        status: "pending",
        payload,
        createdAt: context.now,
        expiresAt,
      },
      requestId,
    },
    202,
  );
}

async function expireCommand(db: D1Database, commandId: string, now: number): Promise<void> {
  await db.batch([
    db.prepare(
      `UPDATE device_commands
          SET status = 'expired', completed_at = ?2,
              result_json = '{"message":"Prazo de confirmacao esgotado."}'
        WHERE id = ?1 AND status IN ('pending', 'delivered')`,
    ).bind(commandId, now),
    db.prepare(
      `UPDATE device_configurations
          SET status = 'rejected', applied_at = NULL
        WHERE last_command_id = ?1 AND status = 'pending'`,
    ).bind(commandId),
  ]);
}

function normalizedSetpoint(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < -10 || value > 40) {
    throw new ApiError(400, "INVALID_SETPOINT", "O setpoint deve estar entre -10,0 e 40,0 C.");
  }
  const rounded = Math.round(value * 10) / 10;
  if (Math.abs(value - rounded) > 0.000_001) {
    throw new ApiError(400, "INVALID_SETPOINT", "Use no maximo uma casa decimal no setpoint.");
  }
  return rounded;
}

function normalizedConfiguration(
  raw: Record<string, unknown>,
  version: number,
): DeviceConfigurationPayload {
  const configuration: DeviceConfigurationPayload = {
    configurationVersion: version,
    hysteresis: decimalValue(raw.hysteresis, "hysteresis", 0.1, 5, 1),
    compressorProtectionSeconds: integerField(
      raw.compressorProtectionSeconds,
      "compressorProtectionSeconds",
      60,
      900,
    ),
    refrigeratorOffset: decimalValue(raw.refrigeratorOffset, "refrigeratorOffset", -10, 10, 2),
    thermalWellOffset: decimalValue(raw.thermalWellOffset, "thermalWellOffset", -10, 10, 2),
    sensorAlarmEnabled: booleanField(raw.sensorAlarmEnabled, "sensorAlarmEnabled"),
    highTemperatureEnabled: booleanField(raw.highTemperatureEnabled, "highTemperatureEnabled"),
    lowTemperatureEnabled: booleanField(raw.lowTemperatureEnabled, "lowTemperatureEnabled"),
    responseAlarmEnabled: booleanField(raw.responseAlarmEnabled, "responseAlarmEnabled"),
    highTemperatureLimit: decimalValue(raw.highTemperatureLimit, "highTemperatureLimit", -30, 60, 1),
    lowTemperatureLimit: decimalValue(raw.lowTemperatureLimit, "lowTemperatureLimit", -30, 60, 1),
    minimumExpectedChange: decimalValue(raw.minimumExpectedChange, "minimumExpectedChange", 0.1, 10, 1),
    responseTimeoutSeconds: integerField(
      raw.responseTimeoutSeconds,
      "responseTimeoutSeconds",
      60,
      86_400,
    ),
  };
  if (configuration.highTemperatureLimit <= configuration.lowTemperatureLimit) {
    throw new ApiError(
      400,
      "INVALID_CONFIGURATION",
      "O limite de temperatura alta deve ser maior que o limite de temperatura baixa.",
    );
  }
  if (configuration.responseTimeoutSeconds % 60 !== 0) {
    throw new ApiError(
      400,
      "INVALID_CONFIGURATION",
      "O tempo de resposta termica deve usar minutos inteiros.",
    );
  }
  return configuration;
}

function decimalValue(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number,
  decimals: number,
): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new ApiError(400, "INVALID_CONFIGURATION", `Campo de configuracao invalido: ${field}.`);
  }
  const factor = 10 ** decimals;
  const rounded = Math.round(value * factor) / factor;
  if (Math.abs(value - rounded) > 0.000_001) {
    throw new ApiError(400, "INVALID_CONFIGURATION", `Casas decimais invalidas: ${field}.`);
  }
  return rounded;
}

function integerField(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number,
): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum || value > maximum) {
    throw new ApiError(400, "INVALID_CONFIGURATION", `Campo de configuracao invalido: ${field}.`);
  }
  return value;
}

function booleanField(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw new ApiError(400, "INVALID_CONFIGURATION", `Campo de configuracao invalido: ${field}.`);
  }
  return value;
}

function profileState(stateJson: string | null): DeviceContext["profile"] {
  const fallback = { active: false, paused: false, name: "", state: "PARADO" };
  if (!stateJson) return fallback;
  try {
    const parsed = JSON.parse(stateJson) as {
      profile?: { active?: unknown; paused?: unknown; name?: unknown; state?: unknown };
    };
    return {
      active: parsed.profile?.active === true,
      paused: parsed.profile?.paused === true,
      name: typeof parsed.profile?.name === "string" ? parsed.profile.name : "",
      state: typeof parsed.profile?.state === "string" ? parsed.profile.state : "PARADO",
    };
  } catch {
    return fallback;
  }
}

function objectValue(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(400, "INVALID_BODY", "O corpo da requisicao e invalido.");
  }
  return value as Record<string, unknown>;
}

function parseObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function boolInt(value: boolean): number {
  return value ? 1 : 0;
}
