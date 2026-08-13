import { requireSession, selectOrganization } from "./auth";
import { jsonResponse, readJson } from "./http";
import { ApiError, type SessionContext } from "./types";

const BATCH_ID_PATTERN = /^fer_[0-9a-f]{32}$/u;
const INGREDIENT_ID_PATTERN = /^bgi_[0-9a-f]{32}$/u;
const JOURNAL_ID_PATTERN = /^bje_[0-9a-f]{32}$/u;
const ATTACHMENT_ID_PATTERN = /^bga_[0-9a-f]{32}$/u;
const RECIPE_ID_PATTERN = /^rcp_[0-9a-f]{32}$/u;
const MAXIMUM_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const MAXIMUM_ATTACHMENTS = 20;
const ALLOWED_CONTENT_TYPES = new Set([
  "image/jpeg", "image/png", "image/webp", "application/pdf", "text/plain",
]);

interface BatchRow {
  id: string;
  deviceId: string;
  deviceName: string;
  name: string;
  batchCode: string;
  recipeId: string | null;
  recipeSnapshotJson: string;
  equipmentName: string;
  originalGravity: number;
  plannedFinalGravity: number | null;
  plannedVolumeLiters: number | null;
  finalGravity: number | null;
  actualVolumeLiters: number | null;
  summaryNotes: string;
  sensoryScore: number | null;
  sensoryNotes: string;
  startedAt: number;
  finishedAt: number | null;
  createdAt: number;
  updatedAt: number;
  latestGravity: number | null;
  plannedCostCents: number;
  actualCostCents: number;
}

interface IngredientRow {
  id: string;
  name: string;
  category: string;
  plannedQuantity: number;
  actualQuantity: number | null;
  unit: string;
  plannedCostCents: number;
  actualCostCents: number | null;
  createdAt: number;
  updatedAt: number;
}

export async function listBatches(request: Request, env: Env, requestId: string): Promise<Response> {
  const session = await requireSession(request, env);
  const organizationId = selectOrganization(session, new URL(request.url).searchParams.get("organizationId"));
  const result = await env.DB.prepare(`${batchSelect()}
      WHERE f.organization_id = ?1
      ORDER BY CASE WHEN f.finished_at IS NULL THEN 0 ELSE 1 END, f.started_at DESC
      LIMIT 200`).bind(organizationId).all<BatchRow>();
  const batches = result.results.map((row) => enrichBatchSummary(row));
  return jsonResponse({ ok: true, batches, requestId });
}

export async function getBatch(
  request: Request, env: Env, requestId: string, batchId: string,
): Promise<Response> {
  validateId(batchId, BATCH_ID_PATTERN, "INVALID_BATCH_ID", "Identificador de lote invalido.");
  const { organizationId } = await contextForRequest(request, env);
  const batch = await fullBatch(env.DB, batchId, organizationId);
  if (!batch) throw new ApiError(404, "BATCH_NOT_FOUND", "Lote nao encontrado.");
  return jsonResponse({ ok: true, batch, requestId });
}

