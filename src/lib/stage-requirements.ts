// Reference: user-supplied POULTRIX Philippine Standards (PCARRD-DOST 2004 summary).
// Fixed-stage selections are engineering simplifications, not exact PCARRD prescriptions.
export const STAGE_REQUIREMENTS = {
  Starter: { referenceDays: '1–10', temperature: '32.2–35.0°C', lighting: 'Adequate lighting day and night', feedings: 6, note: 'Week-one brooding range used as a fixed-stage approximation.' },
  Grower: { referenceDays: '11–24', temperature: '26.7–29.4°C', lighting: 'Artificial light during dark hours', feedings: 4, note: 'Week-three range used as a fixed-stage approximation.' },
  Finisher: { referenceDays: '25–42', temperature: 'Cooling priority; no numerical PCARRD target', lighting: 'Artificial light during dark hours', feedings: 4, note: 'Cooling threshold must be validated; firmware uses a provisional band.' },
} as const;
export type PoultrixStage = keyof typeof STAGE_REQUIREMENTS;
