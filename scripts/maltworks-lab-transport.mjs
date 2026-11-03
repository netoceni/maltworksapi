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
// Controlled soak outage: only LAB device zero, between 15:00 and 17:30.
export const LAB_SOAK_OUTAGE_START_TICK = 30;
export const LAB_SOAK_OUTAGE_END_TICK = 34;
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
  accessClientId, accessClientSecret, soakOutage = false,
}, { fetchImpl = fetch, sleep = delay, nowMs = () => performance.now(), onTick = null } = {}) {
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
  if (soakOutage !== false && soakOutage !== true) {
    throw new Error("Soak outage flag must be boolean");
  }
  if (soakOutage && (devices !== 10 || ticks !== 60 || scenario !== "normal" ||
      paceMs !== 30_000 || url.hostname !== "api-staging.maltworks.com.br")) {
    throw new Error("Controlled soak outage requires exactly 10 staging devices, 60 ticks and 30s pacing");
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

  // Use absolute, monotonic deadlines: HTTP time must not be added to the
  // configured cadence. The previous sequential ten-device loop took ~49 min
  // for 60 x 30s ticks because it slept 30s *after* all HTTP calls.
  const startedAtMs = nowMs();
  const toleranceMs = 2_000;
  let previousTickStartMs = null;
  let minTickIntervalMs = Infinity;
  let maxTickIntervalMs = 0;
  let intervalSumMs = 0;
  let maxStartLagMs = 0;
  let timingValid = paceMs === intervalSeconds * 1000 && ticks > 1;

  for (let tick = 0; tick < ticks; tick++) {
    if (tick > 0 && paceMs > 0) {
      const remainingMs = startedAtMs + tick * paceMs - nowMs();
      if (remainingMs > 0) await sleep(remainingMs);
    }

    const tickStartedMs = nowMs();
    if (paceMs > 0) {
      const lagMs = Math.max(0, tickStartedMs - (startedAtMs + tick * paceMs));
      maxStartLagMs = Math.max(maxStartLagMs, lagMs);
      if (lagMs > toleranceMs) timingValid = false;
    }
    if (previousTickStartMs !== null) {
      const gapMs = tickStartedMs - previousTickStartMs;
      minTickIntervalMs = Math.min(minTickIntervalMs, gapMs);
      maxTickIntervalMs = Math.max(maxTickIntervalMs, gapMs);
      intervalSumMs += gapMs;
      if (Math.abs(gapMs - paceMs) > toleranceMs) timingValid = false;
    }
    previousTickStartMs = tickStartedMs;

    // Ten independent devices are sent concurrently, not serially. Wait
    // until all in-flight requests settle before starting the next tick.
    // A rejected device stops the pilot without leaking its credentials.
    const requests = [];
    const requestedDevices = [];
    for (let index = 0; index < devices; index++) {
      if (soakOutage && index === 0 && tick >= LAB_SOAK_OUTAGE_START_TICK &&
          tick <= LAB_SOAK_OUTAGE_END_TICK) {
        omitted++;
        continue;
      }
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
      requestedDevices.push(deviceId);
      requests.push((async () => {
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
      })());
    }
    const outcomes = await Promise.allSettled(requests);
    let failure = null;
    let failedDevice = null;
    for (const [index, outcome] of outcomes.entries()) {
      if (outcome.status === "fulfilled") delivered++;
      else if (!failure) {
        failure = outcome.reason;
        failedDevice = requestedDevices[index];
      }
    }
    if (failure) {
      // Only include lab device ID, tick and our own sanitized error message.
      // Never expose tokens, Access headers, URLs, or a thrown fetch exception.
      throw new Error(
        "Lab staging HTTP batch failed at tick " + (tick + 1) + "/" + ticks +
        ", device " + failedDevice + ": " + failure.message,
      );
    }
    if (onTick) onTick({ tick: tick + 1, totalTicks: ticks, delivered, omitted });
  }

  return {
    target: url.origin,
    devices, ticks, intervalSeconds, paceMs,
    delivered, omitted, soakOutage,
    outageDevice: soakOutage ? labDeviceId(0) : null,
    outageTicks: soakOutage ? [LAB_SOAK_OUTAGE_START_TICK, LAB_SOAK_OUTAGE_END_TICK] : null,
    elapsedMs: Math.round(nowMs() - startedAtMs),
    averageTickIntervalMs: ticks > 1 ? Math.round(intervalSumMs / (ticks - 1)) : null,
    minTickIntervalMs: ticks > 1 ? Math.round(minTickIntervalMs) : null,
    maxTickIntervalMs: ticks > 1 ? Math.round(maxTickIntervalMs) : null,
    maxStartLagMs: Math.round(maxStartLagMs),
    timingValid,
    // Transport-only: not proof that D1, DO, quotas, or production are isolated.
    environment: "staging",
  };
}
