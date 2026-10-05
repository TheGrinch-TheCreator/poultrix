import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { AlertOctagon, AlertTriangle, Info } from "lucide-react";
import { alerts, type Alert } from "@/lib/demo-data";
import { DemoTag, PageHeader, Pill, type Tone } from "@/components/poultrix/ui";

export const Route = createFileRoute("/alerts")({
  head: () => ({
    meta: [
      { title: "Alerts — POULTRIX" },
      { name: "description", content: "Critical and warning alerts with cause and recommended farmer action." },
      { property: "og:title", content: "Alerts — POULTRIX" },
      { property: "og:description", content: "Critical and warning alerts with cause and recommended farmer action." },
    ],
  }),
  component: AlertsPage,
});

const sev: Record<Alert["severity"], { tone: Tone; icon: typeof Info; label: string; border: string }> = {
  critical: { tone: "danger", icon: AlertOctagon, label: "Critical", border: "border-l-danger" },
  warning: { tone: "warn", icon: AlertTriangle, label: "Warning", border: "border-l-warn" },
  info: { tone: "info", icon: Info, label: "Action needed", border: "border-l-info" },
};

const FILTERS = ["All", "Active", "Upcoming", "Resolved"] as const;

function AlertsPage() {
  const [f, setF] = useState<(typeof FILTERS)[number]>("All");
  const list = alerts.filter((a) => f === "All" || a.status === f);
  return (
    <>
      <PageHeader title="Alerts" subtitle="What needs your attention, and what to do about it." right={<DemoTag />} />
      <div className="mb-5 flex gap-2 overflow-x-auto">
        {FILTERS.map((x) => (
          <button key={x} onClick={() => setF(x)} className={`rounded-full border px-4 py-2 text-sm font-semibold ${f === x ? "border-primary bg-primary text-primary-foreground" : "bg-card"}`}>{x}</button>
        ))}
      </div>
      {list.length === 0 && <div className="card-surface p-10 text-center text-muted-foreground">No alerts here. Everything looks good.</div>}
      <div className="space-y-3">
        {list.map((a) => {
          const s = sev[a.severity];
          const Icon = s.icon;
          return (
            <article key={a.id} className={`card-surface border-l-4 p-5 ${s.border} ${a.status === "Resolved" ? "opacity-70" : ""}`}>
              <div className="flex flex-wrap items-center gap-2">
                <Pill tone={s.tone}><Icon className="h-3.5 w-3.5" />{s.label}</Pill>
                <Pill tone={a.status === "Resolved" ? "ok" : "neutral"}>{a.status}</Pill>
                <span className="ml-auto text-xs text-muted-foreground">{a.time}</span>
              </div>
              <h2 className="mt-3 text-lg font-bold">{a.title}</h2>
              <p className="text-muted-foreground">{a.description}</p>
              <div className="mt-3 grid gap-2 text-sm sm:grid-cols-2">
                <div className="rounded-lg bg-surface p-3"><span className="font-semibold">Cause: </span>{a.cause}</div>
                <div className="rounded-lg bg-secondary p-3 text-secondary-foreground"><span className="font-semibold">What to do: </span>{a.action}</div>
              </div>
            </article>
          );
        })}
      </div>
    </>
  );
}
