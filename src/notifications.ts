import { requireSession, selectOrganization } from "./auth";
import { randomId } from "./crypto";
import { jsonResponse, readJson } from "./http";
import { ApiError, type TelemetryPayload } from "./types";

export const OFFLINE_AFTER_SECONDS = 30;
const NOTIFICATION_ID_PATTERN = /^ntf_[0-9a-f]{32}$/u;
const CATEGORIES = ["device", "sensor", "alarm", "profile", "command"] as const;

type NotificationCategory = typeof CATEGORIES[number];
type NotificationSeverity = "info" | "success" | "warning" | "critical";

interface PreviousDeviceState {
  organizationId: string | null;
  name: string;
  lastSeenAt: number;
  bootId: string | null;
  sequence: number | null;
  stateJson: string | null;
}

interface NotificationInput {
  organizationId: string;
  deviceId: string | null;
  eventKey: string;
  category: NotificationCategory;
  type: string;
  severity: NotificationSeverity;
  title: string;
  message: string;
  data?: Record<string, unknown>;
}

export async function recordFirmwareAvailableNotifications(
  env: Env,
  release: { id: string; product: string; version: string; boardFamily: string },
  now: number,
): Promise<{ createdIds: string[]; organizationIds: string[] }> {
  const rows = await env.DB.prepare(
    `SELECT organization_id AS organizationId, firmware_version AS firmwareVersion
       FROM devices
      WHERE organization_id IS NOT NULL AND status = 'active'`,
  ).all<{ organizationId: string; firmwareVersion: string }>();
  const organizations = new Set<string>();
  for (const device of rows.results) {
    if (compareFirmwareVersions(release.version, device.firmwareVersion) > 0) {
      organizations.add(device.organizationId);
    }
  }

  const created: string[] = [];
  for (const organizationId of organizations) {
    created.push(...await createOne(env.DB, {
      organizationId,
      deviceId: null,
      eventKey: `firmware:${release.id}:${organizationId}`,
      category: "device",
      type: "firmware_available",
      severity: "info",
      title: `Firmware ${release.version} disponivel`,
      message: "Uma nova versao do controlador esta pronta. Abra Dispositivo para verificar e iniciar a atualizacao.",
      data: {
        releaseId: release.id,
        product: release.product,
        version: release.version,
        boardFamily: release.boardFamily,
      },
    }, now));
  }
  return { createdIds: created, organizationIds: [...organizations] };
}