export async function updateBatch(
  request: Request, env: Env, requestId: string, batchId: string,
): Promise<Response> {
  validateId(batchId, BATCH_ID_PATTERN, "INVALID_BATCH_ID", "Identificador de lote invalido.");
  const body = objectValue(await readJson(request));
  const { session, organizationId } = await writeContext(request, env, body.organizationId);
  const current = await batchRow(env.DB, batchId, organizationId);
  if (!current) throw new ApiError(404, "BATCH_NOT_FOUND", "Lote nao encontrado.");

  const name = optionalText(body.name, current.name, 2, 80, "name");
  const batchCode = optionalText(body.batchCode, current.batchCode, 0, 40, "batchCode");
  const equipmentName = optionalText(body.equipmentName, current.equipmentName, 0, 120, "equipmentName");
  const plannedFinalGravity = optionalGravity(body.plannedFinalGravity, current.plannedFinalGravity);
  const finalGravity = optionalGravity(body.finalGravity, current.finalGravity);
  const plannedVolumeLiters = optionalPositive(body.plannedVolumeLiters, current.plannedVolumeLiters, 100_000, "plannedVolumeLiters");
  const actualVolumeLiters = optionalPositive(body.actualVolumeLiters, current.actualVolumeLiters, 100_000, "actualVolumeLiters");
  const summaryNotes = optionalText(body.summaryNotes, current.summaryNotes, 0, 4000, "summaryNotes");
  const sensoryNotes = optionalText(body.sensoryNotes, current.sensoryNotes, 0, 4000, "sensoryNotes");
  const sensoryScore = optionalInteger(body.sensoryScore, current.sensoryScore, 0, 100, "sensoryScore");
  const now = epochSeconds();

  try {
    await env.DB.batch([
      env.DB.prepare(`UPDATE fermentation_sessions
        SET name = ?4, batch_code = ?5, equipment_name = ?6,
            planned_final_gravity = ?7, final_gravity = ?8,
            planned_volume_liters = ?9, actual_volume_liters = ?10,
            summary_notes = ?11, sensory_score = ?12, sensory_notes = ?13,
            updated_at = ?14
        WHERE id = ?1 AND organization_id = ?2 AND device_id = ?3`).bind(
        batchId, organizationId, current.deviceId, name, batchCode, equipmentName,
        plannedFinalGravity, finalGravity, plannedVolumeLiters, actualVolumeLiters,
        summaryNotes, sensoryScore, sensoryNotes, now,
      ),
      auditStatement(env.DB, organizationId, session.userId, current.deviceId, "batch.updated", { batchId }, now),
    ]);
  } catch (error) {
    if (error instanceof Error && error.message.toLowerCase().includes("unique")) {
      throw new ApiError(409, "BATCH_CODE_IN_USE", "Ja existe um lote com este codigo.");
    }
    throw error;
  }
  return jsonResponse({ ok: true, batch: await fullBatch(env.DB, batchId, organizationId), requestId });
}

