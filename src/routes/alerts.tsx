import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { API_URL } from "@/lib/live-hardware";
import { AlertOctagon, AlertTriangle, Check, Info, Undo2, RefreshCw } from "lucide-react";
import { PageHeader, Pill, type Tone } from "@/components/poultrix/ui";
import { acknowledgeLiveAlert, restoreLiveAlert, useLiveAlerts, type LiveAlert } from "@/lib/live-alerts";

export const Route = createFileRoute("/alerts")({
  head: () => ({ meta: [{ title: "Alerts — POULTRIX" }, { name: "description", content: "Live Poultrix hardware and environment alerts." }] }),
  component: AlertsPage,
});
const severity: Record<LiveAlert["severity"], { tone: Tone; icon: typeof Info; label: string; border: string }> = {
  critical: { tone: "danger", icon: AlertOctagon, label: "Critical", border: "border-l-danger" },
  warning: { tone: "warn", icon: AlertTriangle, label: "Warning", border: "border-l-warn" },
  info: { tone: "info", icon: Info, label: "Information", border: "border-l-info" },
};
function useSystemLedHealth() {
  const [health, setHealth] = useState<{status?: string; issues?: string[]} | null>(null);
  const [healthError, setHealthError] = useState(false);
  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const r = await fetch(`${API_URL}/api/system/health`, {cache: "no-store"});
        if (!r.ok) throw new Error(String(r.status));
        const value = await r.json();
        if (active) { setHealth(value); setHealthError(false); }
      } catch { if (active) { setHealth(null); setHealthError(true); } }
    };
    void load(); const interval = setInterval(() => void load(), 3000);
    return () => { active = false; clearInterval(interval); };
  }, []);
  return {health, healthError};
}
const FILTERS = ["All", "Active", "Acknowledged"] as const;
function AlertsPage() {
  const { alerts, acknowledged, loading, ackError } = useLiveAlerts();
  const { health, healthError } = useSystemLedHealth();
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>("All");
  const visible = filter === "Active" ? alerts : filter === "Acknowledged" ? acknowledged : [...alerts, ...acknowledged];
  return <>
    <PageHeader title="Alerts" subtitle="Live system conditions requiring your attention." />
    <div className="card-surface mb-5 p-4">
      <div className="flex flex-wrap items-center gap-3">
        <span className={`h-4 w-4 rounded-full ${healthError || !health ? "bg-slate-400" : health.status === "READY" ? "bg-green-500" : "bg-yellow-400"}`} aria-hidden="true" />
        <div><div className="font-semibold">Arduino system LED: {healthError || !health ? "Unknown" : health.status === "READY" ? "Green — Healthy" : "Yellow — Attention required"}</div>
        <p className="text-xs text-muted-foreground">Mirrors the Raspberry Pi health decision sent to Arduino D35 (green) / D36 (yellow). Actual LED electrical state is not independently sensed.</p></div>
      </div>
      {health?.issues?.length ? <ul className="mt-3 list-inside list-disc text-sm text-amber-700 dark:text-amber-300">{health.issues.map((issue,i) => <li key={i}>{issue}</li>)}</ul> : null}
      <p className="mt-2 text-xs text-muted-foreground">Acknowledging alerts turns their acknowledgement indicator green; hardware warning LEDs remain yellow until the fault is fixed.</p>
    </div>
    {ackError && <p role="alert" className="mb-4 text-sm text-red-600">Acknowledgement sync: {ackError}</p>}
    <div className="mb-5 flex flex-wrap items-center gap-2">
      {FILTERS.map(x => <button key={x} onClick={() => setFilter(x)} className={`rounded-full border px-4 py-2 text-sm font-semibold ${filter === x ? "border-primary bg-primary text-primary-foreground" : "bg-card"}`}>{x}{x === "Active" ? ` (${alerts.length})` : x === "Acknowledged" ? ` (${acknowledged.length})` : ""}</button>)}
      <span className="ml-auto flex items-center gap-1 text-xs text-muted-foreground"><RefreshCw className="h-3.5 w-3.5" /> Every 3 seconds</span>
    </div>
    {loading && <div className="card-surface p-8 text-center text-muted-foreground">Checking Raspberry Pi alerts…</div>}
    {!loading && visible.length === 0 && <div className="card-surface p-8 text-center text-muted-foreground">{filter === "Acknowledged" ? "No acknowledged alerts." : "No active alerts detected by the monitored systems."}</div>}
    <div className="space-y-3">{visible.map(a => {
      const style = severity[a.severity]; const Icon = style.icon; const ack = acknowledged.some(x => x.id === a.id);
      return <article key={a.id} className={`card-surface border-l-4 p-5 ${style.border} ${ack ? "opacity-70" : ""}`}>
        <div className="flex flex-wrap items-center gap-2"><Pill tone={style.tone}><Icon className="h-3.5 w-3.5" />{style.label}</Pill><Pill tone={ack ? "ok" : "warn"}>{ack ? "✓ Acknowledged" : "Active"}</Pill></div>
        <h2 className="mt-3 text-lg font-bold">{a.title}</h2><p className="mt-1 text-sm text-muted-foreground">{a.description}</p>
        <div className="mt-3 rounded-lg bg-secondary p-3 text-sm"><span className="font-semibold">Recommended action: </span>{a.action}</div>
        <div className="mt-4 flex justify-end"><button onClick={() => ack ? restoreLiveAlert(a.id) : acknowledgeLiveAlert(a.id)} className="flex h-10 items-center gap-2 rounded-xl border border-primary/40 px-4 text-sm font-semibold text-primary hover:bg-primary/10">{ack ? <><Undo2 className="h-4 w-4" /> Undo acknowledgement</> : <><Check className="h-4 w-4" /> Acknowledge</>}</button></div>
      </article>;
    })}</div>
    <p className="mt-6 text-xs text-muted-foreground">Acknowledgements are saved on the Raspberry Pi and synchronized across signed-in devices; it does not repair the underlying condition. Once the condition clears, the alert disappears. If it returns later, it becomes active again. Relay states alone do not verify physical operation.</p>
  </>;
}
