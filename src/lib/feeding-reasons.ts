// Automatic feeding session records and plain-language reasons
// (SPEC-auto-feeding). Shared by the Feeding page and the alerts.

export type FeedingSessionRecord = {
  date: string;
  time: string;
  stage: string | null;
  targetGrams: number | null;
  troughGrams: number | null;
  dispensedGrams: number | null;
  result: "dispensed" | "partial" | "skipped" | "missed" | "fault";
  reason: string | null;
  at: string;
  troughAfter?: number | null;
  check?: string | null;
  troughReadable?: boolean;
};

/** Plain-language text for session and switch reasons. */
export const FEEDING_REASON: Record<string, string> = {
  trough_full: "trough already full",
  trough_unreadable: "trough scale unreadable, fed the full amount",
  cap_reached: "10 s gate limit reached",
  maintenance_active: "maintenance was open",
  controller_not_ready: "controller not ready",
  feeding_busy: "another feed was running",
  no_stage_compatible_compartment: "no compartment with feed for this stage",
  no_stage_or_target: "no stage or bird count",
  pi_or_controller_unavailable: "the Pi or controller was unavailable at that time",
  interrupted: "interrupted (the Pi restarted during the session)",
  "3_consecutive_faults": "3 faults in a row",
  turned_off_by_owner: "turned off",
};

export function reasonText(reason: string | null | undefined): string {
  if (!reason) return "";
  return reason
    .split(",")
    .map((part) => FEEDING_REASON[part] ?? part.replaceAll("_", " "))
    .join("; ");
}