export async function addBatchIngredient(
  request: Request, env: Env, requestId: string, batchId: string,
): Promise<Response> {
  validateId(batchId, BATCH_ID_PATTERN, "INVALID_BATCH_ID", "Identificador de lote invalido.");
  const body = objectValue(await readJson(request));
  const { session, organizationId } = await writeContext(request, env, body.organizationId);
  const batch = await batchRow(env.DB, batchId, organizationId);
  if (!batch) throw new ApiError(404, "BATCH_NOT_FOUND", "Lote nao encontrado.");
  const count = await env.DB.prepare("SELECT COUNT(*) AS count FROM batch_ingredients WHERE session_id = ?1")
    .bind(batchId).first<{ count: number }>();
  if ((count?.count ?? 0) >= 200) throw new ApiError(409, "INGREDIENT_LIMIT_REACHED", "O lote atingiu o limite de ingredientes.");
  const name = requiredText(body.name, 1, 120, "name");
  const category = enumValue(body.category, ["malte", "lupulo", "levedura", "adjunto", "agua", "embalagem", "outro"], "category");
  const unit = enumValue(body.unit, ["kg", "g", "l", "ml", "un"], "unit");
  const plannedQuantity = nonNegative(body.plannedQuantity, 1_000_000, "plannedQuantity");
  const actualQuantity = nullableNonNegative(body.actualQuantity, 1_000_000, "actualQuantity");
  const plannedCostCents = moneyValue(body.plannedCost, "plannedCost");
  const actualCostCents = nullableMoneyValue(body.actualCost, "actualCost");
  const id = randomId("bgi");
  const now = epochSeconds();
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO batch_ingredients
      (id, session_id, name, category, planned_quantity, actual_quantity, unit,
       planned_cost_cents, actual_cost_cents, created_at, updated_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10)`).bind(
      id, batchId, name, category, plannedQuantity, actualQuantity, unit,
      plannedCostCents, actualCostCents, now,
    ),
    env.DB.prepare("UPDATE fermentation_sessions SET updated_at = ?2 WHERE id = ?1").bind(batchId, now),
    auditStatement(env.DB, organizationId, session.userId, batch.deviceId, "batch.ingredient.created", { batchId, ingredientId: id }, now),
  ]);
  return jsonResponse({ ok: true, batch: await fullBatch(env.DB, batchId, organizationId), requestId }, 201);
}

export async function deleteBatchIngredient(
  request: Request, env: Env, requestId: string, batchId: string, ingredientId: string,
): Promise<Response> {
  validateId(batchId, BATCH_ID_PATTERN, "INVALID_BATCH_ID", "Identificador de lote invalido.");
  validateId(ingredientId, INGREDIENT_ID_PATTERN, "INVALID_INGREDIENT_ID", "Identificador de ingrediente invalido.");
  const { session, organizationId } = await writeContext(request, env, new URL(request.url).searchParams.get("organizationId"));
  const batch = await batchRow(env.DB, batchId, organizationId);
  if (!batch) throw new ApiError(404, "BATCH_NOT_FOUND", "Lote nao encontrado.");
  const result = await env.DB.prepare("DELETE FROM batch_ingredients WHERE id = ?1 AND session_id = ?2").bind(ingredientId, batchId).run();
  if ((result.meta.changes ?? 0) !== 1) throw new ApiError(404, "INGREDIENT_NOT_FOUND", "Ingrediente nao encontrado.");
  const now = epochSeconds();
  await env.DB.batch([
    env.DB.prepare("UPDATE fermentation_sessions SET updated_at = ?2 WHERE id = ?1").bind(batchId, now),
    auditStatement(env.DB, organizationId, session.userId, batch.deviceId, "batch.ingredient.deleted", { batchId, ingredientId }, now),
  ]);
  return jsonResponse({ ok: true, deleted: true, batch: await fullBatch(env.DB, batchId, organizationId), requestId });
}

export async function addBatchJournalEntry(
  request: Request, env: Env, requestId: string, batchId: string,
): Promise<Response> {
  validateId(batchId, BATCH_ID_PATTERN, "INVALID_BATCH_ID", "Identificador de lote invalido.");
  const body = objectValue(await readJson(request));
  const { session, organizationId } = await writeContext(request, env, body.organizationId);
  const batch = await batchRow(env.DB, batchId, organizationId);
  if (!batch) throw new ApiError(404, "BATCH_NOT_FOUND", "Lote nao encontrado.");
  const kind = enumValue(body.kind, ["observacao", "ocorrencia"], "kind");
  const title = requiredText(body.title, 1, 120, "title");
  const details = body.details === undefined ? "" : requiredText(body.details, 0, 4000, "details");
  const occurredAt = timestampValue(body.occurredAt, epochSeconds());
  const id = randomId("bje");
  const now = epochSeconds();
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO batch_journal
      (id, session_id, created_by_user_id, kind, title, details, occurred_at, created_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`).bind(id, batchId, session.userId, kind, title, details, occurredAt, now),
    env.DB.prepare("UPDATE fermentation_sessions SET updated_at = ?2 WHERE id = ?1").bind(batchId, now),
    auditStatement(env.DB, organizationId, session.userId, batch.deviceId, "batch.journal.created", { batchId, journalId: id, kind }, now),
  ]);
  return jsonResponse({ ok: true, batch: await fullBatch(env.DB, batchId, organizationId), requestId }, 201);
}

export async function deleteBatchJournalEntry(
  request: Request, env: Env, requestId: string, batchId: string, journalId: string,
): Promise<Response> {
  validateId(batchId, BATCH_ID_PATTERN, "INVALID_BATCH_ID", "Identificador de lote invalido.");
  validateId(journalId, JOURNAL_ID_PATTERN, "INVALID_JOURNAL_ID", "Identificador de registro invalido.");
  const { session, organizationId } = await writeContext(request, env, new URL(request.url).searchParams.get("organizationId"));
  const batch = await batchRow(env.DB, batchId, organizationId);
  if (!batch) throw new ApiError(404, "BATCH_NOT_FOUND", "Lote nao encontrado.");
  const result = await env.DB.prepare("DELETE FROM batch_journal WHERE id = ?1 AND session_id = ?2").bind(journalId, batchId).run();
  if ((result.meta.changes ?? 0) !== 1) throw new ApiError(404, "JOURNAL_ENTRY_NOT_FOUND", "Registro nao encontrado.");
  const now = epochSeconds();
  await env.DB.batch([
    env.DB.prepare("UPDATE fermentation_sessions SET updated_at = ?2 WHERE id = ?1").bind(batchId, now),
    auditStatement(env.DB, organizationId, session.userId, batch.deviceId, "batch.journal.deleted", { batchId, journalId }, now),
  ]);
  return jsonResponse({ ok: true, deleted: true, batch: await fullBatch(env.DB, batchId, organizationId), requestId });
}