function compareFirmwareVersions(left: string, right: string): number {
  const a = left.split(/[.-]/u).slice(0, 3).map(Number);
  const b = right.split(/[.-]/u).slice(0, 3).map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

interface StoredNotification {
  id: string;
  organizationId: string;
  deviceId: string | null;
  deviceName: string | null;
  category: NotificationCategory;
  type: string;
  severity: NotificationSeverity;
  title: string;
  message: string;
  createdAt: number;
}

export async function previousDeviceState(
  db: D1Database,
  deviceId: string,
): Promise<PreviousDeviceState | null> {
  return db.prepare(
    `SELECT d.organization_id AS organizationId, d.name, d.last_seen_at AS lastSeenAt,
            s.boot_id AS bootId, s.sequence, s.state_json AS stateJson
       FROM devices d
       LEFT JOIN device_latest_state s ON s.device_id = d.id
      WHERE d.id = ?1`,
  ).bind(deviceId).first<PreviousDeviceState>();
}

export async function recordTelemetryNotifications(
  env: Env,
  payload: TelemetryPayload,
  previous: PreviousDeviceState | null,
  now: number,
): Promise<string[]> {
  if (!previous?.organizationId) return [];
  if (previous.bootId === payload.bootId && previous.sequence === payload.sequence) return [];

  const created: string[] = [];
  const oldState = parseTelemetry(previous.stateJson);
  const base = `${payload.deviceId}:${payload.bootId}:${payload.sequence}`;
  const deviceName = previous.name;

  if (oldState) {
    if (!oldState.alarms.active && payload.alarms.active) {
      created.push(...await createOne(env.DB, {
        organizationId: previous.organizationId,
        deviceId: payload.deviceId,
        eventKey: `${base}:alarm:active`,
        category: "alarm",
        type: "alarm_activated",
        severity: "critical",
        title: `Alarme em ${deviceName}`,
        message: payload.alarms.summary || `${payload.alarms.count} alarme(s) ativo(s).`,
        data: { count: payload.alarms.count },
      }, now));
    } else if (oldState.alarms.active && !payload.alarms.active) {
      created.push(...await createOne(env.DB, {
        organizationId: previous.organizationId,
        deviceId: payload.deviceId,
        eventKey: `${base}:alarm:resolved`,
        category: "alarm",
        type: "alarm_resolved",
        severity: "success",
        title: `Alarmes normalizados em ${deviceName}`,
        message: "O controlador informou que não há alarmes ativos.",
      }, now));
    }

    await sensorTransition(env.DB, created, previous.organizationId, payload, oldState, now, "refrigerator", "Sensor da geladeira", deviceName, base);
    await sensorTransition(env.DB, created, previous.organizationId, payload, oldState, now, "thermalWell", "Sensor do poço térmico", deviceName, base);

    if (payload.profile.active && oldState.profile.active && payload.profile.stage !== oldState.profile.stage) {
      created.push(...await createOne(env.DB, {
        organizationId: previous.organizationId,
        deviceId: payload.deviceId,
        eventKey: `${base}:profile:stage:${payload.profile.stage}`,
        category: "profile",
        type: "profile_stage_changed",
        severity: "info",
        title: `Nova etapa em ${deviceName}`,
        message: `${payload.profile.name || "Receita"}: etapa ${payload.profile.stage + 1} de ${payload.profile.stageCount}.`,
        data: { stage: payload.profile.stage, stageCount: payload.profile.stageCount, profileName: payload.profile.name },
      }, now));
    }
    if (oldState.profile.active && !payload.profile.active) {
      const completed = payload.profile.state.toUpperCase().includes("CONCLUIDO");
      created.push(...await createOne(env.DB, {
        organizationId: previous.organizationId,
        deviceId: payload.deviceId,
        eventKey: `${base}:profile:completed`,
        category: "profile",
        type: completed ? "profile_completed" : "profile_stopped",
        severity: completed ? "success" : "info",
        title: `Perfil ${completed ? "concluído" : "encerrado"} em ${deviceName}`,
        message: `${oldState.profile.name || "A receita"} deixou de estar em execução.`,
      }, now));
    }
  }

  if (payload.commandResult?.status === "rejected") {
    created.push(...await createOne(env.DB, {
      organizationId: previous.organizationId,
      deviceId: payload.deviceId,
      eventKey: `command:${payload.commandResult.id}:rejected`,
      category: "command",
      type: "command_rejected",
      severity: "warning",
      title: `Comando rejeitado por ${deviceName}`,
      message: payload.commandResult.message || "O controlador rejeitou um comando remoto.",
      data: { commandId: payload.commandResult.id },
    }, now));
  }

  const offlineState = await env.DB.prepare(
    "SELECT active FROM notification_states WHERE device_id = ?1 AND type = 'offline'",
  ).bind(payload.deviceId).first<{ active: number }>();
  if (offlineState?.active === 1) {
    await setState(env.DB, payload.deviceId, "offline", false, now, `${base}:device:online`);
    created.push(...await createOne(env.DB, {
      organizationId: previous.organizationId,
      deviceId: payload.deviceId,
      eventKey: `${base}:device:online`,
      category: "device",
      type: "device_online",
      severity: "success",
      title: `${deviceName} voltou a ficar online`,
      message: "A comunicação com o controlador foi restabelecida.",
    }, now));
  }

  return created;
}

export async function scanOfflineDevices(env: Env): Promise<string[]> {
  const now = Math.floor(Date.now() / 1_000);
  const rows = await env.DB.prepare(
    `SELECT d.id, d.organization_id AS organizationId, d.name, d.last_seen_at AS lastSeenAt,
            COALESCE(ns.active, 0) AS offlineActive
       FROM devices d
       LEFT JOIN notification_states ns ON ns.device_id = d.id AND ns.type = 'offline'
      WHERE d.organization_id IS NOT NULL
        AND d.status = 'active'
        AND d.last_seen_at <= ?1`,
  ).bind(now - OFFLINE_AFTER_SECONDS).all<{
    id: string;
    organizationId: string;
    name: string;
    lastSeenAt: number;
    offlineActive: number;
  }>();

  const created: string[] = [];
  const changedOrganizations = new Set<string>();
  for (const device of rows.results) {
    if (device.offlineActive === 1) continue;

    const notificationIds = await recordOfflineDevice(env, device.id, now);
    created.push(...notificationIds);
    if (notificationIds.length) changedOrganizations.add(device.organizationId);
  }
  await deliverNotificationEmails(env, created);
  return [...changedOrganizations];
}

export async function recordOfflineDevice(
  env: Env,
  deviceId: string,
  now = Math.floor(Date.now() / 1_000),
): Promise<string[]> {
  const device = await env.DB.prepare(
    `SELECT d.id, d.organization_id AS organizationId, d.name,
            d.last_seen_at AS lastSeenAt, COALESCE(ns.active, 0) AS offlineActive
       FROM devices d
       LEFT JOIN notification_states ns ON ns.device_id = d.id AND ns.type = 'offline'
      WHERE d.id = ?1 AND d.organization_id IS NOT NULL AND d.status = 'active'`,
  ).bind(deviceId).first<{
    id: string;
    organizationId: string;
    name: string;
    lastSeenAt: number;
    offlineActive: number;
  }>();
  if (!device || device.offlineActive === 1 || now - device.lastSeenAt < OFFLINE_AFTER_SECONDS) {
    return [];
  }

  const eventKey = `${device.id}:offline:${device.lastSeenAt}`;
  await setState(env.DB, device.id, "offline", true, now, eventKey);
  return createOne(env.DB, {
    organizationId: device.organizationId,
    deviceId: device.id,
    eventKey,
    category: "device",
    type: "device_offline",
    severity: "critical",
    title: `${device.name} está offline`,
    message: `Nenhuma comunicação recebida há mais de ${OFFLINE_AFTER_SECONDS} segundos.`,
    data: { lastSeenAt: device.lastSeenAt },
  }, now);
}

export async function listNotifications(request: Request, env: Env, requestId: string): Promise<Response> {
  const session = await requireSession(request, env);
  const url = new URL(request.url);
  const organizationId = selectOrganization(session, url.searchParams.get("organizationId"));
  const requestedLimit = Number.parseInt(url.searchParams.get("limit") ?? "30", 10);
  const limit = Number.isFinite(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 100) : 30;
  const unreadOnly = url.searchParams.get("unreadOnly") === "true";

  const rows = await env.DB.prepare(
    `SELECT n.id, n.device_id AS deviceId, d.name AS deviceName,
            n.category, n.type, n.severity, n.title, n.message,
            n.data_json AS dataJson, n.created_at AS createdAt,
            CASE WHEN nr.notification_id IS NULL THEN 0 ELSE 1 END AS isRead
       FROM notifications n
       LEFT JOIN devices d ON d.id = n.device_id
       LEFT JOIN notification_reads nr
         ON nr.notification_id = n.id AND nr.user_id = ?2
       LEFT JOIN notification_dismissals nd
         ON nd.notification_id = n.id AND nd.user_id = ?2
      WHERE n.organization_id = ?1
        AND nd.notification_id IS NULL
        AND (?3 = 0 OR nr.notification_id IS NULL)
      ORDER BY n.created_at DESC
      LIMIT ?4`,
  ).bind(organizationId, session.userId, unreadOnly ? 1 : 0, limit).all<{
    id: string;
    deviceId: string | null;
    deviceName: string | null;
    category: NotificationCategory;
    type: string;
    severity: NotificationSeverity;
    title: string;
    message: string;
    dataJson: string;
    createdAt: number;
    isRead: number;
  }>();
  const unread = await unreadCount(env.DB, organizationId, session.userId);
  return jsonResponse({
    ok: true,
    notifications: rows.results.map((item) => ({
      ...item,
      isRead: item.isRead === 1,
      data: safeObject(item.dataJson),
      dataJson: undefined,
    })),
    unreadCount: unread,
    requestId,
  });
}

export async function markNotificationRead(
  request: Request,
  env: Env,
  requestId: string,
  notificationId: string,
): Promise<Response> {
  if (!NOTIFICATION_ID_PATTERN.test(notificationId)) {
    throw new ApiError(400, "INVALID_NOTIFICATION_ID", "Notificação inválida.");
  }
  const session = await requireSession(request, env);
  const body = await optionalBody(request);
  const organizationId = selectOrganization(session, body.organizationId);
  const allowed = await env.DB.prepare(
    "SELECT id FROM notifications WHERE id = ?1 AND organization_id = ?2",
  ).bind(notificationId, organizationId).first();
  if (!allowed) throw new ApiError(404, "NOTIFICATION_NOT_FOUND", "Notificação não encontrada.");
  const now = Math.floor(Date.now() / 1_000);
  await env.DB.prepare(
    `INSERT INTO notification_reads (notification_id, user_id, read_at)
     VALUES (?1, ?2, ?3)
     ON CONFLICT(notification_id, user_id) DO UPDATE SET read_at = excluded.read_at`,
  ).bind(notificationId, session.userId, now).run();
  return jsonResponse({ ok: true, unreadCount: await unreadCount(env.DB, organizationId, session.userId), requestId });
}

export async function markAllNotificationsRead(request: Request, env: Env, requestId: string): Promise<Response> {
  const session = await requireSession(request, env);
  const body = await optionalBody(request);
  const organizationId = selectOrganization(session, body.organizationId);
  const now = Math.floor(Date.now() / 1_000);
  await env.DB.prepare(
    `INSERT INTO notification_reads (notification_id, user_id, read_at)
     SELECT n.id, ?2, ?3 FROM notifications n
      WHERE n.organization_id = ?1
        AND NOT EXISTS (
          SELECT 1 FROM notification_dismissals nd
           WHERE nd.notification_id = n.id AND nd.user_id = ?2
        )
     ON CONFLICT(notification_id, user_id) DO NOTHING`,
  ).bind(organizationId, session.userId, now).run();
  return jsonResponse({ ok: true, unreadCount: 0, requestId });
}

export async function deleteNotification(
  request: Request,
  env: Env,
  requestId: string,
  notificationId: string,
): Promise<Response> {
  if (!NOTIFICATION_ID_PATTERN.test(notificationId)) {
    throw new ApiError(400, "INVALID_NOTIFICATION_ID", "Notificação inválida.");
  }
  const session = await requireSession(request, env);
  const body = await optionalBody(request);
  const organizationId = selectOrganization(session, body.organizationId);
  const allowed = await env.DB.prepare(
    "SELECT id FROM notifications WHERE id = ?1 AND organization_id = ?2",
  ).bind(notificationId, organizationId).first();
  if (!allowed) throw new ApiError(404, "NOTIFICATION_NOT_FOUND", "Notificação não encontrada.");
  const now = Math.floor(Date.now() / 1_000);
  await env.DB.prepare(
    `INSERT INTO notification_dismissals (notification_id, user_id, dismissed_at)
     VALUES (?1, ?2, ?3)
     ON CONFLICT(notification_id, user_id) DO UPDATE SET dismissed_at = excluded.dismissed_at`,
  ).bind(notificationId, session.userId, now).run();
  return jsonResponse({
    ok: true,
    unreadCount: await unreadCount(env.DB, organizationId, session.userId),
    requestId,
  });
}

export async function deleteAllNotifications(request: Request, env: Env, requestId: string): Promise<Response> {
  const session = await requireSession(request, env);
  const body = await optionalBody(request);
  const organizationId = selectOrganization(session, body.organizationId);
  const now = Math.floor(Date.now() / 1_000);
  await env.DB.prepare(
    `INSERT INTO notification_dismissals (notification_id, user_id, dismissed_at)
     SELECT n.id, ?2, ?3 FROM notifications n
      WHERE n.organization_id = ?1
     ON CONFLICT(notification_id, user_id) DO UPDATE SET dismissed_at = excluded.dismissed_at`,
  ).bind(organizationId, session.userId, now).run();
  return jsonResponse({ ok: true, unreadCount: 0, requestId });
}

export async function getNotificationPreferences(request: Request, env: Env, requestId: string): Promise<Response> {
  const session = await requireSession(request, env);
  const organizationId = selectOrganization(session, new URL(request.url).searchParams.get("organizationId"));
  const preferences = await preferenceRow(env.DB, session.userId, organizationId);
  return jsonResponse({ ok: true, preferences, requestId });
}

export async function updateNotificationPreferences(request: Request, env: Env, requestId: string): Promise<Response> {
  const session = await requireSession(request, env);
  const body = await readJson(request, 4_096);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new ApiError(400, "INVALID_NOTIFICATION_PREFERENCES", "Preferências inválidas.");
  }
  const values = body as Record<string, unknown>;
  const organizationId = selectOrganization(session, values.organizationId);
  const fields = ["emailEnabled", "deviceEvents", "sensorEvents", "alarmEvents", "profileEvents", "commandEvents"] as const;
  for (const field of fields) {
    if (typeof values[field] !== "boolean") {
      throw new ApiError(400, "INVALID_NOTIFICATION_PREFERENCES", `Preferência inválida: ${field}.`);
    }
  }
  const now = Math.floor(Date.now() / 1_000);
  await env.DB.prepare(
    `INSERT INTO notification_preferences (
       user_id, organization_id, email_enabled, device_events, sensor_events,
       alarm_events, profile_events, command_events, updated_at
     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
     ON CONFLICT(user_id, organization_id) DO UPDATE SET
       email_enabled = excluded.email_enabled,
       device_events = excluded.device_events,
       sensor_events = excluded.sensor_events,
       alarm_events = excluded.alarm_events,
       profile_events = excluded.profile_events,
       command_events = excluded.command_events,
       updated_at = excluded.updated_at`,
  ).bind(
    session.userId,
    organizationId,
    boolInt(values.emailEnabled as boolean),
    boolInt(values.deviceEvents as boolean),
    boolInt(values.sensorEvents as boolean),
    boolInt(values.alarmEvents as boolean),
    boolInt(values.profileEvents as boolean),
    boolInt(values.commandEvents as boolean),
    now,
  ).run();
  return jsonResponse({
    ok: true,
    preferences: await preferenceRow(env.DB, session.userId, organizationId),
    requestId,
  });
}

