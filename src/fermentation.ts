import { requireSession, selectOrganization } from "./auth";
import { jsonResponse, readJson } from "./http";
import { recipeById } from "./recipes";
import { ApiError, type SessionContext } from "./types";

const SESSION_ID_PATTERN = /^fer_[0-9a-f]{32}$/u;
const READING_ID_PATTERN = /^grv_[0-9a-f]{32}$/u;
const MINIMUM_GRAVITY = 0.990;
const MAXIMUM_GRAVITY = 1.200;
const MAXIMUM_AGE_SECONDS = 5 * 365 * 24 * 60 * 60;
const MAXIMUM_READINGS = 500;
const RECIPE_ID_PATTERN = /^rcp_[0-9a-f]{32}$/u;

interface FermentationRow {
  id: string;
  deviceId: string;
  name: string;
  originalGravity: number;
  startedAt: number;
  finishedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

interface GravityReading {
  id: string;
  gravity: number;
  measuredAt: number;
  note: string;
  createdAt: number;
}

export async function getFermentation(
  request: Request,
  env: Env,
  requestId: string,
  deviceId: string,
): Promise<Response> {
  const session = await requireSession(request, env);
  const organizationId = selectOrganization(
    session,
    new URL(request.url).searchParams.get("organizationId"),
  );
  await requireDevice(env.DB, deviceId, organizationId);
  const row = await env.DB.prepare(
    `SELECT id, device_id AS deviceId, name,
            original_gravity AS originalGravity,
            started_at AS startedAt, finished_at AS finishedAt,
            created_at AS createdAt, updated_at AS updatedAt
       FROM fermentation_sessions
      WHERE device_id = ?1 AND organization_id = ?2
      ORDER BY CASE WHEN finished_at IS NULL THEN 0 ELSE 1 END ASC,
               started_at DESC
      LIMIT 1`,
  ).bind(deviceId, organizationId).first<FermentationRow>();
  const fermentation = row ? await withReadings(env.DB, row) : null;
  return jsonResponse({ ok: true, deviceId, fermentation, requestId });
}

export async function startFermentation(
  request: Request,
  env: Env,
  requestId: string,
  deviceId: string,
): Promise<Response> {
  const session = await requireSession(request, env);
  const body = objectValue(await readJson(request));
  const organizationId = selectOrganization(session, body.organizationId);
  requireWriteAccess(session, organizationId);
  await requireDevice(env.DB, deviceId, organizationId);

  const name = textValue(body.name, "name", 2, 80);
  const originalGravity = gravityValue(body.originalGravity, "originalGravity");
  const batchCode = body.batchCode === undefined ? "" : textValue(body.batchCode, "batchCode", 0, 40, true);
  const equipmentName = body.equipmentName === undefined ? "" : textValue(body.equipmentName, "equipmentName", 0, 120, true);
  const plannedFinalGravity = nullableGravityValue(body.plannedFinalGravity);
  const plannedVolumeLiters = nullablePositiveValue(body.plannedVolumeLiters, "plannedVolumeLiters");
  const recipeId = body.recipeId === undefined || body.recipeId === null || body.recipeId === ""
    ? null
    : textValue(body.recipeId, "recipeId", 1, 64);
  if (recipeId && !RECIPE_ID_PATTERN.test(recipeId)) {
    throw new ApiError(400, "INVALID_RECIPE_ID", "Selecione uma receita valida.");
  }
  const recipe = recipeId ? await recipeById(env.DB, recipeId, organizationId) : null;
  if (recipeId && !recipe) throw new ApiError(404, "RECIPE_NOT_FOUND", "Receita nao encontrada.");
  const recipeSnapshot = recipe ? JSON.stringify(recipe) : "{}";
  const now = Math.floor(Date.now() / 1000);
  const startedAt = timestampValue(body.startedAt, "startedAt", now);
  const active = await activeSession(env.DB, deviceId, organizationId);
  if (active) {
    throw new ApiError(409, "FERMENTATION_ALREADY_ACTIVE", "Ja existe um acompanhamento ativo neste controlador.");
  }

  const fermentationId = `fer_${crypto.randomUUID().replaceAll("-", "")}`;
  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO fermentation_sessions (
           id, organization_id, device_id, created_by_user_id, name,
           original_gravity, started_at, finished_at, created_at, updated_at,
           batch_code, recipe_id, recipe_snapshot_json, equipment_name,
           planned_final_gravity, planned_volume_liters
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, NULL, ?8, ?8, ?9, ?10, ?11, ?12, ?13, ?14)`,
      ).bind(
        fermentationId,
        organizationId,
        deviceId,
        session.userId,
        name,
        originalGravity,
        startedAt,
        now,
        batchCode,
        recipeId,
        recipeSnapshot,
        equipmentName,
        plannedFinalGravity,
        plannedVolumeLiters,
      ),
      auditStatement(
        env.DB,
        organizationId,
        session.userId,
        deviceId,
        "fermentation.started",
        { fermentationId, name, originalGravity, startedAt, batchCode, recipeId },
        now,
      ),
    ]);
  } catch (error) {
    if (error instanceof Error && error.message.toLowerCase().includes("unique")) {
      if (error.message.toLowerCase().includes("batch_code")) {
        throw new ApiError(409, "BATCH_CODE_IN_USE", "Ja existe um lote com este codigo.");
      }
      throw new ApiError(409, "FERMENTATION_ALREADY_ACTIVE", "Ja existe um acompanhamento ativo neste controlador.");
    }
    throw error;
  }

  const fermentation = await fermentationById(env.DB, fermentationId, organizationId);
  return jsonResponse({ ok: true, fermentation, requestId }, 201);
}

export async function addGravityReading(
  request: Request,
  env: Env,
  requestId: string,
  deviceId: string,
): Promise<Response> {
  const session = await requireSession(request, env);
  const body = objectValue(await readJson(request));
  const organizationId = selectOrganization(session, body.organizationId);
  requireWriteAccess(session, organizationId);
  await requireDevice(env.DB, deviceId, organizationId);
  const active = await activeSession(env.DB, deviceId, organizationId);
  if (!active) {
    throw new ApiError(409, "FERMENTATION_NOT_ACTIVE", "Inicie um acompanhamento antes de registrar leituras.");
  }
  const readingCount = await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM fermentation_readings WHERE session_id = ?1",
  ).bind(active.id).first<{ count: number }>();
  if ((readingCount?.count ?? 0) >= MAXIMUM_READINGS) {
    throw new ApiError(409, "GRAVITY_READING_LIMIT_REACHED", "Este acompanhamento atingiu o limite de 500 leituras.");
  }

  const gravity = gravityValue(body.gravity, "gravity");
  const note = body.note === undefined ? "" : textValue(body.note, "note", 0, 120, true);
  const now = Math.floor(Date.now() / 1000);
  const measuredAt = timestampValue(body.measuredAt, "measuredAt", now);
  if (measuredAt < active.startedAt) {
    throw new ApiError(400, "READING_BEFORE_START", "A leitura nao pode ser anterior ao inicio da fermentacao.");
  }

  const readingId = `grv_${crypto.randomUUID().replaceAll("-", "")}`;
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO fermentation_readings (
         id, session_id, created_by_user_id, gravity, measured_at, note, created_at
       ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
    ).bind(readingId, active.id, session.userId, gravity, measuredAt, note, now),
    env.DB.prepare(
      "UPDATE fermentation_sessions SET updated_at = ?2 WHERE id = ?1",
    ).bind(active.id, now),
    auditStatement(
      env.DB,
      organizationId,
      session.userId,
      deviceId,
      "fermentation.reading.created",
      { fermentationId: active.id, readingId, gravity, measuredAt },
      now,
    ),
  ]);

  const fermentation = await fermentationById(env.DB, active.id, organizationId);
  return jsonResponse({ ok: true, fermentation, requestId }, 201);
}

export async function deleteGravityReading(
  request: Request,
  env: Env,
  requestId: string,
  deviceId: string,
  readingId: string,
): Promise<Response> {
  validateReadingId(readingId);
  const session = await requireSession(request, env);
  const organizationId = selectOrganization(
    session,
    new URL(request.url).searchParams.get("organizationId"),
  );
  requireWriteAccess(session, organizationId);
  await requireDevice(env.DB, deviceId, organizationId);
  const reading = await env.DB.prepare(
    `SELECT r.id, r.session_id AS sessionId, r.gravity, r.measured_at AS measuredAt
       FROM fermentation_readings r
       JOIN fermentation_sessions f ON f.id = r.session_id
      WHERE r.id = ?1 AND f.device_id = ?2 AND f.organization_id = ?3`,
  ).bind(readingId, deviceId, organizationId).first<{
    id: string;
    sessionId: string;
    gravity: number;
    measuredAt: number;
  }>();
  if (!reading) throw new ApiError(404, "GRAVITY_READING_NOT_FOUND", "Leitura nao encontrada.");
  const now = Math.floor(Date.now() / 1000);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM fermentation_readings WHERE id = ?1").bind(readingId),
    env.DB.prepare(
      "UPDATE fermentation_sessions SET updated_at = ?2 WHERE id = ?1",
    ).bind(reading.sessionId, now),
    auditStatement(
      env.DB,
      organizationId,
      session.userId,
      deviceId,
      "fermentation.reading.deleted",
      { fermentationId: reading.sessionId, readingId, gravity: reading.gravity, measuredAt: reading.measuredAt },
      now,
    ),
  ]);
  const fermentation = await fermentationById(env.DB, reading.sessionId, organizationId);
  return jsonResponse({ ok: true, deleted: true, readingId, fermentation, requestId });
}

export async function finishFermentation(
  request: Request,
  env: Env,
  requestId: string,
  deviceId: string,
): Promise<Response> {
  const session = await requireSession(request, env);
  const body = objectValue(await readJson(request));
  const organizationId = selectOrganization(session, body.organizationId);
  requireWriteAccess(session, organizationId);
  await requireDevice(env.DB, deviceId, organizationId);
  const active = await activeSession(env.DB, deviceId, organizationId);
  if (!active) {
    throw new ApiError(409, "FERMENTATION_NOT_ACTIVE", "Nao existe acompanhamento ativo neste controlador.");
  }
  const now = Math.floor(Date.now() / 1000);
  const finishedAt = Math.max(now, active.startedAt);
  const finalGravity = nullableGravityValue(body.finalGravity);
  const actualVolumeLiters = nullablePositiveValue(body.actualVolumeLiters, "actualVolumeLiters");
  const sensoryScore = nullableIntegerValue(body.sensoryScore, "sensoryScore", 0, 100);
  const sensoryNotes = body.sensoryNotes === undefined ? "" : textValue(body.sensoryNotes, "sensoryNotes", 0, 4000, true);
  const summaryNotes = body.summaryNotes === undefined ? "" : textValue(body.summaryNotes, "summaryNotes", 0, 4000, true);
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE fermentation_sessions
          SET finished_at = ?2, updated_at = ?2,
              final_gravity = COALESCE(?3, final_gravity),
              actual_volume_liters = COALESCE(?4, actual_volume_liters),
              sensory_score = COALESCE(?5, sensory_score),
              sensory_notes = CASE WHEN ?6 = '' THEN sensory_notes ELSE ?6 END,
              summary_notes = CASE WHEN ?7 = '' THEN summary_notes ELSE ?7 END
        WHERE id = ?1 AND finished_at IS NULL`,
    ).bind(active.id, finishedAt, finalGravity, actualVolumeLiters, sensoryScore, sensoryNotes, summaryNotes),
    auditStatement(
      env.DB,
      organizationId,
      session.userId,
      deviceId,
      "fermentation.finished",
      { fermentationId: active.id },
      now,
    ),
  ]);
  const fermentation = await fermentationById(env.DB, active.id, organizationId);
  return jsonResponse({ ok: true, fermentation, requestId });
}