export async function uploadBatchAttachment(
  request: Request, env: Env, requestId: string, batchId: string,
): Promise<Response> {
  validateId(batchId, BATCH_ID_PATTERN, "INVALID_BATCH_ID", "Identificador de lote invalido.");
  const { session, organizationId } = await writeContext(request, env, new URL(request.url).searchParams.get("organizationId"));
  const batch = await batchRow(env.DB, batchId, organizationId);
  if (!batch) throw new ApiError(404, "BATCH_NOT_FOUND", "Lote nao encontrado.");
  const count = await env.DB.prepare("SELECT COUNT(*) AS count FROM batch_attachments WHERE session_id = ?1")
    .bind(batchId).first<{ count: number }>();
  if ((count?.count ?? 0) >= MAXIMUM_ATTACHMENTS) throw new ApiError(409, "ATTACHMENT_LIMIT_REACHED", "O lote atingiu o limite de 20 anexos.");
  const size = Number(request.headers.get("Content-Length"));
  if (!Number.isInteger(size) || size < 1 || size > MAXIMUM_ATTACHMENT_BYTES) {
    throw new ApiError(413, "INVALID_ATTACHMENT_SIZE", "O anexo deve possuir no maximo 10 MB.");
  }
  const contentType = (request.headers.get("Content-Type") ?? "").split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (!ALLOWED_CONTENT_TYPES.has(contentType)) throw new ApiError(415, "INVALID_ATTACHMENT_TYPE", "Envie JPG, PNG, WebP, PDF ou texto.");
  const fileName = decodedFileName(request.headers.get("X-File-Name"));
  if (!request.body) throw new ApiError(400, "EMPTY_ATTACHMENT", "O arquivo esta vazio.");
  const id = randomId("bga");
  const objectKey = `batches/${organizationId}/${batchId}/${id}`;
  const now = epochSeconds();
  await env.BATCH_FILES.put(objectKey, request.body, {
    httpMetadata: { contentType },
    customMetadata: { batchId, fileName, uploadedBy: session.userId },
  });
  try {
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO batch_attachments
        (id, session_id, created_by_user_id, object_key, file_name, content_type, size_bytes, created_at)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`).bind(id, batchId, session.userId, objectKey, fileName, contentType, size, now),
      env.DB.prepare("UPDATE fermentation_sessions SET updated_at = ?2 WHERE id = ?1").bind(batchId, now),
      auditStatement(env.DB, organizationId, session.userId, batch.deviceId, "batch.attachment.created", { batchId, attachmentId: id, fileName, size }, now),
    ]);
  } catch (error) {
    await env.BATCH_FILES.delete(objectKey);
    throw error;
  }
  return jsonResponse({ ok: true, batch: await fullBatch(env.DB, batchId, organizationId), requestId }, 201);
}

export async function downloadBatchAttachment(
  request: Request, env: Env, _requestId: string, batchId: string, attachmentId: string,
): Promise<Response> {
  validateId(batchId, BATCH_ID_PATTERN, "INVALID_BATCH_ID", "Identificador de lote invalido.");
  validateId(attachmentId, ATTACHMENT_ID_PATTERN, "INVALID_ATTACHMENT_ID", "Identificador de anexo invalido.");
  const { organizationId } = await contextForRequest(request, env);
  const attachment = await attachmentRow(env.DB, batchId, attachmentId, organizationId);
  if (!attachment) throw new ApiError(404, "ATTACHMENT_NOT_FOUND", "Anexo nao encontrado.");
  const object = await env.BATCH_FILES.get(attachment.objectKey);
  if (!object) throw new ApiError(404, "ATTACHMENT_OBJECT_NOT_FOUND", "Arquivo indisponivel.");
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("Content-Length", String(object.size));
  headers.set("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(attachment.fileName)}`);
  headers.set("Cache-Control", "private, no-store");
  return new Response(object.body, { headers });
}