export async function deliverNotificationEmails(env: Env, notificationIds: string[]): Promise<void> {
  if (!notificationIds.length) return;
  const from = env.NOTIFICATION_EMAIL_FROM?.trim() || env.SALES_EMAIL_FROM?.trim();
  if (!from) return;

  for (const notificationId of notificationIds) {
    const notification = await env.DB.prepare(
      `SELECT n.id, n.organization_id AS organizationId, n.device_id AS deviceId,
              d.name AS deviceName, n.category, n.type, n.severity,
              n.title, n.message, n.created_at AS createdAt
         FROM notifications n
         LEFT JOIN devices d ON d.id = n.device_id
        WHERE n.id = ?1`,
    ).bind(notificationId).first<StoredNotification>();
    if (!notification) continue;

    const preferenceColumn = `${notification.category}_events`;
    const recipients = await env.DB.prepare(
      `SELECT u.id AS userId, u.email, u.display_name AS displayName
         FROM organization_members m
         JOIN users u ON u.id = m.user_id
         JOIN notification_preferences p
           ON p.user_id = u.id AND p.organization_id = m.organization_id
        WHERE m.organization_id = ?1
          AND p.email_enabled = 1
          AND p.${preferenceColumn} = 1`,
    ).bind(notification.organizationId).all<{ userId: string; email: string; displayName: string }>();

    for (const recipient of recipients.results) {
      await deliverOneEmail(env, from, notification, recipient);
    }
  }
}

