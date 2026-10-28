import { DurableObject } from "cloudflare:workers";

import { requireSession, selectOrganization } from "./auth";
import { nextCommandForDevice } from "./commands";
import { constantTimeEqual, isHex, sha256Hex } from "./crypto";
import { getBearerToken } from "./http";
import {
  deliverNotificationEmails,
  OFFLINE_AFTER_SECONDS,
  recordOfflineDevice,
} from "./notifications";
import { ApiError, type TelemetryPayload } from "./types";

const DEVICE_ID_PATTERN = /^MW-[0-9A-F]{12}$/u;
const DEVICE_TAG_PREFIX = "device:";
const LIVE_HISTORY_SECONDS = 15 * 60;
const LIVE_HISTORY_MAX_POINTS = 180; // 15 minutes at 5-second cadence.

interface SocketAttachment {
  role: "browser" | "device";
  deviceId?: string;
}

interface DeviceIdentity {
  deviceId: string;
  organizationId: string;
}

export interface RealtimeDeviceSnapshot {
  lastSeenAt: number;
  online: boolean;
  receivedAt: number | null;
  state: TelemetryPayload | null;
}

export interface RealtimeHistoryPoint {
  receivedAt: number;
  sentAt: number;
  refrigeratorValue: number | null;
  thermalWellValue: number | null;
  setpoint: number;
  controlState: string;
  cooling: number;
  heating: number;
  alarmsActive: number;
  rssi: number;
}

