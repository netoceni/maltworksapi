import { requireSession, selectOrganization } from "./auth";
import { jsonResponse, readJson } from "./http";
import { ApiError, type SessionContext } from "./types";

const RECIPE_ID_PATTERN = /^rcp_[0-9a-f]{32}$/;
const MAXIMUM_RECIPES = 100;
const MAXIMUM_STAGES = 8;
const MAXIMUM_STAGE_SECONDS = 90 * 24 * 60 * 60;

export interface CloudRecipeStage {
  position: number;
  name: string;
  targetTemperature: number;
  durationSeconds: number;
}

export interface CloudRecipe {
  id: string;
  name: string;
  description: string;
  version: number;
  createdAt: number;
  updatedAt: number;
  stages: CloudRecipeStage[];
}

interface RecipeInput {
  name: string;
  description: string;
  stages: CloudRecipeStage[];
}

export async function listRecipes(
  request: Request,
  env: Env,
  requestId: string,
): Promise<Response> {
  const session = await requireSession(request, env);
  const organizationId = selectOrganization(
    session,
    new URL(request.url).searchParams.get("organizationId"),
  );
  const recipes = await recipesForOrganization(env.DB, organizationId);
  return jsonResponse({ ok: true, recipes, requestId });
}

export async function createRecipe(
  request: Request,
  env: Env,
  requestId: string,
): Promise<Response> {
  const session = await requireSession(request, env);
  const raw = objectValue(await readJson(request));
  const organizationId = selectOrganization(session, raw.organizationId);
  requireWriteAccess(session, organizationId);
  const input = recipeInput(raw);
  const currentCount = await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM cloud_recipes WHERE organization_id = ?1",
  ).bind(organizationId).first<{ count: number }>();
  if ((currentCount?.count ?? 0) >= MAXIMUM_RECIPES) {
    throw new ApiError(409, "RECIPE_LIMIT_REACHED", "A organizacao atingiu o limite de receitas.");
  }

  const recipeId = `rcp_${crypto.randomUUID().replaceAll("-", "")}`;
  const now = Math.floor(Date.now() / 1000);
  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO cloud_recipes (
           id, organization_id, created_by_user_id, name, description,
           version, created_at, updated_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, 1, ?6, ?6)`,
      ).bind(recipeId, organizationId, session.userId, input.name, input.description, now),
      ...stageInsertStatements(env.DB, recipeId, input.stages),
      auditStatement(
        env.DB,
        organizationId,
        session.userId,
        "recipe.created",
        { recipeId, name: input.name, stageCount: input.stages.length },
        now,
      ),
    ]);
  } catch (error) {
    translateRecipeConstraint(error);
  }

  const recipe = await recipeById(env.DB, recipeId, organizationId);
  return jsonResponse({ ok: true, recipe, requestId }, 201);
}

export async function updateRecipe(
  request: Request,
  env: Env,
  requestId: string,
  recipeId: string,
): Promise<Response> {
  validateRecipeId(recipeId);
  const session = await requireSession(request, env);
  const raw = objectValue(await readJson(request));
  const organizationId = selectOrganization(session, raw.organizationId);
  requireWriteAccess(session, organizationId);
  const input = recipeInput(raw);
  const existing = await recipeById(env.DB, recipeId, organizationId);
  if (!existing) throw new ApiError(404, "RECIPE_NOT_FOUND", "Receita nao encontrada.");
  const now = Math.floor(Date.now() / 1000);

  try {
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE cloud_recipes
            SET name = ?3, description = ?4, version = version + 1, updated_at = ?5
          WHERE id = ?1 AND organization_id = ?2`,
      ).bind(recipeId, organizationId, input.name, input.description, now),
      env.DB.prepare("DELETE FROM cloud_recipe_stages WHERE recipe_id = ?1").bind(recipeId),
      ...stageInsertStatements(env.DB, recipeId, input.stages),
      auditStatement(
        env.DB,
        organizationId,
        session.userId,
        "recipe.updated",
        { recipeId, name: input.name, stageCount: input.stages.length },
        now,
      ),
    ]);
  } catch (error) {
    translateRecipeConstraint(error);
  }

  const recipe = await recipeById(env.DB, recipeId, organizationId);
  return jsonResponse({ ok: true, recipe, requestId });
}