async function deliverOneEmail(
  env: Env,
  from: string,
  notification: StoredNotification,
  recipient: { userId: string; email: string; displayName: string },
): Promise<void> {
  const now = Math.floor(Date.now() / 1_000);
  const inserted = await env.DB.prepare(
    `INSERT INTO notification_deliveries (
       notification_id, user_id, channel, status, attempts,
       provider_id, error, created_at, updated_at
     ) VALUES (?1, ?2, 'email', 'pending', 0, NULL, NULL, ?3, ?3)
     ON CONFLICT(notification_id, user_id, channel) DO NOTHING`,
  ).bind(notification.id, recipient.userId, now).run();
  if ((inserted.meta.changes ?? 0) !== 1) return;

  try {
    const response = await env.EMAIL.send({
      from: { email: from, name: "Maltworks" },
      to: recipient.email,
      subject: `[Maltworks] ${notification.title}`,
      text: `${recipient.displayName},\n\n${notification.message}\n\nAbra o painel Maltworks para ver os detalhes.`,
      html: `<p>${escapeHtml(recipient.displayName)},</p><p>${escapeHtml(notification.message)}</p><p><a href="https://app.maltworks.com.br">Abrir o painel Maltworks</a></p>`,
    });
    await updateDelivery(env.DB, notification.id, recipient.userId, "sent", response.messageId, null, now);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Falha desconhecida no envio.";
    console.error("Notification email failed", { notificationId: notification.id, userId: recipient.userId, error: message });
    await updateDelivery(env.DB, notification.id, recipient.userId, "failed", null, message.slice(0, 400), now);
  }
}

