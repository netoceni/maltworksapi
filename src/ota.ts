import { requireSystemAdmin } from "./admin";
import { randomId, sha256Hex } from "./crypto";
import { jsonResponse, readJson } from "./http";
import { authenticateDevice } from "./realtime";
import { ApiError } from "./types";

const RELEASE_ID_PATTERN = /^fw_[0-9a-f]{32}$/u;
const CAMPAIGN_ID_PATTERN = /^ota_[0-9a-f]{32}$/u;
const ASSIGNMENT_ID_PATTERN = /^otaj_[0-9a-f]{32}$/u;
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const MAXIMUM_FIRMWARE_BYTES = 1_966_080;
const ROLLOUT_PERCENTAGES = new Set([0, 10, 50, 100]);

type AssignmentStatus =
  | "assigned" | "downloading" | "installing" | "rebooting" | "validating"
  | "succeeded" | "failed" | "rolled_back";

export async function adminListFirmware(request: Request, env: Env, requestId: string): Promise<Response> {
  await requireSystemAdmin(request, env);
  const rows = await env.DB.prepare(
    `SELECT id, product, version, board_family AS boardFamily, phase, size_bytes AS sizeBytes,
            sha256, status, created_at AS createdAt
       FROM firmware_releases ORDER BY created_at DESC`,
  ).all();
  return jsonResponse({ ok: true, releases: rows.results, requestId });
}