export async function deleteBatchAttachment(
  request: Request, env: Env, requestId: string, batchId: string, attachmentId: string,
): Promise<Response> {
  validateId(batchId, BATCH_ID_PATTERN, "INVALID_BATCH_ID", "Identificador de lote invalido.");
  validateId(attachmentId, ATTACHMENT_ID_PATTERN, "INVALID_ATTACHMENT_ID", "Identificador de anexo invalido.");
  const { session, organizationId } = await writeContext(request, env, new URL(request.url).searchParams.get("organizationId"));
  const batch = await batchRow(env.DB, batchId, organizationId);
  if (!batch) throw new ApiError(404, "BATCH_NOT_FOUND", "Lote nao encontrado.");
  const attachment = await attachmentRow(env.DB, batchId, attachmentId, organizationId);
  if (!attachment) throw new ApiError(404, "ATTACHMENT_NOT_FOUND", "Anexo nao encontrado.");
  await env.BATCH_FILES.delete(attachment.objectKey);
  const now = epochSeconds();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM batch_attachments WHERE id = ?1").bind(attachmentId),
    env.DB.prepare("UPDATE fermentation_sessions SET updated_at = ?2 WHERE id = ?1").bind(batchId, now),
    auditStatement(env.DB, organizationId, session.userId, batch.deviceId, "batch.attachment.deleted", { batchId, attachmentId }, now),
  ]);
  return jsonResponse({ ok: true, deleted: true, batch: await fullBatch(env.DB, batchId, organizationId), requestId });
}

export async function compareBatches(request: Request, env: Env, requestId: string): Promise<Response> {
  const session = await requireSession(request, env);
  const url = new URL(request.url);
  const organizationId = selectOrganization(session, url.searchParams.get("organizationId"));
  const recipeId = url.searchParams.get("recipeId")?.trim() ?? "";
  if (!RECIPE_ID_PATTERN.test(recipeId)) throw new ApiError(400, "INVALID_RECIPE_ID", "Selecione uma receita valida.");
  const result = await env.DB.prepare(`${batchSelect()}
      WHERE f.organization_id = ?1 AND f.recipe_id = ?2
      ORDER BY f.started_at DESC LIMIT 50`).bind(organizationId, recipeId).all<BatchRow>();
  const batches = result.results.map((row) => enrichBatchSummary(row));
  return jsonResponse({ ok: true, recipeId, batches, requestId });
}

async function fullBatch(db: D1Database, batchId: string, organizationId: string): Promise<Record<string, unknown> | null> {
  const row = await batchRow(db, batchId, organizationId);
  if (!row) return null;
  const [readings, ingredients, journal, attachments] = await Promise.all([
    db.prepare(`SELECT id, gravity, measured_at AS measuredAt, note, created_at AS createdAt
      FROM fermentation_readings WHERE session_id = ?1 ORDER BY measured_at ASC, created_at ASC LIMIT 500`)
      .bind(batchId).all(),
    db.prepare(`SELECT id, name, category, planned_quantity AS plannedQuantity,
      actual_quantity AS actualQuantity, unit, planned_cost_cents AS plannedCostCents,
      actual_cost_cents AS actualCostCents, created_at AS createdAt, updated_at AS updatedAt
      FROM batch_ingredients WHERE session_id = ?1 ORDER BY created_at ASC`).bind(batchId).all<IngredientRow>(),
    db.prepare(`SELECT id, kind, title, details, occurred_at AS occurredAt, created_at AS createdAt
      FROM batch_journal WHERE session_id = ?1 ORDER BY occurred_at DESC, created_at DESC LIMIT 500`).bind(batchId).all(),
    db.prepare(`SELECT id, file_name AS fileName, content_type AS contentType,
      size_bytes AS sizeBytes, created_at AS createdAt
      FROM batch_attachments WHERE session_id = ?1 ORDER BY created_at DESC`).bind(batchId).all(),
  ]);
  const summary = enrichBatchSummary(row, ingredients.results);
  return { ...summary, readings: readings.results, ingredients: ingredients.results.map(presentIngredient), journal: journal.results, attachments: attachments.results };
}

