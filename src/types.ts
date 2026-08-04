export interface TelemetryPayload {
  schemaVersion: 1;
  deviceId: string;
  bootId: string;
  sequence: number;
  sentAt: number;
  uptimeSeconds: number;
  firmware: {
    product: string;
    version: string;
    phase: string;
  };
  network: {
    rssi: number;
  };
  temperatures: {
    refrigerator: SensorTelemetry;
    thermalWell: SensorTelemetry;
  };
  control: {
    setpoint: number;
    hysteresis: number;
    state: string;
    cooling: boolean;
    heating: boolean;
    compressorProtectionSeconds: number;
    compressorProtectionDurationSeconds: number;
  };
  profile: {
    active: boolean;
    paused: boolean;
    name: string;
    state: string;
    stage: number;
    stageCount: number;
    remainingSeconds: number;
  };
  alarms: {
    active: boolean;
    unacknowledged: boolean;
    count: number;
    summary: string;
    configuration: {
      sensorAlarmEnabled: boolean;
      highTemperatureEnabled: boolean;
      lowTemperatureEnabled: boolean;
      responseAlarmEnabled: boolean;
      highTemperatureLimit: number;
      lowTemperatureLimit: number;
      minimumExpectedChange: number;
      responseTimeoutSeconds: number;
    };
  };
  commandResult?: CommandResult;
}

export interface CommandResult {
  id: string;
  status: "applied" | "rejected";
  appliedSetpoint: number;
  message: string;
}

export interface SensorTelemetry {
  connected: boolean;
  value: number | null;
  raw: number | null;
  offset: number;
}

export interface SessionContext {
  userId: string;
  email: string;
  displayName: string;
  memberships: Array<{
    organizationId: string;
    organizationName: string;
    role: "owner" | "admin" | "member" | "viewer";
  }>;
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
