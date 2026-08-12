import { constantTimeEqual, hashPassword, randomId, randomToken, sha256Hex, verifyPassword } from "./crypto";
import {
  clearSessionCookie,
  getBearerToken,
  getCookie,
  jsonResponse,
  readJson,
  sessionCookie,
} from "./http";
import { ApiError, type SessionContext } from "./types";

const SESSION_COOKIE = "mw_session";

export async function signup(request: Request, env: Env, requestId: string): Promise<Response> {
  const body = objectValue(await readJson(request));
  const displayName = requiredString(body.displayName, "displayName", 3, 100);
  const birthDate = birthDateValue(body.birthDate);
  const phone = optionalPhone(body.phone);
  const email = normalizedEmail(body.email);
  const password = passwordValue(body.password);
  if (body.termsAccepted !== true) {
    throw new ApiError(400, "TERMS_REQUIRED", "Aceite os termos de uso e a politica de privacidade.");
  }

  const existing = await env.DB.prepare(
    "SELECT id FROM users WHERE email = ?1",
  ).bind(email).first<{ id: string }>();
  if (existing) {
    throw new ApiError(409, "EMAIL_ALREADY_REGISTERED", "Ja existe uma conta com este e-mail.");
  }

  const now = Math.floor(Date.now() / 1000);
  const organizationId = randomId("org");
  const userId = randomId("usr");
  const passwordData = await hashPassword(password, passwordPepper(env));
  const session = await createSession(env, userId, now);
  const firstName = displayName.split(/\s+/u)[0] || "Cliente";

  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO organizations (id, name, slug, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?4)`,
      ).bind(
        organizationId,
        `${firstName} - Maltworks`,
        `cliente-${organizationId.slice(-12)}`,
        now,
      ),
      env.DB.prepare(
        `INSERT INTO users (
           id, email, password_hash, password_salt, password_iterations,
           display_name, birth_date, phone, terms_accepted_at,
           created_at, updated_at, last_login_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9, ?9, ?9)`,
      ).bind(
        userId,
        email,
        passwordData.hash,
        passwordData.salt,
        passwordData.iterations,
        displayName,
        birthDate,
        phone,
        now,
      ),
      env.DB.prepare(
        `INSERT INTO organization_members (organization_id, user_id, role, created_at)
         VALUES (?1, ?2, 'owner', ?3)`,
      ).bind(organizationId, userId, now),
      session.statement,
    ]);
  } catch (error) {
    if (String(error).toLowerCase().includes("unique")) {
      throw new ApiError(409, "EMAIL_ALREADY_REGISTERED", "Ja existe uma conta com este e-mail.");
    }
    throw error;
  }

  return jsonResponse(
    {
      ok: true,
      user: { id: userId, email, displayName, birthDate, phone },
      organization: {
        id: organizationId,
        name: `${firstName} - Maltworks`,
        role: "owner",
      },
      requestId,
    },
    201,
    { "Set-Cookie": sessionCookie(session.token, session.maxAgeSeconds) },
  );
}

export async function bootstrap(request: Request, env: Env, requestId: string): Promise<Response> {
  if (!env.BOOTSTRAP_SECRET || env.BOOTSTRAP_SECRET.length < 24) {
    throw new ApiError(503, "BOOTSTRAP_NOT_CONFIGURED", "O segredo inicial do servidor nao foi configurado.");
  }

  const supplied = getBearerToken(request) ?? "";
  const [expectedHash, suppliedHash] = await Promise.all([
    sha256Hex(env.BOOTSTRAP_SECRET),
    sha256Hex(supplied),
  ]);
  if (!constantTimeEqual(expectedHash, suppliedHash)) {
    throw new ApiError(401, "BOOTSTRAP_AUTHENTICATION_FAILED", "Credencial de inicializacao rejeitada.");
  }

  const count = await env.DB.prepare("SELECT COUNT(*) AS count FROM users").first<{ count: number }>();
  if ((count?.count ?? 0) > 0) {
    throw new ApiError(409, "BOOTSTRAP_ALREADY_COMPLETED", "O usuario inicial ja foi criado.");
  }

  const body = objectValue(await readJson(request));
  const organizationName = requiredString(body.organizationName, "organizationName", 2, 80);
  const displayName = requiredString(body.displayName, "displayName", 2, 80);
  const email = normalizedEmail(body.email);
  const password = passwordValue(body.password);
  const now = Math.floor(Date.now() / 1000);
  const organizationId = randomId("org");
  const userId = randomId("usr");
  const passwordData = await hashPassword(password, passwordPepper(env));
  const session = await createSession(env, userId, now);

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO organizations (id, name, slug, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?4)`,
    ).bind(organizationId, organizationName, `principal-${organizationId.slice(-12)}`, now),
    env.DB.prepare(
      `INSERT INTO users (
         id, email, password_hash, password_salt, password_iterations,
         display_name, created_at, updated_at, last_login_at
       ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7, ?7)`,
    ).bind(
      userId,
      email,
      passwordData.hash,
      passwordData.salt,
      passwordData.iterations,
      displayName,
      now,
    ),
    env.DB.prepare(
      `INSERT INTO organization_members (organization_id, user_id, role, created_at)
       VALUES (?1, ?2, 'owner', ?3)`,
    ).bind(organizationId, userId, now),
    env.DB.prepare(
      `INSERT INTO system_admins (user_id, role, created_at)
       VALUES (?1, 'superadmin', ?2)`,
    ).bind(userId, now),
    session.statement,
  ]);

  return jsonResponse(
    {
      ok: true,
      user: { id: userId, email, displayName },
      organization: { id: organizationId, name: organizationName, role: "owner" },
      requestId,
    },
    201,
    { "Set-Cookie": sessionCookie(session.token, session.maxAgeSeconds) },
  );
}