async function fermentationById(
  db: D1Database,
  fermentationId: string,
  organizationId: string,
): Promise<(FermentationRow & { active: boolean; readings: GravityReading[] }) | null> {
  validateSessionId(fermentationId);
  const row = await db.prepare(
    `SELECT id, device_id AS deviceId, name,
            original_gravity AS originalGravity,
            started_at AS startedAt, finished_at AS finishedAt,
            created_at AS createdAt, updated_at AS updatedAt
       FROM fermentation_sessions
      WHERE id = ?1 AND organization_id = ?2`,
  ).bind(fermentationId, organizationId).first<FermentationRow>();
  return row ? withReadings(db, row) : null;
}

async function withReadings(
  db: D1Database,
  row: FermentationRow,
): Promise<FermentationRow & { active: boolean; readings: GravityReading[] }> {
  const result = await db.prepare(
    `SELECT id, gravity, measured_at AS measuredAt, note, created_at AS createdAt
      FROM fermentation_readings
      WHERE session_id = ?1
      ORDER BY measured_at ASC, created_at ASC
      LIMIT ?2`,
  ).bind(row.id, MAXIMUM_READINGS).all<GravityReading>();
  return { ...row, active: row.finishedAt === null, readings: result.results };
}

async function activeSession(
  db: D1Database,
  deviceId: string,
  organizationId: string,
): Promise<{ id: string; startedAt: number } | null> {
  return db.prepare(
    `SELECT id, started_at AS startedAt
       FROM fermentation_sessions
      WHERE device_id = ?1 AND organization_id = ?2 AND finished_at IS NULL`,
  ).bind(deviceId, organizationId).first<{ id: string; startedAt: number }>();
}