export async function deleteRecipe(
  request: Request,
  env: Env,
  requestId: string,
  recipeId: string,
): Promise<Response> {
  validateRecipeId(recipeId);
  const session = await requireSession(request, env);
  const organizationId = selectOrganization(
    session,
    new URL(request.url).searchParams.get("organizationId"),
  );
  requireWriteAccess(session, organizationId);
  const existing = await recipeById(env.DB, recipeId, organizationId);
  if (!existing) throw new ApiError(404, "RECIPE_NOT_FOUND", "Receita nao encontrada.");
  const now = Math.floor(Date.now() / 1000);
  await env.DB.batch([
    env.DB.prepare(
      "DELETE FROM cloud_recipes WHERE id = ?1 AND organization_id = ?2",
    ).bind(recipeId, organizationId),
    auditStatement(
      env.DB,
      organizationId,
      session.userId,
      "recipe.deleted",
      { recipeId, name: existing.name },
      now,
    ),
  ]);
  return jsonResponse({ ok: true, deleted: true, recipeId, requestId });
}

export async function recipeById(
  db: D1Database,
  recipeId: string,
  organizationId: string,
): Promise<CloudRecipe | null> {
  const row = await db.prepare(
    `SELECT id, name, description, version,
            created_at AS createdAt, updated_at AS updatedAt
       FROM cloud_recipes
      WHERE id = ?1 AND organization_id = ?2`,
  ).bind(recipeId, organizationId).first<Omit<CloudRecipe, "stages">>();
  if (!row) return null;
  const stages = await stagesForRecipe(db, recipeId);
  return { ...row, stages };
}

async function recipesForOrganization(
  db: D1Database,
  organizationId: string,
): Promise<CloudRecipe[]> {
  const [recipeRows, stageRows] = await Promise.all([
    db.prepare(
    `SELECT id, name, description, version,
            created_at AS createdAt, updated_at AS updatedAt
       FROM cloud_recipes
      WHERE organization_id = ?1
      ORDER BY name COLLATE NOCASE ASC
      LIMIT ?2`,
    ).bind(organizationId, MAXIMUM_RECIPES).all<Omit<CloudRecipe, "stages">>(),
    db.prepare(
      `SELECT s.recipe_id AS recipeId, s.position, s.name,
              s.target_temperature AS targetTemperature,
              s.duration_seconds AS durationSeconds
         FROM cloud_recipe_stages s
         JOIN cloud_recipes r ON r.id = s.recipe_id
        WHERE r.organization_id = ?1
        ORDER BY s.recipe_id ASC, s.position ASC`,
    ).bind(organizationId).all<CloudRecipeStage & { recipeId: string }>(),
  ]);
  const stagesByRecipe = new Map<string, CloudRecipeStage[]>();
  for (const row of stageRows.results) {
    const stages = stagesByRecipe.get(row.recipeId) ?? [];
    stages.push({
      position: row.position,
      name: row.name,
      targetTemperature: row.targetTemperature,
      durationSeconds: row.durationSeconds,
    });
    stagesByRecipe.set(row.recipeId, stages);
  }
  return recipeRows.results.map((row) => ({
    ...row,
    stages: stagesByRecipe.get(row.id) ?? [],
  }));
}

async function stagesForRecipe(db: D1Database, recipeId: string): Promise<CloudRecipeStage[]> {
  const result = await db.prepare(
    `SELECT position, name, target_temperature AS targetTemperature,
            duration_seconds AS durationSeconds
       FROM cloud_recipe_stages
      WHERE recipe_id = ?1
      ORDER BY position ASC`,
  ).bind(recipeId).all<CloudRecipeStage>();
  return result.results;
}