export async function login(request: Request, env: Env, requestId: string): Promise<Response> {
  const body = objectValue(await readJson(request));
  const email = normalizedEmail(body.email);
  const password = typeof body.password === "string" ? body.password : "";

  const user = await env.DB.prepare(
    `SELECT id, email, display_name AS displayName, password_hash AS passwordHash,
            password_salt AS passwordSalt, password_iterations AS passwordIterations
       FROM users
      WHERE email = ?1`,
  ).bind(email).first<{
    id: string;
    email: string;
    displayName: string;
    passwordHash: string;
    passwordSalt: string;
    passwordIterations: number;
  }>();

  const valid = await verifyPassword(
    password,
    passwordPepper(env),
    user?.passwordHash ?? "0".repeat(64),
    user?.passwordSalt ?? "0".repeat(32),
    user?.passwordIterations ?? 100_000,
  );
  if (!user || !valid) {
    throw new ApiError(401, "INVALID_CREDENTIALS", "E-mail ou senha invalidos.");
  }

  const now = Math.floor(Date.now() / 1000);
  const session = await createSession(env, user.id, now);
  await env.DB.batch([
    session.statement,
    env.DB.prepare("UPDATE users SET last_login_at = ?2, updated_at = ?2 WHERE id = ?1")
      .bind(user.id, now),
  ]);

  return jsonResponse(
    {
      ok: true,
      user: { id: user.id, email: user.email, displayName: user.displayName },
      requestId,
    },
    200,
    { "Set-Cookie": sessionCookie(session.token, session.maxAgeSeconds) },
  );
}