async function sensorTransition(
  db: D1Database,
  created: string[],
  organizationId: string,
  payload: TelemetryPayload,
  oldState: TelemetryPayload,
  now: number,
  sensor: "refrigerator" | "thermalWell",
  label: string,
  deviceName: string,
  base: string,
): Promise<void> {
  const wasConnected = oldState.temperatures[sensor].connected;
  const isConnected = payload.temperatures[sensor].connected;
  if (wasConnected === isConnected) return;
  created.push(...await createOne(db, {
    organizationId,
    deviceId: payload.deviceId,
    eventKey: `${base}:sensor:${sensor}:${isConnected ? "connected" : "disconnected"}`,
    category: "sensor",
    type: isConnected ? "sensor_reconnected" : "sensor_disconnected",
    severity: isConnected ? "success" : "critical",
    title: `${label} ${isConnected ? "reconectado" : "desconectado"}`,
    message: `${deviceName}: ${isConnected ? "a leitura do sensor foi restabelecida" : "o controlador deixou de receber leituras desse sensor"}.`,
    data: { sensor },
  }, now));
}

async function createOne(db: D1Database, input: NotificationInput, now: number): Promise<string[]> {
  const id = randomId("ntf");
  const result = await db.prepare(
    `INSERT INTO notifications (
       id, organization_id, device_id, event_key, category, type,
       severity, title, message, data_json, created_at
     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
     ON CONFLICT(event_key) DO NOTHING`,
  ).bind(
    id,
    input.organizationId,
    input.deviceId,
    input.eventKey,
    input.category,
    input.type,
    input.severity,
    input.title,
    input.message,
    JSON.stringify(input.data ?? {}),
    now,
  ).run();
  return (result.meta.changes ?? 0) === 1 ? [id] : [];
}

