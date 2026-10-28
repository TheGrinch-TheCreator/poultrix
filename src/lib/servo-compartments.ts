// Physical PCA9685 mapping; API support for all ten channels is pending.
export const SERVO_COMPARTMENTS = [
  { name: "Compartment 1", channels: [0, 1, 2, 3, 4] },
  { name: "Compartment 2", channels: [11, 12, 13, 14, 15] },
] as const;

export type ServoTelemetry = { channels?: Record<string, { status?: string; angle?: number | null }> };
export function servoReading(data: ServoTelemetry | null | undefined, channel: number) {
  const reading = data?.channels?.[String(channel)];
  return reading?.status ?? (typeof reading?.angle === "number" ? `${reading.angle}°` : "Not reported");
}