function enrichBatchSummary(row: BatchRow, knownIngredients?: IngredientRow[]): Record<string, unknown> {
  const finalGravity = row.finalGravity ?? row.latestGravity ?? null;
  const abv = finalGravity === null ? null : Math.max(0, (row.originalGravity - finalGravity) * 131.25);
  const attenuation = finalGravity === null || row.originalGravity <= 1
    ? null : ((row.originalGravity - finalGravity) / (row.originalGravity - 1)) * 100;
  const plannedCostCents = knownIngredients
    ? knownIngredients.reduce((sum, item) => sum + item.plannedCostCents, 0)
    : row.plannedCostCents;
  const actualCostCents = knownIngredients
    ? knownIngredients.reduce((sum, item) => sum + (item.actualCostCents ?? item.plannedCostCents), 0)
    : row.actualCostCents;
  return {
    ...row,
    recipeSnapshot: parseJson(row.recipeSnapshotJson),
    recipeSnapshotJson: undefined,
    latestGravity: undefined,
    plannedCostCents: undefined,
    actualCostCents: undefined,
    active: row.finishedAt === null,
    finalGravity,
    metrics: {
      abv: abv === null ? null : round(abv, 2),
      attenuation: attenuation === null ? null : round(attenuation, 1),
      plannedCost: plannedCostCents / 100,
      actualCost: actualCostCents / 100,
      costPerLiter: row.actualVolumeLiters ? round((actualCostCents / 100) / row.actualVolumeLiters, 2) : null,
    },
  };
}

async function batchRow(db: D1Database, batchId: string, organizationId: string): Promise<BatchRow | null> {
  return db.prepare(`${batchSelect()} WHERE f.id = ?1 AND f.organization_id = ?2`).bind(batchId, organizationId).first<BatchRow>();
}

function batchSelect(): string {
  return `SELECT f.id, f.device_id AS deviceId, d.name AS deviceName, f.name,
    f.batch_code AS batchCode, f.recipe_id AS recipeId, f.recipe_snapshot_json AS recipeSnapshotJson,
    f.equipment_name AS equipmentName, f.original_gravity AS originalGravity,
    f.planned_final_gravity AS plannedFinalGravity, f.planned_volume_liters AS plannedVolumeLiters,
    f.final_gravity AS finalGravity, f.actual_volume_liters AS actualVolumeLiters,
    f.summary_notes AS summaryNotes, f.sensory_score AS sensoryScore, f.sensory_notes AS sensoryNotes,
    f.started_at AS startedAt, f.finished_at AS finishedAt, f.created_at AS createdAt, f.updated_at AS updatedAt,
    (SELECT gravity FROM fermentation_readings r WHERE r.session_id = f.id
      ORDER BY r.measured_at DESC, r.created_at DESC LIMIT 1) AS latestGravity,
    COALESCE((SELECT SUM(i.planned_cost_cents) FROM batch_ingredients i WHERE i.session_id = f.id), 0) AS plannedCostCents,
    COALESCE((SELECT SUM(COALESCE(i.actual_cost_cents, i.planned_cost_cents)) FROM batch_ingredients i WHERE i.session_id = f.id), 0) AS actualCostCents
    FROM fermentation_sessions f JOIN devices d ON d.id = f.device_id`;
}

async function attachmentRow(db: D1Database, batchId: string, attachmentId: string, organizationId: string): Promise<{ objectKey: string; fileName: string } | null> {
  return db.prepare(`SELECT a.object_key AS objectKey, a.file_name AS fileName
    FROM batch_attachments a JOIN fermentation_sessions f ON f.id = a.session_id
    WHERE a.id = ?1 AND a.session_id = ?2 AND f.organization_id = ?3`)
    .bind(attachmentId, batchId, organizationId).first<{ objectKey: string; fileName: string }>();
}

async function contextForRequest(request: Request, env: Env): Promise<{ session: SessionContext; organizationId: string }> {
  const session = await requireSession(request, env);
  return { session, organizationId: selectOrganization(session, new URL(request.url).searchParams.get("organizationId")) };
}

async function writeContext(request: Request, env: Env, rawOrganizationId: unknown): Promise<{ session: SessionContext; organizationId: string }> {
  const session = await requireSession(request, env);
  const organizationId = selectOrganization(session, typeof rawOrganizationId === "string" ? rawOrganizationId : null);
  const membership = session.memberships.find((item) => item.organizationId === organizationId);
  if (!membership || membership.role === "viewer") throw new ApiError(403, "BATCH_WRITE_DENIED", "Seu perfil nao pode alterar lotes.");
  return { session, organizationId };
}

function presentIngredient(row: IngredientRow): Record<string, unknown> {
  return { ...row, plannedCost: row.plannedCostCents / 100, actualCost: row.actualCostCents === null ? null : row.actualCostCents / 100 };
}