async function setState(
  db: D1Database,
  deviceId: string,
  type: string,
  active: boolean,
  now: number,
  eventKey: string,
): Promise<void> {
  await db.prepare(
    `INSERT INTO notification_states (device_id, type, active, changed_at, last_event_key)
     VALUES (?1, ?2, ?3, ?4, ?5)
     ON CONFLICT(device_id, type) DO UPDATE SET
       active = excluded.active,
       changed_at = excluded.changed_at,
       last_event_key = excluded.last_event_key`,
  ).bind(deviceId, type, boolInt(active), now, eventKey).run();
}

async function preferenceRow(db: D1Database, userId: string, organizationId: string): Promise<Record<string, boolean>> {
  const row = await db.prepare(
    `SELECT email_enabled AS emailEnabled, device_events AS deviceEvents,
            sensor_events AS sensorEvents, alarm_events AS alarmEvents,
            profile_events AS profileEvents, command_events AS commandEvents
       FROM notification_preferences
      WHERE user_id = ?1 AND organization_id = ?2`,
  ).bind(userId, organizationId).first<Record<string, number>>();
  return {
    emailEnabled: row?.emailEnabled === 1,
    deviceEvents: row?.deviceEvents !== 0,
    sensorEvents: row?.sensorEvents !== 0,
    alarmEvents: row?.alarmEvents !== 0,
    profileEvents: row?.profileEvents !== 0,
    commandEvents: row?.commandEvents !== 0,
  };
}

