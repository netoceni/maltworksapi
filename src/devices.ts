import { constantTimeEqual, sha256Hex } from "./crypto";
import { jsonResponse, readJson } from "./http";
import { requireSession, selectOrganization } from "./auth";
import { ApiError } from "./types";
import { latestCommandForDevice } from "./commands";

export async function claimDevice(request: Request, env: Env, requestId: string): Promise<Response> {
  const session = await requireSession(request, env);
  const raw = await readJson(request);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ApiError(400, "INVALID_BODY", "O corpo da requisicao e invalido.");
  }
  const body = raw as Record<string, unknown>;
  const organizationId = selectOrganization(session, body.organizationId);
  const deviceId = typeof body.deviceId === "string" ? body.deviceId.trim().toUpperCase() : "";
  const pairingCode = typeof body.pairingCode === "string" ? body.pairingCode.trim().toLowerCase() : "";
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!/^MW-[0-9A-F]{12}$/.test(deviceId)) {
    throw new ApiError(400, "INVALID_DEVICE_ID", "Device ID invalido.");
  }
  if (!/^[0-9a-f]{8}$/.test(pairingCode)) {
    throw new ApiError(400, "INVALID_PAIRING_CODE", "Codigo de vinculo invalido.");
  }
  if (name.length < 2 || name.length > 80) {
    throw new ApiError(400, "INVALID_DEVICE_NAME", "O nome deve ter entre 2 e 80 caracteres.");
  }

  const device = await env.DB.prepare(
    `SELECT d.organization_id AS organizationId, d.status,
            c.pairing_code_hash AS pairingCodeHash
       FROM devices d
       JOIN device_credentials c ON c.device_id = d.id
      WHERE d.id = ?1`,
  ).bind(deviceId).first<{
    organizationId: string | null;
    status: string;
    pairingCodeHash: string;
  }>();
  if (!device) {
    throw new ApiError(404, "DEVICE_NOT_FOUND", "O controlador ainda nao enviou telemetria ao servidor.");
  }
  if (device.organizationId) {
    throw new ApiError(409, "DEVICE_ALREADY_CLAIMED", "Este controlador ja esta vinculado.");
  }
  const suppliedHash = await sha256Hex(pairingCode);
  if (!constantTimeEqual(suppliedHash, device.pairingCodeHash)) {
    throw new ApiError(401, "PAIRING_CODE_REJECTED", "Device ID ou codigo de vinculo incorreto.");
  }

  const now = Math.floor(Date.now() / 1000);
  const result = await env.DB.prepare(
    `UPDATE devices
        SET organization_id = ?2, name = ?3, status = 'active',
            claimed_at = ?4, updated_at = ?4
      WHERE id = ?1 AND organization_id IS NULL`,
  ).bind(deviceId, organizationId, name, now).run();
  if ((result.meta.changes ?? 0) !== 1) {
    throw new ApiError(409, "DEVICE_ALREADY_CLAIMED", "Este controlador foi vinculado por outra solicitacao.");
  }

  await env.DB.prepare(
    `INSERT INTO audit_log (
       organization_id, user_id, device_id, action, details_json, created_at
     ) VALUES (?1, ?2, ?3, 'device.claimed', ?4, ?5)`,
  ).bind(
    organizationId,
    session.userId,
    deviceId,
    JSON.stringify({ name }),
    now,
  ).run();

  return jsonResponse({ ok: true, device: { id: deviceId, name, status: "active" }, requestId }, 201);
}

export async function listDevices(request: Request, env: Env, requestId: string): Promise<Response> {
  const session = await requireSession(request, env);
  const organizationId = selectOrganization(session, new URL(request.url).searchParams.get("organizationId"));
  const rows = await env.DB.prepare(
    `SELECT d.id, d.name, d.status, d.firmware_version AS firmwareVersion,
            d.first_seen_at AS firstSeenAt, d.last_seen_at AS lastSeenAt,
            d.claimed_at AS claimedAt, s.received_at AS stateReceivedAt,
            s.refrigerator_value AS refrigeratorValue,
            s.thermal_well_value AS thermalWellValue,
            s.setpoint, s.control_state AS controlState,
            s.cooling, s.heating, s.alarms_active AS alarmsActive,
            s.rssi
       FROM devices d
       LEFT JOIN device_latest_state s ON s.device_id = d.id
      WHERE d.organization_id = ?1
      ORDER BY d.name COLLATE NOCASE ASC`,
  ).bind(organizationId).all();
  return jsonResponse({ ok: true, devices: rows.results, requestId });
}

export async function latestDeviceState(
  request: Request,
  env: Env,
  requestId: string,
  deviceId: string,
): Promise<Response> {
  const session = await requireSession(request, env);
  const organizationId = selectOrganization(session, new URL(request.url).searchParams.get("organizationId"));
  const row = await env.DB.prepare(
    `SELECT s.state_json AS stateJson, s.received_at AS receivedAt
       FROM devices d
       JOIN device_latest_state s ON s.device_id = d.id
      WHERE d.id = ?1 AND d.organization_id = ?2`,
  ).bind(deviceId, organizationId).first<{ stateJson: string; receivedAt: number }>();
  if (!row) throw new ApiError(404, "DEVICE_STATE_NOT_FOUND", "Estado do controlador nao encontrado.");
  const latestCommand = await latestCommandForDevice(
    env.DB,
    deviceId,
    organizationId,
    Math.floor(Date.now() / 1000),
  );
  return jsonResponse({
    ok: true,
    deviceId,
    receivedAt: row.receivedAt,
    state: JSON.parse(row.stateJson) as unknown,
    latestCommand,
    requestId,
  });
}

export async function deviceHistory(
  request: Request,
  env: Env,
  requestId: string,
  deviceId: string,
): Promise<Response> {
  const session = await requireSession(request, env);
  const url = new URL(request.url);
  const organizationId = selectOrganization(session, url.searchParams.get("organizationId"));
  const requestedLimit = Number.parseInt(url.searchParams.get("limit") ?? "100", 10);
  const limit = Number.isFinite(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 500) : 100;
  const before = Number.parseInt(url.searchParams.get("before") ?? "2147483647", 10);

  const allowed = await env.DB.prepare(
    "SELECT id FROM devices WHERE id = ?1 AND organization_id = ?2",
  ).bind(deviceId, organizationId).first();
  if (!allowed) throw new ApiError(404, "DEVICE_NOT_FOUND", "Controlador nao encontrado.");

  const rows = await env.DB.prepare(
    `SELECT received_at AS receivedAt, sent_at AS sentAt,
            refrigerator_value AS refrigeratorValue,
            thermal_well_value AS thermalWellValue,
            setpoint, control_state AS controlState,
            cooling, heating, alarms_active AS alarmsActive, rssi
       FROM telemetry
      WHERE device_id = ?1 AND received_at < ?2
      ORDER BY received_at DESC
      LIMIT ?3`,
  ).bind(deviceId, before, limit).all();
  return jsonResponse({ ok: true, deviceId, points: rows.results, requestId });
}