export class RealtimeHub extends DurableObject<Env> {
  // No D1 writes for per-packet live state. Hibernation can clear this map;
  // the persisted D1 snapshot remains the durable fallback.
  private readonly latestTelemetry = new Map<string, { receivedAt: number; state: TelemetryPayload }>();
  // A short volatile chart buffer replaces redundant 5-second D1 writes.
  private readonly recentTelemetry = new Map<string, RealtimeHistoryPoint[]>();
  // Reject delayed packets from a boot that was already superseded.
  private readonly retiredBoots = new Map<string, string[]>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS device_presence (
          device_id TEXT PRIMARY KEY,
          last_seen_at INTEGER NOT NULL,
          deadline_at INTEGER NOT NULL,
          online INTEGER NOT NULL DEFAULT 1
        )
      `);
    });
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("WebSocket upgrade required", { status: 426 });
    }

    const role = request.headers.get("X-Maltworks-Realtime-Role");
    const deviceId = request.headers.get("X-Maltworks-Realtime-Device-ID") ?? undefined;
    if (role !== "browser" && role !== "device") {
      return new Response("Invalid realtime role", { status: 403 });
    }
    if (role === "device" && (!deviceId || !DEVICE_ID_PATTERN.test(deviceId))) {
      return new Response("Invalid device", { status: 403 });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    const attachment: SocketAttachment = { role, ...(deviceId ? { deviceId } : {}) };
    server.serializeAttachment(attachment);
    this.ctx.acceptWebSocket(
      server,
      role === "device" && deviceId ? [`${DEVICE_TAG_PREFIX}${deviceId}`] : ["browser"],
    );

    if (role === "device" && deviceId) {
      const now = epochSeconds();
      await this.touchPresence(deviceId, now);
      this.broadcast({ type: "presence", deviceId, status: "online", lastSeenAt: now });
      await this.sendPendingCommand(deviceId);
    }

    server.send(JSON.stringify({
      type: "ready",
      role,
      serverTime: epochSeconds(),
      offlineAfterSeconds: OFFLINE_AFTER_SECONDS,
    }));
    return new Response(null, { status: 101, webSocket: client });
  }

  async publishTelemetry(payload: TelemetryPayload, receivedAt: number): Promise<void> {
    const current = this.latestTelemetry.get(payload.deviceId);
    const retired = this.retiredBoots.get(payload.deviceId) ?? [];
    const sameBoot = current?.state.bootId === payload.bootId;
    const replayed = current && (
      (sameBoot && payload.sequence <= current.state.sequence) ||
      (!sameBoot && retired.includes(payload.bootId))
    );

    // A valid authenticated retry is still proof of network presence, but it
    // must never roll back the dashboard or notify a stale safety transition.
    if (replayed) {
      await this.touchPresence(payload.deviceId, receivedAt);
      return;
    }

    if (current && !sameBoot) {
      retired.push(current.state.bootId);
      if (retired.length > 4) retired.shift();
      this.retiredBoots.set(payload.deviceId, retired);
    }

    this.latestTelemetry.set(payload.deviceId, { receivedAt, state: payload });
    const historyPoint: RealtimeHistoryPoint = {
      receivedAt,
      sentAt: payload.sentAt,
      refrigeratorValue: payload.temperatures.refrigerator.value,
      thermalWellValue: payload.temperatures.thermalWell.value,
      setpoint: payload.control.setpoint,
      controlState: payload.control.state,
      cooling: payload.control.cooling ? 1 : 0,
      heating: payload.control.heating ? 1 : 0,
      alarmsActive: payload.alarms.active ? 1 : 0,
      rssi: payload.network.rssi,
    };
    const cutoff = receivedAt - LIVE_HISTORY_SECONDS;
    const prior = this.recentTelemetry.get(payload.deviceId) ?? [];
    const next = prior.filter((point) => point.receivedAt > cutoff && point.receivedAt !== receivedAt);
    next.push(historyPoint);
    if (next.length > LIVE_HISTORY_MAX_POINTS) next.splice(0, next.length - LIVE_HISTORY_MAX_POINTS);
    this.recentTelemetry.set(payload.deviceId, next);

    await this.touchPresence(payload.deviceId, receivedAt);
    // Another HTTP request may have published a newer state during the await.
    if (this.latestTelemetry.get(payload.deviceId)?.state === payload) {
      this.broadcast({ type: "telemetry", deviceId: payload.deviceId, receivedAt, state: payload });
    }
  }

  // Called only by authenticated Worker routes and the offline scanner.
  // DO SQL stores presence, whereas the high-frequency payload lives in memory.
  getDeviceSnapshot(deviceId: string): RealtimeDeviceSnapshot | null {
    const row = this.ctx.storage.sql.exec<{
      last_seen_at: number;
      deadline_at: number;
      online: number;
    }>(
      "SELECT last_seen_at, deadline_at, online FROM device_presence WHERE device_id = ?",
      deviceId,
    ).toArray()[0];
    if (!row) return null;
    const cached = this.latestTelemetry.get(deviceId);
    return {
      lastSeenAt: row.last_seen_at,
      online: row.online === 1 && row.deadline_at > epochSeconds(),
      receivedAt: cached?.receivedAt ?? null,
      state: cached?.state ?? null,
    };
  }

  /** Ephemeral high-resolution graph data. No D1 writes, no permanent promise. */
  getRecentTelemetry(
    deviceId: string,
    since: number,
    maximum = LIVE_HISTORY_MAX_POINTS,
  ): RealtimeHistoryPoint[] {
    const cutoff = Math.max(since, epochSeconds() - LIVE_HISTORY_SECONDS);
    const limit = Math.max(1, Math.min(maximum, LIVE_HISTORY_MAX_POINTS));
    return (this.recentTelemetry.get(deviceId) ?? [])
      .filter((point) => point.receivedAt >= cutoff)
      .slice(-limit)
      .reverse();
  }

  publishNotificationsChanged(): void {
    this.broadcast({ type: "notifications_changed", changedAt: epochSeconds() });
  }

  async commandAvailable(deviceId: string): Promise<void> {
    await this.sendPendingCommand(deviceId);
    this.broadcast({ type: "command_changed", deviceId, changedAt: epochSeconds() });
  }

  async webSocketMessage(socket: WebSocket, message: ArrayBuffer | string): Promise<void> {
    const attachment = socket.deserializeAttachment() as SocketAttachment | null;
    if (!attachment) return;
    if (typeof message !== "string" || message.length > 2_048) {
      socket.close(1009, "Message too large");
      return;
    }

    let value: Record<string, unknown>;
    try {
      const parsed = JSON.parse(message) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
      value = parsed as Record<string, unknown>;
    } catch {
      return;
    }

    if (value.type === "ping") {
      socket.send(JSON.stringify({ type: "pong", serverTime: epochSeconds() }));
      return;
    }
    if (attachment.role === "device" && attachment.deviceId && value.type === "heartbeat") {
      const now = epochSeconds();
      await this.touchPresence(attachment.deviceId, now);
      socket.send(JSON.stringify({ type: "heartbeat_ack", serverTime: now }));
    }
  }

  webSocketClose(): void {
    // O prazo persistido detecta a queda caso o ESP nao reconecte.
  }

  async alarm(): Promise<void> {
    const now = epochSeconds();
    const due = this.ctx.storage.sql.exec<{ device_id: string; last_seen_at: number }>(
      `SELECT device_id, last_seen_at FROM device_presence
        WHERE online = 1 AND deadline_at <= ?`,
      now,
    ).toArray();

    for (const presence of due) {
      this.ctx.storage.sql.exec(
        "UPDATE device_presence SET online = 0 WHERE device_id = ? AND deadline_at <= ?",
        presence.device_id,
        now,
      );
      const notificationIds = await recordOfflineDevice(
        this.env, presence.device_id, now, presence.last_seen_at,
      );
      this.broadcast({
        type: "presence",
        deviceId: presence.device_id,
        status: "offline",
        lastSeenAt: presence.last_seen_at,
      });
      if (notificationIds.length) {
        this.broadcast({ type: "notifications_changed", changedAt: now });
        await deliverNotificationEmails(this.env, notificationIds);
      }
    }
    await this.scheduleNextAlarm();
  }

  private async touchPresence(deviceId: string, lastSeenAt: number): Promise<void> {
    // On the Free pilot the ESP sends HTTP telemetry and WebSocket heartbeats
    // every 30 seconds. Coalesce near-simultaneous updates to keep Durable
    // Object SQL writes and alarm rescheduling well below daily quotas.
    const previous = this.ctx.storage.sql.exec<{
      lastSeenAt: number; deadlineAt: number; online: number;
    }>(
      "SELECT last_seen_at AS lastSeenAt, deadline_at AS deadlineAt, online " +
      "FROM device_presence WHERE device_id = ?",
      deviceId,
    ).toArray()[0];
    if (previous?.online === 1 &&
        previous.deadlineAt > lastSeenAt &&
        lastSeenAt >= previous.lastSeenAt &&
        lastSeenAt - previous.lastSeenAt < 20) {
      return;
    }

    const deadlineAt = lastSeenAt + OFFLINE_AFTER_SECONDS;
    this.ctx.storage.sql.exec(
      `INSERT INTO device_presence (device_id, last_seen_at, deadline_at, online)
       VALUES (?, ?, ?, 1)
       ON CONFLICT(device_id) DO UPDATE SET
         last_seen_at = MAX(last_seen_at, excluded.last_seen_at),
         deadline_at = MAX(deadline_at, excluded.deadline_at),
         online = 1`,
      deviceId,
      lastSeenAt,
      deadlineAt,
    );
    await this.scheduleNextAlarm();
  }

  private async scheduleNextAlarm(): Promise<void> {
    const next = this.ctx.storage.sql.exec<{ deadline_at: number | null }>(
      "SELECT MIN(deadline_at) AS deadline_at FROM device_presence WHERE online = 1",
    ).one();
    if (next.deadline_at !== null && Number.isFinite(next.deadline_at)) {
      await this.ctx.storage.setAlarm(next.deadline_at * 1_000);
    } else {
      await this.ctx.storage.deleteAlarm();
    }
  }

  private async sendPendingCommand(deviceId: string): Promise<void> {
    const sockets = this.ctx.getWebSockets(`${DEVICE_TAG_PREFIX}${deviceId}`);
    if (!sockets.length) return;
    const command = await nextCommandForDevice(this.env.DB, deviceId, epochSeconds());
    if (!command) return;
    const message = JSON.stringify({ type: "command", command });
    for (const socket of sockets) {
      try {
        socket.send(message);
      } catch {
        // A telemetria HTTP continua sendo o fallback de entrega.
      }
    }
  }

  private broadcast(event: Record<string, unknown>): void {
    const message = JSON.stringify(event);
    for (const socket of this.ctx.getWebSockets("browser")) {
      try {
        socket.send(message);
      } catch {
        // As demais conexoes continuam recebendo normalmente.
      }
    }
  }
}

export async function openBrowserRealtime(request: Request, env: Env): Promise<Response> {
  const session = await requireSession(request, env);
  const organizationId = selectOrganization(session, new URL(request.url).searchParams.get("organizationId"));
  return env.REALTIME.getByName(organizationId).fetch(withRealtimeHeaders(request, "browser"));
}

export async function openDeviceRealtime(request: Request, env: Env): Promise<Response> {
  const identity = await authenticateDevice(request, env);
  return env.REALTIME.getByName(identity.organizationId).fetch(
    withRealtimeHeaders(request, "device", identity.deviceId),
  );
}

export function publishTelemetryRealtime(
  env: Env,
  organizationId: string | null,
  payload: TelemetryPayload,
  receivedAt: number,
): Promise<void> {
  if (!organizationId) return Promise.resolve();
  return env.REALTIME.getByName(organizationId).publishTelemetry(payload, receivedAt);
}

export function publishNotificationsRealtime(env: Env, organizationId: string | null): Promise<void> {
  if (!organizationId) return Promise.resolve();
  return env.REALTIME.getByName(organizationId).publishNotificationsChanged();
}

export function publishCommandRealtime(env: Env, organizationId: string, deviceId: string): Promise<void> {
  return env.REALTIME.getByName(organizationId).commandAvailable(deviceId);
}

export async function authenticateDevice(request: Request, env: Env): Promise<DeviceIdentity> {
  const deviceId = (request.headers.get("X-Maltworks-Device-ID") ?? "").toUpperCase();
  if (!DEVICE_ID_PATTERN.test(deviceId)) {
    throw new ApiError(400, "INVALID_DEVICE_ID", "Device ID ausente ou invalido.");
  }
  const token = getBearerToken(request) ?? "";
  if (!isHex(token, 64)) {
    throw new ApiError(401, "INVALID_DEVICE_TOKEN", "Token do dispositivo ausente ou invalido.");
  }
  const tokenHash = await sha256Hex(token.toLowerCase());
  const device = await env.DB.prepare(
    `SELECT d.organization_id AS organizationId, d.status, c.token_hash AS tokenHash
       FROM devices d JOIN device_credentials c ON c.device_id = d.id WHERE d.id = ?1`,
  ).bind(deviceId).first<{ organizationId: string | null; status: string; tokenHash: string }>();
  if (!device || !constantTimeEqual(device.tokenHash, tokenHash)) {
    throw new ApiError(401, "DEVICE_AUTHENTICATION_FAILED", "Credencial do dispositivo rejeitada.");
  }
  if (device.status !== "active" || !device.organizationId) {
    throw new ApiError(409, "DEVICE_NOT_ACTIVE", "O controlador ainda nao esta vinculado.");
  }
  return { deviceId, organizationId: device.organizationId };
}

function withRealtimeHeaders(request: Request, role: SocketAttachment["role"], deviceId?: string): Request {
  const headers = new Headers(request.headers);
  headers.set("X-Maltworks-Realtime-Role", role);
  if (deviceId) headers.set("X-Maltworks-Realtime-Device-ID", deviceId);
  return new Request(request, { headers });
}

function epochSeconds(): number {
  return Math.floor(Date.now() / 1_000);
}
