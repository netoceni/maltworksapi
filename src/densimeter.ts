import { requireSession, selectOrganization } from "./auth";
import { jsonResponse } from "./http";
import { ApiError } from "./types";

export interface DensimeterReading {
  index: number;
  sessionId: string;
  sequence: number;
  sampledAt: number;
  intervalSeconds: number;
  angleMdeg: number;
  temperatureMc: number;
  batteryMv: number;
  rssi: number;
  gravitySg: number | null;
  calibrationRevision: number;
}
export interface DensimeterTelemetry {
  protocolVersion: 1;
  sensorId: number;
  readings: DensimeterReading[];
}

function invalid(): never {
  throw new ApiError(400, "INVALID_DENSIMETER", "Medicao do densimetro invalida.");
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}
function integer(value: unknown, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) invalid();
  return value;
}
export function validateDensimeter(value: unknown): DensimeterTelemetry | null | undefined {
  // Omitted means old firmware; null means supported, with no paired sensor.
  if (value === undefined || value === null) return value;
  const root = object(value);
  if (root.protocolVersion !== 1 || !Array.isArray(root.readings) || root.readings.length > 4) invalid();
  const sensorId = integer(root.sensorId, 1, 0xffffff);
  const identities = new Set<string>();
  const indices = new Set<number>();
  const now = Math.floor(Date.now() / 1000);
  const readings = root.readings.map((value): DensimeterReading => {
    const r = object(value);
    if (typeof r.sessionId !== "string" || !/^[0-9a-f]{16}$/u.test(r.sessionId)) invalid();
    const index = integer(r.index, 1, 0xffffffff);
    const sequence = integer(r.sequence, 1, 0xffffffff);
    const identity = r.sessionId + ":" + sequence;
    if (identities.has(identity) || indices.has(index)) invalid();
    identities.add(identity); indices.add(index);
    const intervalSeconds = integer(r.intervalSeconds, 60, 3600);
    if (![60, 1800, 3600].includes(intervalSeconds)) invalid();
    const sampledAt = integer(r.sampledAt, 0, now + 300);
    if (sampledAt !== 0 && sampledAt < 1704067200) invalid();
    const calibrationRevision = integer(r.calibrationRevision, 0, 0xffffffff);
    const gravitySg = r.gravitySg;
    if (gravitySg !== null && (typeof gravitySg !== "number" || !Number.isFinite(gravitySg)
        || gravitySg < 0.990 || gravitySg > 1.200 || calibrationRevision === 0)) invalid();
    return {
      index, sessionId: r.sessionId, sequence, sampledAt, intervalSeconds,
      angleMdeg: integer(r.angleMdeg, 0, 90000),
      temperatureMc: integer(r.temperatureMc, -20000, 60000),
      batteryMv: integer(r.batteryMv, 2500, 4400),
      rssi: integer(r.rssi, -127, 0), gravitySg, calibrationRevision,
    };
  });
  return { protocolVersion: 1, sensorId, readings };
}

const selection = `history_index AS "index", session_id AS sessionId, sequence,
  sampled_at AS sampledAt, interval_seconds AS intervalSeconds,
  angle_mdeg AS angleMdeg, temperature_mc AS temperatureMc, battery_mv AS batteryMv,
  rssi, gravity_sg AS gravitySg, calibration_revision AS calibrationRevision`;

/** Authentication of the parent Controller MUST precede this function. */
export async function persistDensimeter(
  db: D1Database, deviceId: string, sensor: DensimeterTelemetry | null | undefined, now: number,
): Promise<{ sensorId: number; indices: number[] } | undefined> {
  if (!sensor) return undefined;
  if (!sensor.readings.length) return { sensorId: sensor.sensorId, indices: [] };
  const predicates = sensor.readings.map(() => "(session_id = ? AND sequence = ?)").join(" OR ");
  const lookup = db.prepare(`SELECT ${selection} FROM densimeter_readings
    WHERE device_id = ? AND sensor_id = ? AND (${predicates})`)
    .bind(deviceId, sensor.sensorId, ...sensor.readings.flatMap(r => [r.sessionId, r.sequence]));
  const existing = await lookup.all<DensimeterReading>();
  const byIdentity = new Map(existing.results.map(r => [r.sessionId + ":" + r.sequence, r]));
  const statements: D1PreparedStatement[] = [];
  for (const r of sensor.readings) {
    const saved = byIdentity.get(r.sessionId + ":" + r.sequence);
    if (saved) {
      // ACK loss/replay must not change timestamps, calibration or measurements.
      if (Object.keys(r).some(key => r[key as keyof DensimeterReading] !== saved[key as keyof DensimeterReading])) {
        throw new ApiError(409, "DENSIMETER_REPLAY_CONFLICT", "Reenvio difere da medicao original.");
      }
      continue;
    }
    statements.push(db.prepare(`INSERT INTO densimeter_readings
      (device_id, sensor_id, session_id, sequence, history_index, sampled_at, received_at,
       interval_seconds, angle_mdeg, temperature_mc, battery_mv, rssi, gravity_sg, calibration_revision)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(device_id, sensor_id, session_id, sequence) DO NOTHING`)
      .bind(deviceId, sensor.sensorId, r.sessionId, r.sequence, r.index, r.sampledAt, now,
        r.intervalSeconds, r.angleMdeg, r.temperatureMc, r.batteryMv, r.rssi,
        r.gravitySg, r.calibrationRevision));
  }
  if (statements.length) {
    await db.batch(statements);
    // A concurrent request may have inserted the same identity after lookup.
    // Verify the committed values before confirming durability to the Controller.
    const committed = await lookup.all<DensimeterReading>();
    const stored = new Map(committed.results.map(r => [r.sessionId + ":" + r.sequence, r]));
    for (const r of sensor.readings) {
      const saved = stored.get(r.sessionId + ":" + r.sequence);
      if (!saved || Object.keys(r).some(key => r[key as keyof DensimeterReading] !== saved[key as keyof DensimeterReading])) {
        throw new ApiError(409, "DENSIMETER_REPLAY_CONFLICT", "Reenvio difere da medicao original.");
      }
    }
  }
  return { sensorId: sensor.sensorId, indices: sensor.readings.map(r => r.index) };
}

/** All plans have access; authorization is always by Controller organization. */
export async function densimeterHistory(request: Request, env: Env, requestId: string, deviceId: string): Promise<Response> {
  const session = await requireSession(request, env);
  const organizationId = selectOrganization(session, new URL(request.url).searchParams.get("organizationId"));
  const device = await env.DB.prepare(`SELECT s.state_json AS stateJson
    FROM devices d LEFT JOIN device_latest_state s ON s.device_id = d.id
    WHERE d.id = ? AND d.organization_id = ?`)
    .bind(deviceId, organizationId).first<{ stateJson: string | null }>();
  if (!device) throw new ApiError(404, "DEVICE_NOT_FOUND", "Controlador nao encontrado.");
  const state = device.stateJson ? JSON.parse(device.stateJson) as { densimeter?: DensimeterTelemetry | null } : null;
  const sensor = state?.densimeter;
  const result = sensor ? await env.DB.prepare(`SELECT ${selection}, received_at AS receivedAt
    FROM densimeter_readings WHERE device_id = ? AND sensor_id = ?
    ORDER BY history_index DESC LIMIT 64`).bind(deviceId, sensor.sensorId).all<DensimeterReading>() : null;
  return jsonResponse({ ok: true, deviceId, supported: sensor !== undefined,
    sensorId: sensor?.sensorId ?? null, readings: result?.results ?? [], requestId });
}
