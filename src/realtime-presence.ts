/**
 * Limit Durable Object SQLite writes from overlapping HTTP telemetry and
 * WebSocket heartbeats in the 10-controller Free pilot.
 *
 * Read/check each ping, but only refresh the stored offline deadline after
 * 20 seconds or when recovering an offline device. A 90-second offline
 * threshold retains substantial safety margin at a 30-second cadence.
 */
export const REALTIME_PRESENCE_MIN_WRITE_INTERVAL_SECONDS = 20;

export interface StoredRealtimePresence {
  lastSeenAt: number;
  deadlineAt: number;
  online: number;
}

export function maySkipPresenceWrite(
  previous: StoredRealtimePresence | null | undefined,
  receivedAt: number,
): boolean {
  return Boolean(previous &&
    previous.online === 1 &&
    previous.deadlineAt > receivedAt &&
    receivedAt >= previous.lastSeenAt &&
    receivedAt - previous.lastSeenAt < REALTIME_PRESENCE_MIN_WRITE_INTERVAL_SECONDS);
}