async function unreadCount(db: D1Database, organizationId: string, userId: string): Promise<number> {
  const row = await db.prepare(
    `SELECT COUNT(*) AS count
       FROM notifications n
       LEFT JOIN notification_reads nr
         ON nr.notification_id = n.id AND nr.user_id = ?2
       LEFT JOIN notification_dismissals nd
         ON nd.notification_id = n.id AND nd.user_id = ?2
      WHERE n.organization_id = ?1
        AND nr.notification_id IS NULL
        AND nd.notification_id IS NULL`,
  ).bind(organizationId, userId).first<{ count: number }>();
  return row?.count ?? 0;
}

async function updateDelivery(
  db: D1Database,
  notificationId: string,
  userId: string,
  status: "sent" | "failed",
  providerId: string | null,
  error: string | null,
  now: number,
): Promise<void> {
  await db.prepare(
    `UPDATE notification_deliveries
        SET status = ?3, attempts = attempts + 1, provider_id = ?4,
            error = ?5, updated_at = ?6
      WHERE notification_id = ?1 AND user_id = ?2 AND channel = 'email'`,
  ).bind(notificationId, userId, status, providerId, error, now).run();
}

async function optionalBody(request: Request): Promise<Record<string, unknown>> {
  const contentLength = request.headers.get("Content-Length");
  if (!request.body || contentLength === "0") return {};
  const body = await readJson(request, 1_024);
  if (!body || typeof body !== "object" || Array.isArray(body)) return {};
  return body as Record<string, unknown>;
}

function parseTelemetry(value: string | null): TelemetryPayload | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as TelemetryPayload;
    return parsed?.temperatures && parsed?.profile && parsed?.alarms ? parsed : null;
  } catch {
    return null;
  }
}

function safeObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/gu, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;",
  })[character] ?? character);
}

function boolInt(value: boolean): number {
  return value ? 1 : 0;
}