async function requireDevice(db: D1Database, deviceId: string, organizationId: string): Promise<void> {
  const device = await db.prepare(
    "SELECT id FROM devices WHERE id = ?1 AND organization_id = ?2",
  ).bind(deviceId, organizationId).first();
  if (!device) throw new ApiError(404, "DEVICE_NOT_FOUND", "Controlador nao encontrado.");
}

function gravityValue(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ApiError(400, "INVALID_GRAVITY", `Campo invalido: ${field}.`);
  }
  const rounded = Math.round(value * 1000) / 1000;
  if (
    rounded < MINIMUM_GRAVITY || rounded > MAXIMUM_GRAVITY ||
    Math.abs(value - rounded) > 0.000_000_1
  ) {
    throw new ApiError(400, "INVALID_GRAVITY", "Use densidade entre 0,990 e 1,200 com tres casas decimais.");
  }
  return rounded;
}

function nullableGravityValue(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return null;
  return gravityValue(value, "gravity");
}

function nullablePositiveValue(value: unknown, field: string): number | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > 100_000) {
    throw new ApiError(400, "INVALID_FIELD", `Campo invalido: ${field}.`);
  }
  return Math.round(value * 1000) / 1000;
}

function nullableIntegerValue(value: unknown, field: string, minimum: number, maximum: number): number | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum || value > maximum) {
    throw new ApiError(400, "INVALID_FIELD", `Campo invalido: ${field}.`);
  }
  return value;
}