function stageInsertStatements(
  db: D1Database,
  recipeId: string,
  stages: CloudRecipeStage[],
): D1PreparedStatement[] {
  return stages.map((stage) => db.prepare(
    `INSERT INTO cloud_recipe_stages (
       recipe_id, position, name, target_temperature, duration_seconds
     ) VALUES (?1, ?2, ?3, ?4, ?5)`,
  ).bind(recipeId, stage.position, stage.name, stage.targetTemperature, stage.durationSeconds));
}

function recipeInput(body: Record<string, unknown>): RecipeInput {
  const name = normalizedText(body.name, "name", 2, 31);
  if (
    /["\\\u0000-\u001f]/u.test(name) ||
    new TextEncoder().encode(name).byteLength > 31
  ) {
    throw new ApiError(400, "INVALID_RECIPE_NAME", "O nome da receita contem caracteres invalidos.");
  }
  const description = body.description === undefined
    ? ""
    : normalizedText(body.description, "description", 0, 240, true);
  if (!Array.isArray(body.stages) || body.stages.length < 1 || body.stages.length > MAXIMUM_STAGES) {
    throw new ApiError(400, "INVALID_RECIPE_STAGES", "A receita deve possuir entre 1 e 8 etapas.");
  }
  const stages = body.stages.map((value, position) => stageValue(value, position));
  return { name, description, stages };
}

function stageValue(value: unknown, position: number): CloudRecipeStage {
  const stage = objectValue(value);
  const name = normalizedText(stage.name ?? `Etapa ${position + 1}`, `stages[${position}].name`, 1, 40);
  const target = stage.targetTemperature;
  if (typeof target !== "number" || !Number.isFinite(target) || target < -10 || target > 40) {
    throw new ApiError(400, "INVALID_STAGE_TEMPERATURE", "A temperatura deve estar entre -10,0 e 40,0 C.");
  }
  const roundedTarget = Math.round(target * 10) / 10;
  if (Math.abs(target - roundedTarget) > 0.000_001) {
    throw new ApiError(400, "INVALID_STAGE_TEMPERATURE", "Use uma casa decimal na temperatura.");
  }
  const duration = stage.durationSeconds;
  if (
    typeof duration !== "number" || !Number.isInteger(duration) ||
    duration < 60 || duration > MAXIMUM_STAGE_SECONDS || duration % 60 !== 0
  ) {
    throw new ApiError(400, "INVALID_STAGE_DURATION", "A duracao deve ser informada em minutos, entre 1 minuto e 90 dias.");
  }
  return { position, name, targetTemperature: roundedTarget, durationSeconds: duration };
}

function objectValue(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(400, "INVALID_BODY", "O corpo da requisicao e invalido.");
  }
  return value as Record<string, unknown>;
}

function normalizedText(
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

function requireWriteAccess(session: SessionContext, organizationId: string): void {
  const membership = session.memberships.find((item) => item.organizationId === organizationId);
  if (!membership || membership.role === "viewer") {
    throw new ApiError(403, "RECIPE_WRITE_DENIED", "Seu perfil nao pode alterar receitas.");
  }
}

function validateRecipeId(recipeId: string): void {
  if (!RECIPE_ID_PATTERN.test(recipeId)) {
    throw new ApiError(400, "INVALID_RECIPE_ID", "Identificador de receita invalido.");
  }
}

function translateRecipeConstraint(error: unknown): never {
  if (error instanceof Error && error.message.toLowerCase().includes("unique")) {
    throw new ApiError(409, "RECIPE_NAME_IN_USE", "Ja existe uma receita com este nome.");
  }
  throw error;
}

function auditStatement(
  db: D1Database,
  organizationId: string,
  userId: string,
  action: string,
  details: Record<string, unknown>,
  now: number,
): D1PreparedStatement {
  return db.prepare(
    `INSERT INTO audit_log (
       organization_id, user_id, device_id, action, details_json, created_at
     ) VALUES (?1, ?2, NULL, ?3, ?4, ?5)`,
  ).bind(organizationId, userId, action, JSON.stringify(details), now);
}
