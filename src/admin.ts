import { requireSession } from "./auth";
import { jsonResponse } from "./http";
import { ApiError, type SessionContext } from "./types";
import { readJson } from "./http";
import { randomId } from "./crypto";

type SystemRole = "superadmin" | "admin" | "support";

export interface AdminContext {
  session: SessionContext;
  role: SystemRole;
}

export async function adminMe(request: Request, env: Env, requestId: string): Promise<Response> {
  const admin = await requireSystemAdmin(request, env);
  return jsonResponse({
    ok: true,
    admin: {
      displayName: admin.session.displayName,
      accountCode: accountCode(admin.session.userId),
      role: admin.role,
    },
    requestId,
  });
}

export async function adminOverview(request: Request, env: Env, requestId: string): Promise<Response> {
  await requireSystemAdmin(request, env);
  const onlineSince = Math.floor(Date.now() / 1000) - 30;
  const [users, organizations, devices] = await Promise.all([
    env.DB.prepare("SELECT COUNT(*) AS total FROM users").first<{ total: number }>(),
    env.DB.prepare("SELECT COUNT(*) AS total FROM organizations").first<{ total: number }>(),
    env.DB.prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
              SUM(CASE WHEN status = 'active' AND last_seen_at >= ?1 THEN 1 ELSE 0 END) AS online
         FROM devices`,
    ).bind(onlineSince).first<{ total: number; pending: number | null; online: number | null }>(),
  ]);

  return jsonResponse({
    ok: true,
    overview: {
      users: users?.total ?? 0,
      organizations: organizations?.total ?? 0,
      devices: devices?.total ?? 0,
      devicesOnline: devices?.online ?? 0,
      devicesPending: devices?.pending ?? 0,
      onlineWindowSeconds: 30,
    },
    requestId,
  });
}

export async function adminListUsers(request: Request, env: Env, requestId: string): Promise<Response> {
  await requireSystemAdmin(request, env);
  const url = new URL(request.url);
  const page = boundedInteger(url.searchParams.get("page"), 1, 100_000, 1);
  const limit = boundedInteger(url.searchParams.get("limit"), 1, 100, 25);
  const offset = (page - 1) * limit;
  const onlineSince = Math.floor(Date.now() / 1000) - 30;

  const [total, rows] = await Promise.all([
    env.DB.prepare("SELECT COUNT(*) AS total FROM users").first<{ total: number }>(),
    env.DB.prepare(
      `SELECT u.id,
              u.created_at AS createdAt,
              COUNT(DISTINCT om.organization_id) AS organizationCount,
              COUNT(DISTINCT d.id) AS deviceCount,
              COUNT(DISTINCT CASE
                WHEN d.status = 'active' AND d.last_seen_at >= ?1 THEN d.id
                ELSE NULL
              END) AS onlineDeviceCount
         FROM users u
         LEFT JOIN organization_members om ON om.user_id = u.id
         LEFT JOIN devices d ON d.organization_id = om.organization_id
        GROUP BY u.id, u.created_at
        ORDER BY u.created_at DESC, u.id DESC
        LIMIT ?2 OFFSET ?3`,
    ).bind(onlineSince, limit, offset).all<{
      id: string;
      createdAt: number;
      organizationCount: number;
      deviceCount: number;
      onlineDeviceCount: number;
    }>(),
  ]);

  const totalUsers = total?.total ?? 0;
  return jsonResponse({
    ok: true,
    users: rows.results.map((row) => ({
      accountCode: accountCode(row.id),
      createdAt: row.createdAt,
      organizationCount: row.organizationCount,
      deviceCount: row.deviceCount,
      onlineDeviceCount: row.onlineDeviceCount,
    })),
    pagination: {
      page,
      limit,
      total: totalUsers,
      pages: Math.max(1, Math.ceil(totalUsers / limit)),
    },
    privacy: {
      personalDataIncluded: false,
      fieldsOmitted: ["email", "displayName", "password", "sessions", "tokens"],
    },
    requestId,
  });
}

const SALES_STATUSES = ["new", "contacted", "reserved", "paid", "shipped"] as const;
type SalesStatus = typeof SALES_STATUSES[number];
const salesStatusLabel: Record<SalesStatus, string> = { new: "NOVO", contacted: "CONTATADO", reserved: "RESERVADO", paid: "PAGO", shipped: "ENVIADO" };

export async function adminListSalesLeads(request: Request, env: Env, requestId: string): Promise<Response> {
  await requireSystemAdmin(request, env);
  const url = new URL(request.url);
  const limit = boundedInteger(url.searchParams.get("limit"), 1, 100, 50);
  const status = url.searchParams.get("status");
  const where = status && SALES_STATUSES.includes(status as SalesStatus) ? "WHERE status = ?1" : "";
  const query = `SELECT id, name, email, phone, product, city, quantity, source, campaign, status, created_at AS createdAt, updated_at AS updatedAt
    FROM sales_leads ${where} ORDER BY created_at DESC, id DESC LIMIT ?${where ? 2 : 1}`;
  const stmt = where ? env.DB.prepare(query).bind(status, limit) : env.DB.prepare(query).bind(limit);
  const rows = await stmt.all<Record<string, unknown>>();
  return jsonResponse({ ok: true, leads: rows.results.map((row) => ({ ...row, status: salesStatusLabel[(row.status as SalesStatus)] ?? "NOVO" })), requestId });
}

export async function adminUpdateSalesLead(request: Request, env: Env, requestId: string, leadId: string): Promise<Response> {
  const admin = await requireSystemAdmin(request, env);
  const body = await readJson(request, 2_048);
  const status = body && typeof body === "object" ? (body as Record<string, unknown>).status : null;
  const normalized = typeof status === "string" ? status.toLowerCase() : "";
  if (!SALES_STATUSES.includes(normalized as SalesStatus)) throw new ApiError(400, "INVALID_SALES_STATUS", "Status de pré-venda inválido.");
  const now = Math.floor(Date.now() / 1000);
  const current = await env.DB.prepare("SELECT status FROM sales_leads WHERE id = ?1").bind(leadId).first<{ status: SalesStatus }>();
  if (!current) throw new ApiError(404, "SALES_LEAD_NOT_FOUND", "Lead de pré-venda não encontrado.");
  if (current.status !== normalized) {
    await env.DB.batch([
      env.DB.prepare("UPDATE sales_leads SET status = ?2, updated_at = ?3 WHERE id = ?1").bind(leadId, normalized, now),
      env.DB.prepare("INSERT INTO sales_lead_events (id, lead_id, from_status, to_status, changed_by, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)").bind(randomId("leadv"), leadId, current.status, normalized, admin.session.userId, now),
    ]);
  }
  return jsonResponse({ ok: true, leadId, status: salesStatusLabel[normalized as SalesStatus], updatedAt: now, requestId });
}

export async function requireSystemAdmin(request: Request, env: Env): Promise<AdminContext> {
  const session = await requireSession(request, env);
  const admin = await env.DB.prepare(
    "SELECT role FROM system_admins WHERE user_id = ?1",
  ).bind(session.userId).first<{ role: SystemRole }>();

  if (!admin) {
    throw new ApiError(403, "SYSTEM_ADMIN_REQUIRED", "Acesso restrito a administradores do sistema.");
  }
  return { session, role: admin.role };
}

function accountCode(userId: string): string {
  return `MWU-${userId.slice(-8).toUpperCase()}`;
}

function boundedInteger(value: string | null, minimum: number, maximum: number, fallback: number): number {
  if (value === null || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new ApiError(400, "INVALID_PAGINATION", "Paginacao invalida.");
  }
  return parsed;
}