export async function resetPassword(
  request: Request,
  env: Env,
  requestId: string,
): Promise<Response> {
  if (!env.PASSWORD_RESET_SECRET || env.PASSWORD_RESET_SECRET.length < 32) {
    throw new ApiError(
      503,
      "PASSWORD_RESET_NOT_CONFIGURED",
      "A recuperacao de senha nao esta habilitada.",
    );
  }

  const supplied = getBearerToken(request) ?? "";
  const [expectedHash, suppliedHash] = await Promise.all([
    sha256Hex(env.PASSWORD_RESET_SECRET),
    sha256Hex(supplied),
  ]);
  if (!constantTimeEqual(expectedHash, suppliedHash)) {
    throw new ApiError(
      401,
      "PASSWORD_RESET_AUTHENTICATION_FAILED",
      "Credencial de recuperacao rejeitada.",
    );
  }

  const body = objectValue(await readJson(request));
  const email = normalizedEmail(body.email);
  const newPassword = passwordValue(body.newPassword);
  const user = await env.DB.prepare(
    "SELECT id FROM users WHERE email = ?1",
  ).bind(email).first<{ id: string }>();

  if (!user) {
    throw new ApiError(404, "USER_NOT_FOUND", "Usuario nao encontrado.");
  }

  const now = Math.floor(Date.now() / 1000);
  const passwordData = await hashPassword(newPassword, passwordPepper(env));
  const results = await env.DB.batch([
    env.DB.prepare(
      `UPDATE users
          SET password_hash = ?2,
              password_salt = ?3,
              password_iterations = ?4,
              updated_at = ?5
        WHERE id = ?1`,
    ).bind(
      user.id,
      passwordData.hash,
      passwordData.salt,
      passwordData.iterations,
      now,
    ),
    env.DB.prepare(
      "DELETE FROM sessions WHERE user_id = ?1",
    ).bind(user.id),
  ]);

  if ((results[0]?.meta.changes ?? 0) !== 1) {
    throw new ApiError(500, "PASSWORD_RESET_FAILED", "A senha nao foi atualizada.");
  }

  return jsonResponse(
    {
      ok: true,
      passwordReset: true,
      sessionsRevoked: true,
      requestId,
    },
    200,
  );
}

export async function logout(request: Request, env: Env, requestId: string): Promise<Response> {
  const token = getCookie(request, SESSION_COOKIE);
  if (token) {
    const tokenHash = await sha256Hex(token);
    await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?1").bind(tokenHash).run();
  }
  return jsonResponse(
    { ok: true, requestId },
    200,
    { "Set-Cookie": clearSessionCookie() },
  );
}

export async function me(request: Request, env: Env, requestId: string): Promise<Response> {
  const session = await requireSession(request, env);
  return jsonResponse({ ok: true, user: session, requestId });
}

export async function requireSession(request: Request, env: Env): Promise<SessionContext> {
  const token = getCookie(request, SESSION_COOKIE);
  if (!token || token.length < 32 || token.length > 128) {
    throw new ApiError(401, "AUTHENTICATION_REQUIRED", "Faca login para continuar.");
  }

  const now = Math.floor(Date.now() / 1000);
  const tokenHash = await sha256Hex(token);
  const user = await env.DB.prepare(
    `SELECT u.id, u.email, u.display_name AS displayName,
            u.birth_date AS birthDate, u.phone
       FROM sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ?1 AND s.expires_at > ?2`,
  ).bind(tokenHash, now).first<{
    id: string;
    email: string;
    displayName: string;
    birthDate: string | null;
    phone: string | null;
  }>();
  if (!user) {
    throw new ApiError(401, "SESSION_EXPIRED", "Sua sessao expirou. Faca login novamente.");
  }

  const memberships = await env.DB.prepare(
    `SELECT o.id AS organizationId, o.name AS organizationName, m.role
       FROM organization_members m
       JOIN organizations o ON o.id = m.organization_id
      WHERE m.user_id = ?1
      ORDER BY m.created_at ASC`,
  ).bind(user.id).all<{
    organizationId: string;
    organizationName: string;
    role: "owner" | "admin" | "member" | "viewer";
  }>();

  return {
    userId: user.id,
    email: user.email,
    displayName: user.displayName,
    birthDate: user.birthDate,
    phone: user.phone,
    memberships: memberships.results,
  };
}

