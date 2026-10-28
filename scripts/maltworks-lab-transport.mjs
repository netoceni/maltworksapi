/**
 * Internal-only Maltworks Lab transport.
 *
 * No API routes are registered by this module. This Node-only file is never
 * imported by the production Worker bundle or the customer Cloud panel.
 * Remote traffic requires an explicit staging endpoint and Cloudflare Access
 * service credentials. Production hosts and workers.dev are always refused.
 */
import { randomInt } from "node:crypto";
import { labDeviceId, makeLabTelemetry } from "./maltworks-lab.mjs";

export const LAB_MAX_STAGING_DEVICES = 10;
export const LAB_MAX_STAGING_TICKS = 120;
const DEVICE_TOKEN_RE = /^[a-f0-9]{64}$/i;

function isLoopback(hostname) {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

function isStagingHost(hostname) {
  return hostname === "api-staging.maltworks.com.br" ||
    hostname.endsWith(".staging.maltworks.com.br");
}

/**
 * A literal allow-list, not a negative match for the production host.
 * Do NOT add *.workers.dev, *.pages.dev, arbitrary external hosts or an
 * environment-controlled wildcard. These might route to production.
 */
export function requireLabEndpoint(raw) {
  if (typeof raw !== "string" || !raw.trim()) throw new Error("Staging URL is required");
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Invalid staging URL");
  }
  if (url.username || url.password || url.hash || url.search ||
      url.pathname !== "/v1/telemetry") {
    throw new Error("Staging URL must point exactly to /v1/telemetry with no credentials/query");
  }
  if (isLoopback(url.hostname)) {
    if (!["http:", "https:"].includes(url.protocol)) {
      throw new Error("Local endpoint must use HTTP or HTTPS");
    }
  } else if (!isStagingHost(url.hostname) || url.protocol !== "https:" || url.port !== "") {
    throw new Error("Maltworks Lab refuses non-staging or non-HTTPS remote endpoints");
  }
  return url;
}

export function readLabTokens(raw, devices) {
  if (!Number.isInteger(devices) || devices < 1 || devices > LAB_MAX_STAGING_DEVICES) {
    throw new Error("Remote Lab is limited to 1-10 controllers");
  }
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("Lab staging token map must be valid JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Lab staging token map must be a JSON object");
  }
  const tokens = new Map();
  for (let index = 0; index < devices; index++) {
    const deviceId = labDeviceId(index);
    const token = Object.prototype.hasOwnProperty.call(value, deviceId) ? value[deviceId] : "";
    if (typeof token !== "string" || !DEVICE_TOKEN_RE.test(token)) {
      // Do not interpolate token, partial token or request headers into errors.
      throw new Error("Missing or invalid staging token for " + deviceId);
    }
    tokens.set(deviceId, token.toLowerCase());
  }
  return tokens;
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Runs fixed-rate simulated telemetry to staging. A successful 200 must say
 * deviceStatus=active. A 202 is a pending/unclaimed device and is NOT a
 * passing test; stop until the staging organization claims that fake device.
 */
export async function runLabStaging({
  endpoint, tokens, devices = 1, ticks = 12, scenario = "normal",
  intervalSeconds = 30, paceMs = 30_000,
  startAt = Math.floor(Date.now() / 1000),
  sessionId = randomInt(0, 2048),
  accessClientId, accessClientSecret,
}, { fetchImpl = fetch, sleep = delay } = {}) {
  const url = requireLabEndpoint(endpoint);
  if (!Number.isInteger(devices) || devices < 1 || devices > LAB_MAX_STAGING_DEVICES) {
    throw new Error("Remote staging supports 1-10 devices");
  }
  if (!Number.isInteger(ticks) || ticks < 1 || ticks > LAB_MAX_STAGING_TICKS) {
    throw new Error("Remote staging supports 1-120 ticks");
  }
  if (intervalSeconds !== 30) {
    throw new Error("Free pilot staging uses exactly 30-second telemetry frames");
  }
  if (!Number.isInteger(paceMs) || paceMs < 0 || paceMs > 60_000) {
    throw new Error("Invalid staging pacing");
  }
  if (!(tokens instanceof Map)) throw new Error("Validated staging tokens are required");
  // Validate the complete credential set before the first HTTP request.
  for (let index = 0; index < devices; index++) {
    if (!DEVICE_TOKEN_RE.test(tokens.get(labDeviceId(index)) ?? "")) {
      throw new Error("Missing or invalid staging token for " + labDeviceId(index));
    }
  }
  const remote = !isLoopback(url.hostname);
  if (remote && (!accessClientId || !accessClientSecret)) {
    throw new Error("Remote staging requires Cloudflare Access service credentials");
  }
  let delivered = 0;
  let omitted = 0;
  for (let tick = 0; tick < ticks; tick++) {
    for (let index = 0; index < devices; index++) {
      const frame = makeLabTelemetry(index, tick, {
        scenario, intervalSeconds, startAt, sessionId,
      });
      if (!frame) {
        omitted++;
        continue;
      }
      const deviceId = labDeviceId(index);
      const headers = {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + tokens.get(deviceId),
        "X-Maltworks-Device-ID": deviceId,
        "X-Maltworks-Firmware": "5.5.2-lab",
      };
      if (remote) {
        headers["CF-Access-Client-Id"] = accessClientId;
        headers["CF-Access-Client-Secret"] = accessClientSecret;
      }
      let response;
      try {
        response = await fetchImpl(url.href, {
          method: "POST",
          headers,
          redirect: "error",
          cache: "no-store",
          body: JSON.stringify(frame),
          signal: AbortSignal.timeout(10_000),
        });
      } catch {
        throw new Error("Lab staging request failed or was redirected; stopping safely");
      }
      if (response.status !== 200) {
        if (response.status === 202) {
          throw new Error("Staging device is pending; claim it in the staging organization first");
        }
        throw new Error("Staging telemetry rejected (HTTP " + response.status + ")");
      }
      const result = await response.json().catch(() => null);
      if (!result || result.ok !== true || result.accepted !== true ||
          result.deviceStatus !== "active") {
        throw new Error("Lab staging did not confirm an active test device");
      }
      delivered++;
    }
    // Sleeping across silent ticks is essential to reproduce offline alarms.
    if (tick < ticks - 1 && paceMs > 0) await sleep(paceMs);
  }
  return {
    target: url.origin,
    devices, ticks, intervalSeconds, paceMs,
    delivered, omitted,
    timingValid: paceMs === intervalSeconds * 1000,
    // Important: this is transport-only, not proof that D1/DO are isolated.
    environment: "staging",
  };
}