export async function adminUploadFirmware(request: Request, env: Env, requestId: string): Promise<Response> {
  const admin = await requireSystemAdmin(request, env);
  if (admin.role !== "superadmin" && admin.role !== "admin") {
    throw new ApiError(403, "OTA_WRITE_REQUIRED", "Seu perfil nao pode publicar firmware.");
  }
  const product = requiredHeader(request, "X-Firmware-Product", 64);
  const version = requiredHeader(request, "X-Firmware-Version", 32);
  const boardFamily = requiredHeader(request, "X-Firmware-Board-Family", 32);
  const phase = requiredHeader(request, "X-Firmware-Phase", 64);
  if (!VERSION_PATTERN.test(version)) {
    throw new ApiError(400, "INVALID_FIRMWARE_VERSION", "A versao deve seguir o formato semantico, como 5.5.0.");
  }
  const declaredLength = Number(request.headers.get("Content-Length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAXIMUM_FIRMWARE_BYTES) {
    throw new ApiError(413, "FIRMWARE_TOO_LARGE", "O firmware nao cabe na particao OTA do controlador.");
  }
  const binary = await readBoundedBinary(request, MAXIMUM_FIRMWARE_BYTES);
  if (binary.byteLength < 64_000 || binary.byteLength > MAXIMUM_FIRMWARE_BYTES) {
    throw new ApiError(400, "INVALID_FIRMWARE_SIZE", "O tamanho do firmware e invalido para este controlador.");
  }
  const bytes = new Uint8Array(binary);
  if (bytes[0] !== 0xe9) {
    throw new ApiError(400, "INVALID_ESP_IMAGE", "O arquivo nao e uma imagem ESP32 valida.");
  }
  const embedded = embeddedFirmwareMetadata(bytes);
  if (
    !embedded || embedded.product !== product || embedded.version !== version ||
    embedded.boardFamily !== boardFamily || embedded.phase !== phase
  ) {
    throw new ApiError(400, "FIRMWARE_METADATA_MISMATCH", "Os metadados informados nao correspondem ao firmware compilado.");
  }
  const sha256 = await digestHex(binary);
  const id = randomId("fw");
  const now = epochSeconds();
  const objectKey = `releases/${product}/${boardFamily}/${version}/${sha256}.bin`;
  const duplicate = await env.DB.prepare(
    "SELECT id FROM firmware_releases WHERE product = ?1 AND version = ?2 AND board_family = ?3",
  ).bind(product, version, boardFamily).first();
  if (duplicate) throw new ApiError(409, "FIRMWARE_ALREADY_EXISTS", "Esta versao ja esta no catalogo.");
  await env.FIRMWARE.put(objectKey, binary, {
    httpMetadata: { contentType: "application/octet-stream" },
    customMetadata: { product, version, boardFamily, phase, sha256 },
  });
  try {
    await env.DB.prepare(
      `INSERT INTO firmware_releases
         (id, product, version, board_family, phase, object_key, size_bytes, sha256, status, created_by, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'ready', ?9, ?10)`,
    ).bind(id, product, version, boardFamily, phase, objectKey, binary.byteLength, sha256, admin.session.userId, now).run();
  } catch (error) {
    await env.FIRMWARE.delete(objectKey);
    throw error;
  }
  return jsonResponse({ ok: true, release: { id, product, version, boardFamily, phase, sizeBytes: binary.byteLength, sha256, status: "ready", createdAt: now }, requestId }, 201);
}

export async function adminListOtaDevices(request: Request, env: Env, requestId: string): Promise<Response> {
  await requireSystemAdmin(request, env);
  const onlineSince = epochSeconds() - 30;
  const rows = await env.DB.prepare(
    `SELECT d.id, d.name, d.status, d.firmware_version AS firmwareVersion,
            d.last_seen_at AS lastSeenAt, o.name AS organizationName,
            a.id AS assignmentId, a.target_version AS targetVersion,
            a.status AS otaStatus, a.progress AS otaProgress, a.error_message AS otaError
       FROM devices d
       LEFT JOIN organizations o ON o.id = d.organization_id
       LEFT JOIN ota_assignments a ON a.id = (
         SELECT oa.id FROM ota_assignments oa WHERE oa.device_id = d.id
          ORDER BY oa.updated_at DESC LIMIT 1
       )
      WHERE d.status = 'active'
      ORDER BY d.last_seen_at DESC`,
  ).all<Record<string, unknown>>();
  return jsonResponse({
    ok: true,
    devices: rows.results.map((row) => ({ ...row, online: Number(row.lastSeenAt) >= onlineSince })),
    requestId,
  });
}

export async function adminListCampaigns(request: Request, env: Env, requestId: string): Promise<Response> {
  await requireSystemAdmin(request, env);
  const rows = await env.DB.prepare(
    `SELECT c.id, c.name, c.release_id AS releaseId, r.version, r.board_family AS boardFamily,
            c.rollout_percentage AS rolloutPercentage, c.pilot_device_id AS pilotDeviceId,
            c.status, c.created_at AS createdAt, c.updated_at AS updatedAt,
            COUNT(a.id) AS assigned,
            SUM(CASE WHEN a.status = 'succeeded' THEN 1 ELSE 0 END) AS succeeded,
            SUM(CASE WHEN a.status = 'failed' THEN 1 ELSE 0 END) AS failed,
            SUM(CASE WHEN a.status = 'rolled_back' THEN 1 ELSE 0 END) AS rolledBack,
            SUM(CASE WHEN a.status IN ('downloading','installing','rebooting','validating') THEN 1 ELSE 0 END) AS inProgress
       FROM ota_campaigns c JOIN firmware_releases r ON r.id = c.release_id
       LEFT JOIN ota_assignments a ON a.campaign_id = c.id
      GROUP BY c.id ORDER BY c.updated_at DESC`,
  ).all();
  return jsonResponse({ ok: true, campaigns: rows.results, requestId });
}

export async function adminCreateCampaign(request: Request, env: Env, requestId: string): Promise<Response> {
  const admin = await requireSystemAdmin(request, env);
  if (admin.role === "support") throw new ApiError(403, "OTA_WRITE_REQUIRED", "Seu perfil nao pode iniciar atualizacoes.");
  const body = objectValue(await readJson(request));
  const releaseId = stringValue(body.releaseId, "releaseId", 36);
  const pilotDeviceId = optionalString(body.pilotDeviceId, 32);
  const name = stringValue(body.name, "name", 100);
  const rolloutPercentage = integerValue(body.rolloutPercentage, "rolloutPercentage");
  if (!RELEASE_ID_PATTERN.test(releaseId) || !ROLLOUT_PERCENTAGES.has(rolloutPercentage)) {
    throw new ApiError(400, "INVALID_OTA_CAMPAIGN", "Versao ou percentual de rollout invalido.");
  }
  const release = await releaseById(env.DB, releaseId);
  if (!release || release.status !== "ready") throw new ApiError(404, "FIRMWARE_NOT_AVAILABLE", "Firmware indisponivel.");
  if (pilotDeviceId) await assertCompatibleDevice(env.DB, pilotDeviceId, release);
  const now = epochSeconds();
  const campaignId = randomId("ota");
  await env.DB.prepare(
    `INSERT INTO ota_campaigns
       (id, release_id, name, rollout_percentage, pilot_device_id, status, created_by, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, 'active', ?6, ?7, ?7)`,
  ).bind(campaignId, releaseId, name, rolloutPercentage, pilotDeviceId, admin.session.userId, now).run();
  await synchronizeAssignments(env.DB, campaignId, release, rolloutPercentage, pilotDeviceId, now);
  return jsonResponse({ ok: true, campaignId, requestId }, 201);
}

export async function adminUpdateCampaign(request: Request, env: Env, requestId: string, campaignId: string): Promise<Response> {
  const admin = await requireSystemAdmin(request, env);
  if (admin.role === "support") throw new ApiError(403, "OTA_WRITE_REQUIRED", "Seu perfil nao pode alterar atualizacoes.");
  if (!CAMPAIGN_ID_PATTERN.test(campaignId)) throw new ApiError(400, "INVALID_CAMPAIGN_ID", "Campanha invalida.");
  const body = objectValue(await readJson(request));
  const rolloutPercentage = integerValue(body.rolloutPercentage, "rolloutPercentage");
  const status = stringValue(body.status, "status", 16);
  if (!ROLLOUT_PERCENTAGES.has(rolloutPercentage) || !["active", "paused", "completed"].includes(status)) {
    throw new ApiError(400, "INVALID_OTA_CAMPAIGN", "Estado ou percentual invalido.");
  }
  const campaign = await env.DB.prepare(
    `SELECT c.release_id AS releaseId, c.rollout_percentage AS rolloutPercentage,
            c.pilot_device_id AS pilotDeviceId
       FROM ota_campaigns c WHERE c.id = ?1`,
  ).bind(campaignId).first<{ releaseId: string; rolloutPercentage: number; pilotDeviceId: string | null }>();
  if (!campaign) throw new ApiError(404, "CAMPAIGN_NOT_FOUND", "Campanha nao encontrada.");
  if (rolloutPercentage < campaign.rolloutPercentage) {
    throw new ApiError(409, "ROLLOUT_CANNOT_SHRINK", "Pause a campanha; dispositivos ja selecionados nao podem ser removidos.");
  }
  const release = await releaseById(env.DB, campaign.releaseId);
  if (!release) throw new ApiError(404, "FIRMWARE_NOT_AVAILABLE", "Firmware indisponivel.");
  const now = epochSeconds();
  await env.DB.prepare(
    "UPDATE ota_campaigns SET rollout_percentage = ?2, status = ?3, updated_at = ?4 WHERE id = ?1",
  ).bind(campaignId, rolloutPercentage, status, now).run();
  if (status === "active") await synchronizeAssignments(env.DB, campaignId, release, rolloutPercentage, campaign.pilotDeviceId, now);
  return jsonResponse({ ok: true, campaignId, rolloutPercentage, status, requestId });
}

export async function deviceOtaCheck(request: Request, env: Env, requestId: string): Promise<Response> {
  const identity = await authenticateDevice(request, env);
  const assignment = await env.DB.prepare(
    `SELECT a.id, a.target_version AS targetVersion, a.status, r.product, r.board_family AS boardFamily,
            r.phase, r.size_bytes AS sizeBytes, r.sha256
       FROM ota_assignments a
       JOIN ota_campaigns c ON c.id = a.campaign_id AND c.status = 'active'
       JOIN firmware_releases r ON r.id = a.release_id AND r.status = 'ready'
      WHERE a.device_id = ?1 AND a.status IN ('assigned','downloading','installing','rebooting','validating')
      ORDER BY a.assigned_at DESC LIMIT 1`,
  ).bind(identity.deviceId).first<Record<string, unknown>>();
  if (!assignment) return jsonResponse({ ok: true, update: null, requestId });
  return jsonResponse({
    ok: true,
    update: {
      ...assignment,
      downloadUrl: `${new URL(request.url).origin}/v1/device/ota/${String(assignment.id)}/firmware`,
    },
    requestId,
  });
}

export async function deviceOtaFirmware(request: Request, env: Env, assignmentId: string): Promise<Response> {
  const identity = await authenticateDevice(request, env);
  if (!ASSIGNMENT_ID_PATTERN.test(assignmentId)) throw new ApiError(400, "INVALID_OTA_ASSIGNMENT", "Atualizacao invalida.");
  const assignment = await env.DB.prepare(
    `SELECT a.id, r.object_key AS objectKey, r.size_bytes AS sizeBytes, r.sha256
       FROM ota_assignments a JOIN firmware_releases r ON r.id = a.release_id
      WHERE a.id = ?1 AND a.device_id = ?2`,
  ).bind(assignmentId, identity.deviceId).first<{ id: string; objectKey: string; sizeBytes: number; sha256: string }>();
  if (!assignment) throw new ApiError(404, "OTA_ASSIGNMENT_NOT_FOUND", "Atualizacao nao encontrada.");
  const object = await env.FIRMWARE.get(assignment.objectKey);
  if (!object) throw new ApiError(404, "FIRMWARE_OBJECT_NOT_FOUND", "Arquivo de firmware indisponivel.");
  return new Response(object.body, {
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Length": String(assignment.sizeBytes),
      "X-Firmware-SHA256": assignment.sha256,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export async function deviceOtaEvent(request: Request, env: Env, requestId: string, assignmentId: string): Promise<Response> {
  const identity = await authenticateDevice(request, env);
  if (!ASSIGNMENT_ID_PATTERN.test(assignmentId)) throw new ApiError(400, "INVALID_OTA_ASSIGNMENT", "Atualizacao invalida.");
  const body = objectValue(await readJson(request, 4096));
  const status = stringValue(body.status, "status", 24) as AssignmentStatus;
  const progress = integerValue(body.progress, "progress");
  const message = optionalString(body.message, 240);
  const allowed = new Set<AssignmentStatus>(["downloading", "installing", "rebooting", "validating", "succeeded", "failed", "rolled_back"]);
  if (!allowed.has(status) || progress < 0 || progress > 100) {
    throw new ApiError(400, "INVALID_OTA_EVENT", "Evento OTA invalido.");
  }
  const now = epochSeconds();
  const current = await env.DB.prepare(
    "SELECT status FROM ota_assignments WHERE id = ?1 AND device_id = ?2",
  ).bind(assignmentId, identity.deviceId).first<{ status: AssignmentStatus }>();
  if (!current) throw new ApiError(404, "OTA_ASSIGNMENT_NOT_FOUND", "Atualizacao nao encontrada.");
  if (["succeeded", "failed", "rolled_back"].includes(current.status) && current.status !== status) {
    return jsonResponse({ ok: true, ignored: true, requestId });
  }
  const result = await env.DB.prepare(
    `UPDATE ota_assignments SET status = ?3, progress = ?4, error_message = ?5,
            started_at = COALESCE(started_at, ?6),
            completed_at = CASE WHEN ?3 IN ('succeeded','failed','rolled_back') THEN ?6 ELSE completed_at END,
            attempt_count = CASE WHEN ?3 = 'downloading' AND status = 'assigned' THEN attempt_count + 1 ELSE attempt_count END,
            updated_at = ?6
      WHERE id = ?1 AND device_id = ?2`,
  ).bind(assignmentId, identity.deviceId, status, progress, status === "failed" || status === "rolled_back" ? message : null, now).run();
  if (!result.meta.changes) throw new ApiError(404, "OTA_ASSIGNMENT_NOT_FOUND", "Atualizacao nao encontrada.");
  await env.DB.prepare(
    "INSERT INTO ota_events (assignment_id, device_id, status, progress, message, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
  ).bind(assignmentId, identity.deviceId, status, progress, message, now).run();
  return jsonResponse({ ok: true, requestId });
}

export async function reconcileOtaFromTelemetry(env: Env, deviceId: string, firmwareVersion: string, now: number): Promise<void> {
  const assignment = await env.DB.prepare(
    `SELECT id, source_version AS sourceVersion, target_version AS targetVersion, status
       FROM ota_assignments WHERE device_id = ?1
        AND status IN ('rebooting','validating') ORDER BY updated_at DESC LIMIT 1`,
  ).bind(deviceId).first<{ id: string; sourceVersion: string; targetVersion: string; status: string }>();
  if (!assignment) return;
  const nextStatus = firmwareVersion === assignment.targetVersion
    ? "succeeded"
    : firmwareVersion === assignment.sourceVersion ? "rolled_back" : null;
  if (!nextStatus) return;
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE ota_assignments SET status = ?2, progress = 100,
              error_message = CASE WHEN ?2 = 'rolled_back' THEN 'Rollback confirmado pela telemetria.' ELSE NULL END,
              completed_at = ?3, updated_at = ?3 WHERE id = ?1`,
    ).bind(assignment.id, nextStatus, now),
    env.DB.prepare(
      "INSERT INTO ota_events (assignment_id, device_id, status, progress, message, created_at) VALUES (?1, ?2, ?3, 100, ?4, ?5)",
    ).bind(assignment.id, deviceId, nextStatus, "Versao confirmada pela telemetria.", now),
  ]);
}

interface ReleaseRow { id: string; product: string; version: string; boardFamily: string; status: string }

async function releaseById(db: D1Database, id: string): Promise<ReleaseRow | null> {
  return db.prepare(
    "SELECT id, product, version, board_family AS boardFamily, status FROM firmware_releases WHERE id = ?1",
  ).bind(id).first<ReleaseRow>();
}

async function assertCompatibleDevice(db: D1Database, deviceId: string, release: ReleaseRow): Promise<void> {
  const device = await db.prepare("SELECT id, firmware_version AS firmwareVersion, status FROM devices WHERE id = ?1")
    .bind(deviceId).first<{ id: string; firmwareVersion: string; status: string }>();
  if (!device || device.status !== "active") throw new ApiError(404, "DEVICE_NOT_FOUND", "Controlador ativo nao encontrado.");
  if (compareVersions(release.version, device.firmwareVersion) <= 0) {
    throw new ApiError(409, "FIRMWARE_NOT_NEWER", "A versao selecionada precisa ser superior a instalada.");
  }
}

async function synchronizeAssignments(
  db: D1Database, campaignId: string, release: ReleaseRow, percentage: number,
  pilotDeviceId: string | null, now: number,
): Promise<void> {
  const devices = await db.prepare(
    `SELECT d.id, d.firmware_version AS firmwareVersion FROM devices d
      WHERE d.status = 'active' AND d.organization_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM ota_assignments oa JOIN ota_campaigns oc ON oc.id = oa.campaign_id
           WHERE oa.device_id = d.id AND oc.status = 'active'
             AND oa.status NOT IN ('succeeded','failed','rolled_back') AND oc.id <> ?1
        )`,
  ).bind(campaignId).all<{ id: string; firmwareVersion: string }>();
  const statements: D1PreparedStatement[] = [];
  for (const device of devices.results) {
    if (compareVersions(release.version, device.firmwareVersion) <= 0) continue;
    const selected = device.id === pilotDeviceId || (percentage > 0 && await rolloutBucket(device.id, campaignId) < percentage);
    if (!selected) continue;
    statements.push(db.prepare(
      `INSERT OR IGNORE INTO ota_assignments
         (id, campaign_id, release_id, device_id, source_version, target_version, status, progress, assigned_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'assigned', 0, ?7, ?7)`,
    ).bind(randomId("otaj"), campaignId, release.id, device.id, device.firmwareVersion, release.version, now));
  }
  for (let index = 0; index < statements.length; index += 50) await db.batch(statements.slice(index, index + 50));
}

async function rolloutBucket(deviceId: string, campaignId: string): Promise<number> {
  const digest = await sha256Hex(`${campaignId}:${deviceId}`);
  return Number.parseInt(digest.slice(0, 8), 16) % 100;
}

function compareVersions(left: string, right: string): number {
  const a = left.split(/[.-]/u).slice(0, 3).map(Number);
  const b = right.split(/[.-]/u).slice(0, 3).map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function requiredHeader(request: Request, name: string, maximum: number): string {
  const value = request.headers.get(name)?.trim() ?? "";
  if (!value || value.length > maximum || /[\r\n]/u.test(value)) throw new ApiError(400, "INVALID_FIRMWARE_METADATA", `Cabecalho ${name} invalido.`);
  return value;
}
function objectValue(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ApiError(400, "INVALID_BODY", "Corpo invalido.");
  return value as Record<string, unknown>;
}
function stringValue(value: unknown, field: string, maximum: number): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > maximum) throw new ApiError(400, "INVALID_FIELD", `Campo ${field} invalido.`);
  return value.trim();
}
function optionalString(value: unknown, maximum: number): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string" || value.trim().length > maximum) throw new ApiError(400, "INVALID_FIELD", "Campo de texto invalido.");
  return value.trim();
}
function integerValue(value: unknown, field: string): number {
  if (!Number.isInteger(value)) throw new ApiError(400, "INVALID_FIELD", `Campo ${field} invalido.`);
  return value as number;
}
async function digestHex(value: ArrayBuffer): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", value));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
async function readBoundedBinary(request: Request, maximumBytes: number): Promise<ArrayBuffer> {
  if (!request.body) throw new ApiError(400, "EMPTY_FIRMWARE", "Envie o arquivo de firmware.");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maximumBytes) {
      await reader.cancel();
      throw new ApiError(413, "FIRMWARE_TOO_LARGE", "O firmware nao cabe na particao OTA do controlador.");
    }
    chunks.push(value);
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result.buffer;
}
function embeddedFirmwareMetadata(bytes: Uint8Array): { product: string; version: string; boardFamily: string; phase: string } | null {
  const startMarker = new TextEncoder().encode("MALTWORKS_FW_META:");
  const endMarker = new TextEncoder().encode(":MALTWORKS_FW_META_END");
  const start = byteIndexOf(bytes, startMarker, 0);
  if (start < 0) return null;
  const jsonStart = start + startMarker.length;
  const end = byteIndexOf(bytes, endMarker, jsonStart);
  if (end < jsonStart || end - jsonStart > 512) return null;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes.slice(jsonStart, end))) as Record<string, unknown>;
    if ([parsed.product, parsed.version, parsed.boardFamily, parsed.phase].some((value) => typeof value !== "string")) return null;
    return parsed as { product: string; version: string; boardFamily: string; phase: string };
  } catch { return null; }
}
function byteIndexOf(source: Uint8Array, needle: Uint8Array, from: number): number {
  outer: for (let index = from; index <= source.length - needle.length; index += 1) {
    for (let offset = 0; offset < needle.length; offset += 1) if (source[index + offset] !== needle[offset]) continue outer;
    return index;
  }
  return -1;
}
function epochSeconds(): number { return Math.floor(Date.now() / 1_000); }
