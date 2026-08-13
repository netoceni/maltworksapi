import { randomId } from "./crypto";
import { jsonResponse, readJson } from "./http";
import { ApiError } from "./types";

const DUPLICATE_WINDOW_SECONDS = 60 * 60;

interface SalesLeadInput {
  name: string;
  email: string;
  phone: string;
  consent: true;
  website: string;
}

export async function createSalesLead(
  request: Request,
  env: Env,
  requestId: string,
): Promise<Response> {
  const body = await readJson(request, 4_096);

  // Campo invisivel: bots recebem uma resposta normal sem gerar lead ou e-mail.
  if (honeypotValue(body)) return acceptedResponse(requestId);
  const lead = salesLeadInput(body);

  const now = Math.floor(Date.now() / 1_000);
  const duplicate = await env.DB.prepare(
    `SELECT id FROM sales_leads
      WHERE (email = ?1 COLLATE NOCASE OR phone = ?2)
        AND created_at >= ?3
      LIMIT 1`,
  ).bind(lead.email, lead.phone, now - DUPLICATE_WINDOW_SECONDS).first<{ id: string }>();

  if (duplicate) return acceptedResponse(requestId);

  const leadId = randomId("lead");
  const emailFrom = env.SALES_EMAIL_FROM?.trim();
  const emailTo = env.SALES_EMAIL_TO?.trim();
  const emailConfigured = Boolean(emailFrom && emailTo);
  const notificationStatus = emailConfigured ? "pending" : "not_configured";

  await env.DB.prepare(
    `INSERT INTO sales_leads (
       id, name, email, phone, source, status, consent_at,
       notification_status, notification_id, notification_error,
       created_at, updated_at
     ) VALUES (?1, ?2, ?3, ?4, 'login-page', 'new', ?5, ?6, NULL, NULL, ?5, ?5)`,
  ).bind(leadId, lead.name, lead.email, lead.phone, now, notificationStatus).run();

  if (emailConfigured) {
    await notifySalesTeam(env, leadId, lead, emailFrom!, emailTo!, now);
  }

  return acceptedResponse(requestId);
}

async function notifySalesTeam(
  env: Env,
  leadId: string,
  lead: SalesLeadInput,
  from: string,
  to: string,
  now: number,
): Promise<void> {
  try {
    const text = [
      "Um novo contato comercial foi recebido pelo painel Maltworks.",
      "",
      `Nome: ${lead.name}`,
      `E-mail: ${lead.email}`,
      `Celular: ${lead.phone}`,
      `Lead ID: ${leadId}`,
    ].join("\n");
    const response = await env.EMAIL.send({
      from: { email: from, name: "Maltworks" },
      to,
      replyTo: lead.email,
      subject: "Novo contato comercial - Maltworks",
      text,
      html: [
        "<p>Um novo contato comercial foi recebido pelo painel Maltworks.</p>",
        `<p><strong>Nome:</strong> ${escapeHtml(lead.name)}<br>`,
        `<strong>E-mail:</strong> ${escapeHtml(lead.email)}<br>`,
        `<strong>Celular:</strong> ${escapeHtml(lead.phone)}<br>`,
        `<strong>Lead ID:</strong> ${escapeHtml(leadId)}</p>`,
      ].join(""),
    });
    const notificationId = response.messageId?.slice(0, 120) ?? null;
    await updateNotification(env.DB, leadId, "sent", notificationId, null, now);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Falha desconhecida no envio.";
    console.error("Sales lead notification failed", { leadId, error: message });
    await updateNotification(env.DB, leadId, "failed", null, message.slice(0, 400), now);
  }
}

async function updateNotification(
  db: D1Database,
  leadId: string,
  status: "sent" | "failed",
  notificationId: string | null,
  error: string | null,
  now: number,
): Promise<void> {
  await db.prepare(
    `UPDATE sales_leads
        SET notification_status = ?2, notification_id = ?3,
            notification_error = ?4, updated_at = ?5
      WHERE id = ?1`,
  ).bind(leadId, status, notificationId, error, now).run();
}

function salesLeadInput(value: unknown): SalesLeadInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(400, "INVALID_SALES_LEAD", "Preencha os dados para contato.");
  }
  const body = value as Record<string, unknown>;
  const name = requiredString(body.name, "nome", 2, 100).replace(/\s+/gu, " ");
  const email = requiredString(body.email, "e-mail", 5, 254).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)) {
    throw new ApiError(400, "INVALID_EMAIL", "Informe um e-mail valido.");
  }

  const phone = normalizedPhone(requiredString(body.phone, "celular", 10, 24));
  if (body.consent !== true) {
    throw new ApiError(400, "CONSENT_REQUIRED", "Autorize o contato para continuar.");
  }

  const website = typeof body.website === "string" ? body.website.trim().slice(0, 200) : "";
  return { name, email, phone, consent: true, website };
}

function honeypotValue(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const website = (value as Record<string, unknown>).website;
  return typeof website === "string" ? website.trim() : "";
}

function normalizedPhone(value: string): string {
  const digits = value.replace(/\D/gu, "");
  const international = (digits.length === 10 || digits.length === 11) ? `55${digits}` : digits;
  if (international.length < 12 || international.length > 15) {
    throw new ApiError(400, "INVALID_PHONE", "Informe um celular com DDD.");
  }
  return `+${international}`;
}

function requiredString(
  value: unknown,
  label: string,
  minimumLength: number,
  maximumLength: number,
): string {
  if (typeof value !== "string") {
    throw new ApiError(400, "INVALID_SALES_LEAD", `Informe o ${label}.`);
  }
  const normalized = value.trim();
  if (normalized.length < minimumLength || normalized.length > maximumLength) {
    throw new ApiError(400, "INVALID_SALES_LEAD", `Revise o campo ${label}.`);
  }
  return normalized;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function acceptedResponse(requestId: string): Response {
  return jsonResponse(
    {
      ok: true,
      accepted: true,
      message: "Recebemos seus dados. A equipe Maltworks entrara em contato.",
      requestId,
    },
    202,
  );
}
