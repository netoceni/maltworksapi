import type { TelemetryPayload } from "./types";

/**
 * Live telemetry continues at the device cadence (normally 5 seconds).
 * Store a D1 snapshot at most once per 60 seconds under steady conditions.
 * Any safety-relevant transition bypasses the timer.
 */
export const TELEMETRY_PERSIST_INTERVAL_SECONDS = 60;
export const TELEMETRY_REALTIME_FAILOVER_INTERVAL_SECONDS = 30;

/**
 * If the realtime Durable Object is temporarily unavailable, D1 is a
 * low-frequency heartbeat fallback. Do not return to per-packet writes,
 * which would exhaust the free database row-write quota during an outage.
 */
export function shouldPersistRealtimeFailover(
  previous: LastPersistedTelemetry | null,
  now: number,
): boolean {
  return !previous || previous.stateReceivedAt === null ||
    now < previous.stateReceivedAt ||
    now - previous.stateReceivedAt >= TELEMETRY_REALTIME_FAILOVER_INTERVAL_SECONDS;
}


export interface LastPersistedTelemetry {
  bootId: string | null;
  sequence: number | null;
  stateReceivedAt: number | null;
  stateJson: string | null;
  offlineActive: number | null;
}

/**
 * Fail open to persistence if an old record cannot be compared safely.
 * It is better to write one extra sample than suppress an alarm transition.
 */
export function shouldPersistTelemetry(
  payload: TelemetryPayload,
  previous: LastPersistedTelemetry | null,
  now: number,
  intervalSeconds = TELEMETRY_PERSIST_INTERVAL_SECONDS,
): boolean {
  if (intervalSeconds <= 0) return true;
  if (!previous || previous.stateReceivedAt === null || !previous.stateJson) return true;
  if (previous.offlineActive === 1) return true;
  if (previous.bootId !== payload.bootId) return true;

  // A retransmission of the exact last persisted packet is not a new sample.
  if (previous.sequence === payload.sequence) return false;

  if (!Number.isFinite(now) || now < previous.stateReceivedAt ||
      now - previous.stateReceivedAt >= intervalSeconds) return true;

  let old: TelemetryPayload;
  try {
    old = JSON.parse(previous.stateJson) as TelemetryPayload;
    if (!old || old.deviceId !== payload.deviceId || !old.temperatures ||
        !old.control || !old.profile || !old.alarms || !old.firmware) return true;
  } catch {
    return true;
  }

  const oldAck = old.commandResult;
  const newAck = payload.commandResult;
  if (oldAck?.id !== newAck?.id || oldAck?.status !== newAck?.status) return true;

  if (
    old.firmware.version !== payload.firmware.version ||
    old.firmware.product !== payload.firmware.product ||
    old.control.state !== payload.control.state ||
    old.control.cooling !== payload.control.cooling ||
    old.control.heating !== payload.control.heating ||
    old.control.hysteresis !== payload.control.hysteresis ||
    old.control.compressorProtectionDurationSeconds !== payload.control.compressorProtectionDurationSeconds ||
    old.temperatures.refrigerator.connected !== payload.temperatures.refrigerator.connected ||
    old.temperatures.thermalWell.connected !== payload.temperatures.thermalWell.connected ||
    old.temperatures.refrigerator.offset !== payload.temperatures.refrigerator.offset ||
    old.temperatures.thermalWell.offset !== payload.temperatures.thermalWell.offset ||
    old.alarms.active !== payload.alarms.active ||
    old.alarms.unacknowledged !== payload.alarms.unacknowledged ||
    old.alarms.count !== payload.alarms.count ||
    old.profile.active !== payload.profile.active ||
    old.profile.paused !== payload.profile.paused ||
    old.profile.name !== payload.profile.name ||
    old.profile.state !== payload.profile.state ||
    old.profile.stage !== payload.profile.stage ||
    old.profile.stageCount !== payload.profile.stageCount
  ) return true;

  // A manual change must appear immediately; a continuous profile ramp can
  // change setpoint on every packet and should be sampled periodically.
  if (!payload.profile.active && old.control.setpoint !== payload.control.setpoint) {
    return true;
  }

  // Configuration changes are infrequent and must not wait for the sampling timer.
  try {
    if (JSON.stringify(old.alarms.configuration) !==
        JSON.stringify(payload.alarms.configuration)) return true;
  } catch {
    return true;
  }
  return false;
}
