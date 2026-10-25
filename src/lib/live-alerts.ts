import { useEffect, useState } from "react";
import { API_URL } from "@/lib/live-hardware";
import { supabase } from "@/integrations/supabase/client";

export type LiveAlert = { id: string; severity: "critical" | "warning" | "info"; title: string; description: string; action: string };
type Snapshot = { health: any; status: any; ai: any; weight: any; feeding: any; errors: Record<string,string> };

const POLL_MS = 3000;
const listeners = new Set<() => void>();
let snapshot: Snapshot | null = null;
let lastSuccessful = false;
let subscribers = 0;
let timer: ReturnType<typeof setInterval> | undefined;
let inFlight = false;
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
async function fetchJson(path: string) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2500);
  try {
    const r = await fetch(`${API_URL}${path}`, { cache: "no-store", signal: controller.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally { clearTimeout(timeout); }
}
async function refresh() {
  if (inFlight) return;
  inFlight = true;
  const endpoints = { health: "/api/system/health", status: "/api/status", ai: "/api/ai/status", weight: "/api/feeding/weight", feeding: "/api/feeding/status" } as const;
  const entries = Object.entries(endpoints);
  try {
    const results = await Promise.allSettled(entries.map(([, path]) => fetchJson(path)));
    const next: Snapshot = { health: null, status: null, ai: null, weight: null, feeding: null, errors: {} };
    results.forEach((result, i) => {
      const key = entries[i][0] as keyof Omit<Snapshot, "errors">;
      if (result.status === "fulfilled") next[key] = result.value;
      else next.errors[key] = result.reason instanceof Error ? result.reason.message : "Unavailable";
    });
    const accessible = !!next.status || !!next.health;
    if (accessible) lastSuccessful = true;
    snapshot = next;
    await syncAcks();
    emit();
  } finally { inFlight = false; }
}
function add(out: LiveAlert[], id: string, severity: LiveAlert["severity"], title: string, description: string, action: string) {
  if (!out.some(a => a.id === id)) out.push({ id, severity, title, description, action });
}
function deriveAlerts(s: Snapshot | null): LiveAlert[] {
  if (!s) return [];
  const out: LiveAlert[] = [];
  if (!s.status && !s.health) {
    add(out, "api-unreachable", "critical", "Raspberry Pi API unavailable", "Cannot retrieve live system status. Other readings cannot be verified.", "Check the Pi, Flask service, network, and API URL.");
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
    if (hw.temperature == null || hw.humidity == null) add(out,"dht22-no-reading","warning","DHT22 readings unavailable","LIVE mode is enabled, but temperature or humidity is missing.","Inspect DHT22 wiring and Arduino serial readings.");
    else if (Number.isFinite(Number(hw.temperature))) {
      const low = Number(hw.temperatureTarget?.min), high = Number(hw.temperatureTarget?.max), value = Number(hw.temperature);
      if (Number.isFinite(high) && value > high) add(out,"temperature-high","critical","Temperature above target",`${value.toFixed(1)} °C exceeds the configured ${high.toFixed(1)} °C maximum.`,"Check cooling fans, ventilation, and the temperature sensor.");
      if (Number.isFinite(low) && value < low) add(out,"temperature-low","warning","Temperature below target",`${value.toFixed(1)} °C is below the configured ${low.toFixed(1)} °C minimum.`,"Check the heater and temperature sensor.");
    }
    if (hw.lightRaw == null) add(out,"ldr-no-reading","warning","LDR reading unavailable","LIVE mode is enabled, but no light sensor reading is reported.","Check the LDR wiring and Arduino output.");
  }
  if (s.ai?.error || s.ai?.status === "error") add(out,"ai-error","warning","AI classification error",String(s.ai.error || "The classifier reported an error."),"Inspect the camera feed and AI backend logs.");
  if (s.ai?.finisherAcknowledgementRequired || s.ai?.finisherTransitionPending) add(out,"finisher-ack","warning","Finisher stage needs acknowledgement","A confirmed transition is waiting for the farmer's refill acknowledgement.","Verify the correct Finisher feed is loaded, then acknowledge the transition in the AI Stage page.");
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
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const notify = () => setRevision(v => v + 1);
    listeners.add(notify); subscribers++;
    if (subscribers === 1) { void refresh(); timer = setInterval(() => void refresh(), POLL_MS); }
    return () => { listeners.delete(notify); subscribers--; if (subscribers === 0) { clearInterval(timer); timer = undefined; } };
  }, []);
  void revision;
  const all = deriveAlerts(snapshot);
  return { alerts: all.filter(a => !acknowledgements[a.id]), acknowledged: all.filter(a => !!acknowledgements[a.id]), count: all.filter(a => !acknowledgements[a.id]).length, loading: !snapshot, lastSuccessful, ackError };
}
