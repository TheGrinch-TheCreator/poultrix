import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { piErrorMessage, type PiError } from "@/lib/pi-client";
import { usePiSnapshot } from "@/lib/pi-snapshot";
import { reasonText, type FeedingSessionRecord } from "@/lib/feeding-reasons";

export type LiveAlert = { id: string; severity: "critical" | "warning" | "info"; title: string; description: string; action: string };
type Snapshot = { health: any; status: any; ai: any; weight: any; feeding: any; errors: Record<string,string>; gatewayError?: PiError | null };

// Live data comes from the shared snapshot poller; acknowledgements are
// synced separately and much less often (Worker request budget).
const ACK_POLL_MS = 60_000;
const listeners = new Set<() => void>();
let lastSuccessful = false;
let subscribers = 0;
let timer: ReturnType<typeof setInterval> | undefined;
let acknowledgements: Record<string, boolean> = {};
let ackError: string | null = null;
async function syncAcks() {
  try {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session?.access_token) throw new Error("Sign in to synchronize alerts");
    const r = await fetch('/api/alerts/acknowledgements', {
      headers: { Authorization: `Bearer ${session.access_token}` }, cache: 'no-store',
    });
    const payload = await r.json();
    if (!r.ok) throw new Error(payload.error || `HTTP ${r.status}`);
    acknowledgements = Object.fromEntries((payload.acknowledgements || []).map((a: {alert_id:string}) => [a.alert_id, true]));
    ackError = null;
  } catch (e) { ackError = e instanceof Error ? e.message : "Acknowledgements unavailable"; }
  emit();
}
async function mutateAck(id: string, method: 'POST' | 'DELETE') {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.access_token) { ackError = "Sign in to acknowledge alerts"; emit(); return; }
  try {
    const r = await fetch('/api/alerts/acknowledgements', {
      method, headers: { Authorization: `Bearer ${session.access_token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }), cache: 'no-store',
    });
    const payload = await r.json();
    if (!r.ok) throw new Error(payload.error || `HTTP ${r.status}`);
    acknowledgements = Object.fromEntries((payload.acknowledgements || []).map((a: {alert_id:string}) => [a.alert_id, true]));
    ackError = null;
  } catch (e) { ackError = e instanceof Error ? e.message : "Unable to save acknowledgement"; }
  emit();
}
function emit() { listeners.forEach(fn => fn()); }
function add(out: LiveAlert[], id: string, severity: LiveAlert["severity"], title: string, description: string, action: string) {
  if (!out.some(a => a.id === id)) out.push({ id, severity, title, description, action });
}
function deriveAlerts(s: Snapshot | null): LiveAlert[] {
  if (!s) return [];
  const out: LiveAlert[] = [];
  if (!s.status && !s.health) {
    const code = s.gatewayError?.code;
    if (code === "NOT_APPROVED") add(out, "account-not-approved", "warning", "Account not approved", "This account can't read Poultrix live data or control hardware.", "Ask the farm owner to add your email to the approved list.");
    else if (code === "AUTH_REQUIRED" || code === "SESSION_INVALID") add(out, "session-expired", "warning", "Signed out", "Live data needs a signed-in session.", "Sign in again.");
    else add(out, "api-unreachable", "critical", "Raspberry Pi API unavailable", `Cannot retrieve live system status (${piErrorMessage(s.gatewayError)}). Other readings cannot be verified.`, "Check the farm internet connection, the Pi, and the poultrix and cloudflared services.");
    return out;
  }
  if (s.health) {
    const h = s.health;
    if (h.arduino === false) add(out,"arduino-disconnected","critical","Arduino disconnected","The backend reports no Arduino serial connection.","Check the USB cable, Arduino power, and serial connection.");
    if (h.camera === false) add(out,"camera-offline","warning","Camera unavailable","Raspberry Pi camera health check failed.","Check the camera ribbon cable and Pi camera service.");
    if (h.aiModel === false) add(out,"ai-model-unavailable","warning","AI model unavailable","The classifier is not loaded.","Check best.pt and the backend AI logs.");
    if (h.internet === false) add(out,"internet-unavailable","warning","Internet unavailable","The Pi reports an internet connectivity problem.","Check the Pi network connection.");
    if (Array.isArray(h.issues)) h.issues.forEach((issue: unknown) => {
      if (typeof issue !== "string" || !issue.trim()) return;
      const normalized = issue.trim().toLowerCase().replace(/[^a-z0-9]+/g,"-").slice(0,90);
      // Do not duplicate the component-specific alerts above.
      if ((h.arduino === false && /arduino|serial/.test(issue)) || (h.camera === false && /camera/.test(issue)) || (h.aiModel === false && /ai|model/.test(issue)) || (h.internet === false && /internet|network/.test(issue))) return;
      add(out,`health-${normalized}`,"warning","System health issue",issue,"Check the System Status page and Raspberry Pi logs.");
    });
  } else if (s.errors.health) {
    add(out,"health-check-unavailable","warning","System health check unavailable",`Health endpoint: ${s.errors.health}.`,"Check that the current backend includes /api/system/health.");
  }
  const hw = s.status;
  if (hw?.connected === false && s.health?.arduino !== false) add(out,"arduino-disconnected","critical","Arduino disconnected","The hardware status endpoint reports a disconnected Arduino.","Check the Arduino USB connection.");
  if (hw?.connected && String(hw.mode || "").toLowerCase() === "live") {
    if (hw.temperature == null || hw.humidity == null) add(out,"dht22-no-reading","warning","DHT22 readings unavailable","The Arduino is connected, but temperature or humidity is missing.","Inspect DHT22 wiring and Arduino serial readings.");
    else if (Number.isFinite(Number(hw.temperature))) {
      const low = Number(hw.temperatureTarget?.min), high = Number(hw.temperatureTarget?.max), value = Number(hw.temperature);
      if (Number.isFinite(high) && value > high) add(out,"temperature-high","critical","Temperature above target",`${value.toFixed(1)} °C exceeds the configured ${high.toFixed(1)} °C maximum.`,"Check cooling fans, ventilation, and the temperature sensor.");
      if (Number.isFinite(low) && value < low) add(out,"temperature-low","warning","Temperature below target",`${value.toFixed(1)} °C is below the configured ${low.toFixed(1)} °C minimum.`,"Check the heater and temperature sensor.");
    }
    if (hw.lightRaw == null) add(out,"ldr-no-reading","warning","LDR reading unavailable","The Arduino is connected, but no light sensor reading is reported.","Check the LDR wiring and Arduino output.");
  }
  if (s.ai?.error || s.ai?.status === "error") add(out,"ai-error","warning","AI classification error",String(s.ai.error || "The classifier reported an error."),"Inspect the camera feed and AI backend logs.");
  const schedule = s.ai?.schedule;
  if (schedule && schedule.overdueDays > 0 && typeof schedule.overdueStage === "string") {
    // One id per day: acknowledging hides it until the next failed daily check.
    const stage = schedule.overdueStage.charAt(0) + schedule.overdueStage.slice(1).toLowerCase();
    const last = schedule.lastAttempt;
    const seen = last?.detectedStage && last.detectedStage === s.status?.stage?.toUpperCase() ? ` The last check (${last.date}) saw ${last.detectedStage.charAt(0) + last.detectedStage.slice(1).toLowerCase()}${typeof last.confidence === "number" ? ` at ${last.confidence.toFixed(1)}%` : ""}.` : "";
    add(out, `stage-overdue-${schedule.overdueStage}-${last?.date ?? schedule.batchDay}`, "warning", `${stage} check overdue`,
      `Day ${schedule.batchDay}: ${stage} has not been confirmed for ${schedule.overdueDays} day${schedule.overdueDays === 1 ? "" : "s"}.${seen}`,
      "Check the camera view and lighting. The Pi tries again at the next daily check.");
  }
  // Observe-only pre-check (SPEC-stage-schedule §10): the Pi reports that the flock
  // looks ready for the next stage. No confidence or detection is shown here.
  const ready = schedule?.readyAlert;
  if (ready && typeof ready.stage === "string") {
    const stage = ready.stage.charAt(0) + ready.stage.slice(1).toLowerCase();
    add(
      out,
      `stage-ready-${ready.stage}-${ready.date}`,
      "info",
      `Flock looks ready for ${stage}`,
      `Flock looks ready for ${stage}; the stage can change from Day ${ready.fromDay}.`,
      `No action needed: the AI confirms ${stage} at its daily check from Day ${ready.fromDay}.`,
    );
  }
  // Automatic feeding (SPEC-auto-feeding): last session outcome and the switch.
  const auto = s.feeding?.automatic as { enabled?: boolean; disabledReason?: string | null; last?: FeedingSessionRecord | null } | undefined;
  if (auto?.disabledReason === "3_consecutive_faults" && !auto.enabled)
    add(out, "auto-feeding-disabled", "critical", "Automatic feeding turned off", "Three feeding sessions in a row failed, so automatic feeding switched itself off.", "Check the gates, hopper and Arduino, then turn automatic feeding back on in the Feeding page.");
  const last = auto?.last;
  if (last && last.date === new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Manila" })) {
    const id = `auto-feed-${last.date}-${last.time}`;
    if (last.result === "fault") add(out, `${id}-fault`, "warning", `Feeding ${last.time} failed`, `The ${last.time} session did not complete: ${reasonText(last.reason)}.`, "Check the gate and hopper; the next session runs as scheduled.");
    if (last.check === "low_rise") add(out, `${id}-low-rise`, "warning", `Feed may not have reached the trough (${last.time})`, `The trough barely rose after dispensing ${Math.round(last.dispensedGrams ?? 0)} g.`, "Check that the hopper compartment has feed and the gate isn't jammed.");
    if (last.result === "partial") add(out, `${id}-partial`, "info", `Feeding ${last.time} was partial`, "The session needed more than the 10 s gate limit allows.", "Check the bird count, or add a manual feed.");
    if (last.result === "dispensed" && last.reason?.includes("trough_unreadable")) add(out, `${id}-unreadable`, "info", `Trough scale unreadable at ${last.time}`, "The full session amount was dispensed because the trough reading was not stable.", "Zero the trough again on the maintenance site if this keeps happening.");
    if (last.result === "skipped" && last.reason && last.reason !== "trough_full") add(out, `${id}-skipped`, "info", `Feeding ${last.time} skipped`, `Skipped: ${reasonText(last.reason)}.`, "The next session runs as scheduled.");
  }
  if (s.weight && /^(ERROR|FAULT|DISCONNECTED)$/i.test(String(s.weight.status || ""))) add(out,"weight-fault","warning","Feed weight sensor issue",`HX711 reported ${s.weight.status}.`,"Check load cell wiring, calibration, and the HX711 module.");
  if (s.feeding?.gates && typeof s.feeding.gates === "object") Object.entries(s.feeding.gates).forEach(([gate, value]) => {
    const v = value as { status?: string };
    if (/^(ERROR|FAULT)$/i.test(String(v?.status || ""))) add(out,`gate-${gate}-fault`,"warning",`Feeding gate ${gate} fault`,`Gate ${gate} reported ${v.status}.`,"Check the servo power, PCA9685 connection, and gate mechanism.");
  });
  return out;
}
export async function acknowledgeLiveAlert(id: string) { await mutateAck(id, 'POST'); }
export async function restoreLiveAlert(id: string) { await mutateAck(id, 'DELETE'); }
export function useLiveAlerts() {
  const { snapshot: pi, error } = usePiSnapshot();
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const notify = () => setRevision(v => v + 1);
    listeners.add(notify); subscribers++;
    if (subscribers === 1) { void syncAcks(); timer = setInterval(() => void syncAcks(), ACK_POLL_MS); }
    return () => { listeners.delete(notify); subscribers--; if (subscribers === 0) { clearInterval(timer); timer = undefined; } };
  }, []);
  void revision;
  if (pi) lastSuccessful = true;
  const snapshot: Snapshot | null = pi
    ? { health: pi.health, status: pi.status, ai: pi.ai, weight: pi.weight, feeding: pi.feedingStatus, errors: pi.errors ?? {} }
    : error ? { health: null, status: null, ai: null, weight: null, feeding: null, errors: {}, gatewayError: error } : null;
  const all = deriveAlerts(snapshot);
  return { alerts: all.filter(a => !acknowledgements[a.id]), acknowledged: all.filter(a => !!acknowledgements[a.id]), count: all.filter(a => !acknowledgements[a.id]).length, loading: !snapshot, lastSuccessful, ackError };
}