export function selectOrganization(session: SessionContext, requestedId?: unknown): string {
  if (typeof requestedId === "string" && requestedId.length > 0) {
    if (!session.memberships.some((membership) => membership.organizationId === requestedId)) {
      throw new ApiError(403, "ORGANIZATION_ACCESS_DENIED", "Voce nao possui acesso a esta organizacao.");
    }
    return requestedId;
  }

  const first = session.memberships[0];
  if (!first) throw new ApiError(403, "ORGANIZATION_REQUIRED", "O usuario nao pertence a uma organizacao.");
  return first.organizationId;
}

async function createSession(
  env: Env,
  userId: string,
  now: number,
): Promise<{ token: string; maxAgeSeconds: number; statement: D1PreparedStatement }> {
  const token = randomToken(32);
  const tokenHash = await sha256Hex(token);
  const configuredDays = Number.parseInt(env.SESSION_TTL_DAYS, 10);
  const days = Number.isFinite(configuredDays) ? Math.min(Math.max(configuredDays, 1), 90) : 30;
  const maxAgeSeconds = days * 86_400;
  return {
    token,
    maxAgeSeconds,
    statement: env.DB.prepare(
      `INSERT INTO sessions (token_hash, user_id, created_at, expires_at, last_seen_at)
       VALUES (?1, ?2, ?3, ?4, ?3)`,
    ).bind(tokenHash, userId, now, now + maxAgeSeconds),
  };
}

function objectValue(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(400, "INVALID_BODY", "O corpo da requisicao e invalido.");
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, field: string, minimum: number, maximum: number): string {
  if (typeof value !== "string") throw new ApiError(400, "INVALID_FIELD", `Campo invalido: ${field}.`);
  const normalized = value.trim();
  if (normalized.length < minimum || normalized.length > maximum) {
    throw new ApiError(400, "INVALID_FIELD", `Campo invalido: ${field}.`);
  }
  return normalized;
}

function normalizedEmail(value: unknown): string {
  const email = requiredString(value, "email", 5, 254).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new ApiError(400, "INVALID_EMAIL", "Informe um e-mail valido.");
  }
  return email;
}

function passwordValue(value: unknown): string {
  if (typeof value !== "string" || value.length < 12 || value.length > 128) {
    throw new ApiError(400, "INVALID_PASSWORD", "A senha deve ter entre 12 e 128 caracteres.");
  }
  return value;
}

function birthDateValue(value: unknown): string {
  const birthDate = requiredString(value, "birthDate", 10, 10);
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(birthDate);
  if (!match) {
    throw new ApiError(400, "INVALID_BIRTH_DATE", "Informe uma data de nascimento valida.");
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    throw new ApiError(400, "INVALID_BIRTH_DATE", "Informe uma data de nascimento valida.");
  }

  const today = new Date();
  let age = today.getUTCFullYear() - year;
  if (
    today.getUTCMonth() < month - 1 ||
    (today.getUTCMonth() === month - 1 && today.getUTCDate() < day)
  ) {
    age -= 1;
  }
  if (age < 18) {
    throw new ApiError(400, "MINIMUM_AGE_REQUIRED", "E necessario ter pelo menos 18 anos.");
  }
  if (age > 120) {
    throw new ApiError(400, "INVALID_BIRTH_DATE", "Informe uma data de nascimento valida.");
  }
  return birthDate;
}

function optionalPhone(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") {
    throw new ApiError(400, "INVALID_PHONE", "Informe um telefone valido.");
  }
  const digits = value.replace(/\D/gu, "");
  if (digits.length < 10 || digits.length > 15) {
    throw new ApiError(400, "INVALID_PHONE", "Informe um telefone valido com DDD.");
  }
  return `+${digits.startsWith("55") ? digits : `55${digits}`}`;
}

function passwordPepper(env: Env): string {
  if (!env.PASSWORD_PEPPER || env.PASSWORD_PEPPER.length < 32) {
    throw new ApiError(503, "PASSWORD_PEPPER_NOT_CONFIGURED", "A protecao de senhas do servidor nao foi configurada.");
  }
  return env.PASSWORD_PEPPER;
}