function timestampValue(value: unknown, field: string, now: number): number {
  const timestamp = value === undefined ? now : value;
  if (
    typeof timestamp !== "number" || !Number.isInteger(timestamp) ||
    timestamp < now - MAXIMUM_AGE_SECONDS || timestamp > now + 300
  ) {
    throw new ApiError(400, "INVALID_TIMESTAMP", `Campo invalido: ${field}.`);
  }
  return timestamp;
}

function textValue(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number,
  allowEmpty = false,
): string {
  if (typeof value !== "string") throw new ApiError(400, "INVALID_FIELD", `Campo invalido: ${field}.`);
  const normalized = value.trim();
  if ((!allowEmpty && normalized.length < minimum) || normalized.length > maximum) {
    throw new ApiError(400, "INVALID_FIELD", `Campo invalido: ${field}.`);
  }
  return normalized;
}

function objectValue(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(400, "INVALID_BODY", "O corpo da requisicao e invalido.");
  }
  return value as Record<string, unknown>;
}

function requireWriteAccess(session: SessionContext, organizationId: string): void {
  const membership = session.memberships.find((item) => item.organizationId === organizationId);
  if (!membership || membership.role === "viewer") {
    throw new ApiError(403, "FERMENTATION_WRITE_DENIED", "Seu perfil nao pode alterar o acompanhamento da fermentacao.");
  }
}

function validateSessionId(sessionId: string): void {
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    throw new ApiError(400, "INVALID_FERMENTATION_ID", "Identificador de fermentacao invalido.");
  }
}

function validateReadingId(readingId: string): void {
  if (!READING_ID_PATTERN.test(readingId)) {
    throw new ApiError(400, "INVALID_GRAVITY_READING_ID", "Identificador de leitura invalido.");
  }
}

function auditStatement(
  db: D1Database,
  organizationId: string,
  userId: string,
  deviceId: string,
  action: string,
  details: Record<string, unknown>,
  now: number,
): D1PreparedStatement {
  return db.prepare(
    `INSERT INTO audit_log (
       organization_id, user_id, device_id, action, details_json, created_at
     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
  ).bind(organizationId, userId, deviceId, action, JSON.stringify(details), now);
}
