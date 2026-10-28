/** Normalize weight telemetry without inventing readings or recalibrating Arduino values. */
export type WeightReading = {
  connected?: boolean;
  status?: string;
  estimated?: boolean;
  weightGrams?: number | null;
  weightKg?: number | null;
  updatedAt?: string | null;
};
export type WeightPayload = WeightReading & {
  hopper?: WeightReading | null;
  trough?: WeightReading | null;
};

export function grams(reading?: WeightReading | null): number | null {
  if (!reading || reading.connected === false || /^(ERROR|FAULT|DISCONNECTED|UNAVAILABLE|UNCALIBRATED)$/i.test(reading.status ?? "")) return null;
  const value = typeof reading.weightGrams === "number" ? reading.weightGrams : typeof reading.weightKg === "number" ? reading.weightKg * 1000 : null;
  return value !== null && Number.isFinite(value) ? value : null;
}
export function formatWeight(reading?: WeightReading | null): string {
  const value = grams(reading);
  return value === null ? "—" : `${(value / 1000).toFixed(3)} kg`;
}
export function readingStatus(reading?: WeightReading | null): string {
  if (!reading) return "Not reported";
  if (reading.connected === false) return "Disconnected";
  if (grams(reading) === null) return reading.status || "No valid reading";
  return reading.estimated ? "Estimated · Arduino calibrated" : "Arduino reported";
}
export function formatReadingTime(reading?: WeightReading | null): string {
  if (!reading?.updatedAt) return "Update time unavailable";
  const date = new Date(reading.updatedAt);
  return Number.isNaN(date.getTime()) ? "Update time unavailable" : `Updated ${date.toLocaleString()}`;
}