function randomId(prefix: string): string { return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`; }
function epochSeconds(): number { return Math.floor(Date.now() / 1000); }
function round(value: number, digits: number): number { const factor = 10 ** digits; return Math.round(value * factor) / factor; }

function objectValue(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ApiError(400, "INVALID_BODY", "O corpo da requisicao e invalido.");
  return value as Record<string, unknown>;
}

function requiredText(value: unknown, minimum: number, maximum: number, field: string): string {
  if (typeof value !== "string") throw new ApiError(400, "INVALID_FIELD", `Campo invalido: ${field}.`);
  const normalized = value.trim();
  if (normalized.length < minimum || normalized.length > maximum) throw new ApiError(400, "INVALID_FIELD", `Campo invalido: ${field}.`);
  return normalized;
}

function optionalText(value: unknown, fallback: string, minimum: number, maximum: number, field: string): string {
  return value === undefined ? fallback : requiredText(value, minimum, maximum, field);
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) throw new ApiError(400, "INVALID_FIELD", `Campo invalido: ${field}.`);
  return value as T;
}

function optionalGravity(value: unknown, fallback: number | null): number | null {
  if (value === undefined) return fallback;
  if (value === null || value === "") return null;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new ApiError(400, "INVALID_GRAVITY", "Densidade invalida.");
  const rounded = round(value, 3);
  if (rounded < 0.990 || rounded > 1.200 || Math.abs(value - rounded) > 0.000_000_1) throw new ApiError(400, "INVALID_GRAVITY", "Use densidade entre 0,990 e 1,200.");
  return rounded;
}

function optionalPositive(value: unknown, fallback: number | null, maximum: number, field: string): number | null {
  if (value === undefined) return fallback;
  if (value === null || value === "") return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > maximum) throw new ApiError(400, "INVALID_FIELD", `Campo invalido: ${field}.`);
  return round(value, 3);
}

function optionalInteger(value: unknown, fallback: number | null, minimum: number, maximum: number, field: string): number | null {
  if (value === undefined) return fallback;
  if (value === null || value === "") return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum || value > maximum) throw new ApiError(400, "INVALID_FIELD", `Campo invalido: ${field}.`);
  return value;
}

function nonNegative(value: unknown, maximum: number, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > maximum) throw new ApiError(400, "INVALID_FIELD", `Campo invalido: ${field}.`);
  return round(value, 3);
}

function nullableNonNegative(value: unknown, maximum: number, field: string): number | null {
  if (value === undefined || value === null || value === "") return null;
  return nonNegative(value, maximum, field);
}

function moneyValue(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 10_000_000) throw new ApiError(400, "INVALID_FIELD", `Campo invalido: ${field}.`);
  return Math.round(value * 100);
}

function nullableMoneyValue(value: unknown, field: string): number | null {
  if (value === undefined || value === null || value === "") return null;
  return moneyValue(value, field);
}

function timestampValue(value: unknown, now: number): number {
  if (value === undefined) return now;
  if (typeof value !== "number" || !Number.isInteger(value) || value < now - 5 * 365 * 24 * 60 * 60 || value > now + 300) throw new ApiError(400, "INVALID_TIMESTAMP", "Data e hora invalidas.");
  return value;
}

function decodedFileName(value: string | null): string {
  if (!value) throw new ApiError(400, "MISSING_FILE_NAME", "Informe o nome do arquivo.");
  let decoded: string;
  try { decoded = decodeURIComponent(value); } catch { throw new ApiError(400, "INVALID_FILE_NAME", "Nome de arquivo invalido."); }
  const safe = decoded.replace(/[\\/\u0000-\u001f]/gu, "_").trim();
  if (safe.length < 1 || safe.length > 180) throw new ApiError(400, "INVALID_FILE_NAME", "Nome de arquivo invalido.");
  return safe;
}

function parseJson(value: string): unknown {
  try { return JSON.parse(value); } catch { return {}; }
}

function validateId(value: string, pattern: RegExp, code: string, message: string): void {
  if (!pattern.test(value)) throw new ApiError(400, code, message);
}

function auditStatement(
  db: D1Database, organizationId: string, userId: string, deviceId: string,
  action: string, details: Record<string, unknown>, now: number,
): D1PreparedStatement {
  return db.prepare(`INSERT INTO audit_log
    (organization_id, user_id, device_id, action, details_json, created_at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6)`).bind(organizationId, userId, deviceId, action, JSON.stringify(details), now);
}
