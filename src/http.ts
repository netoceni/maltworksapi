import { ApiError } from "./types";

const JSON_CONTENT_TYPE = "application/json; charset=utf-8";

export function jsonResponse(
  data: unknown,
  status = 200,
  extraHeaders?: HeadersInit,
): Response {
  const headers = new Headers(extraHeaders);
  headers.set("Content-Type", JSON_CONTENT_TYPE);
  headers.set("Cache-Control", "no-store");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "no-referrer");
  return new Response(JSON.stringify(data), { status, headers });
}

export function errorResponse(error: unknown, requestId: string): Response {
  if (error instanceof ApiError) {
    return jsonResponse(
      {
        ok: false,
        error: { code: error.code, message: error.message },
        requestId,
      },
      error.status,
    );
  }

  console.error("Unhandled API error", { requestId, error });
  return jsonResponse(
    {
      ok: false,
      error: {
        code: "INTERNAL_ERROR",
        message: "Erro interno do servidor.",
      },
      requestId,
    },
    500,
  );
}

export async function readJson(request: Request, maximumBytes = 16_384): Promise<unknown> {
  const contentType = request.headers.get("Content-Type") ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    throw new ApiError(415, "UNSUPPORTED_MEDIA_TYPE", "Envie o corpo como application/json.");
  }

  const declaredLength = Number(request.headers.get("Content-Length"));
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    throw new ApiError(413, "PAYLOAD_TOO_LARGE", "O corpo da requisicao excede o limite permitido.");
  }

  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > maximumBytes) {
    throw new ApiError(413, "PAYLOAD_TOO_LARGE", "O corpo da requisicao excede o limite permitido.");
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ApiError(400, "INVALID_JSON", "O JSON enviado e invalido.");
  }
}

export function getBearerToken(request: Request): string | null {
  const value = request.headers.get("Authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(value);
  return match?.[1]?.trim() ?? null;
}

export function getCookie(request: Request, name: string): string | null {
  const cookie = request.headers.get("Cookie") ?? "";
  for (const item of cookie.split(";")) {
    const separator = item.indexOf("=");
    if (separator < 0) continue;
    if (item.slice(0, separator).trim() === name) {
      return item.slice(separator + 1).trim();
    }
  }
  return null;
}

export function sessionCookie(token: string, maximumAgeSeconds: number): string {
  return [
    `mw_session=${token}`,
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=Strict",
    `Max-Age=${maximumAgeSeconds}`,
  ].join("; ");
}

export function clearSessionCookie(): string {
  return "mw_session=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0";
}

export function addCors(response: Response, request: Request, env: Env): Response {
  const origin = request.headers.get("Origin");
  if (!origin || origin !== env.APP_ORIGIN) return response;

  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", origin);
  headers.set("Access-Control-Allow-Credentials", "true");
  headers.set("Vary", "Origin");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export function preflightResponse(request: Request, env: Env): Response {
  const origin = request.headers.get("Origin");
  if (origin !== env.APP_ORIGIN) {
    throw new ApiError(403, "ORIGIN_NOT_ALLOWED", "Origem nao autorizada.");
  }

  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Credentials": "true",
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Maltworks-Device-ID, X-Maltworks-Firmware",
      "Access-Control-Max-Age": "86400",
      Vary: "Origin",
    },
  });
}
