import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Activity, AlertTriangle, CheckCircle2, CircleOff, HelpCircle, RefreshCw } from "lucide-react";
import { API_URL, useAI, useHardware } from "@/lib/live-hardware";
import { grams, formatWeight, type WeightPayload } from "@/lib/live-weights";
import { Card, CardTitle, PageHeader, Pill } from "@/components/poultrix/ui";

export const Route = createFileRoute("/hardware")({
  head: () => ({ meta: [{ title: "System Status — POULTRIX" }, { name: "description", content: "Live component activity and monitored system issues." }] }),
  component: HardwarePage,
});

type Health = {
  status?: string;
  issues?: string[];
  internet?: boolean;
  arduino?: boolean;
  camera?: boolean;
  aiModel?: boolean;
  dht22?: string | null;
  lastChecked?: string;
};

type Gate = { status?: string };
type Feeding = { connected?: boolean; gates?: Record<string, Gate>; pending?: unknown };
type Condition = "active" | "inactive" | "problem" | "unknown";
type Component = { name: string; detail: string; condition: Condition };

function useLiveEndpoint<T>(path: string) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let mounted = true;
    let running = false;
    const refresh = async () => {
      if (running) return;
      running = true;
      try {
        const response = await fetch(`${API_URL}${path}`, { cache: "no-store" });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const result = await response.json() as T;
        if (mounted) { setData(result); setError(null); }
      } catch (cause) {
        if (mounted) { setData(null); setError(cause instanceof Error ? cause.message : "Unavailable"); }
      } finally { running = false; }
    };
    void refresh();
    const interval = setInterval(() => void refresh(), 3000);
    return () => { mounted = false; clearInterval(interval); };
  }, [path]);
  return { data, error };
}

const label: Record<Condition, string> = { active: "Active", inactive: "Inactive", problem: "Problem", unknown: "Unknown" };
const tone: Record<Condition, "ok" | "neutral" | "danger" | "warn"> = { active: "ok", inactive: "neutral", problem: "danger", unknown: "warn" };
const symbols = { active: CheckCircle2, inactive: CircleOff, problem: AlertTriangle, unknown: HelpCircle };

function ComponentRow({ item }: { item: Component }) {
  const Icon = symbols[item.condition];
  return (
    <li className="flex items-start justify-between gap-3 border-b py-3 last:border-b-0">
      <div className="flex min-w-0 items-start gap-3">
        <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${item.condition === "problem" ? "text-destructive" : "text-muted-foreground"}`} />
        <div className="min-w-0">
          <div className="font-semibold">{item.name}</div>
          <div className="text-xs text-muted-foreground">{item.detail}</div>
        </div>
      </div>
      <Pill tone={tone[item.condition]}>{label[item.condition]}</Pill>
    </li>
  );
}

function HardwarePage() {
  const { data: hw, error: hardwareError } = useHardware();
  const { data: ai, error: aiError } = useAI();
  const { data: health, error: healthError } = useLiveEndpoint<Health>("/api/system/health");
  const { data: weight, error: weightError } = useLiveEndpoint<WeightPayload>("/api/feeding/weight");
  const { data: feeding, error: feedingError } = useLiveEndpoint<Feeding>("/api/feeding/status");

  const online = !!hw?.connected && !hardwareError;
  const live = online && hw?.mode?.toLowerCase() === "live";
  const issues = health?.issues ?? [];
  const known = health !== null && !healthError;
  const connection = (value: boolean | undefined, monitored = true): Condition => !known || value === undefined ? "unknown" : value ? "active" : monitored ? "problem" : "inactive";
  const actuator = (value: boolean | undefined): Condition => !online || value === undefined ? "unknown" : value ? "active" : "inactive";
  const sensors = (value: number | null | undefined): Condition => !live ? "unknown" : typeof value === "number" && Number.isFinite(value) ? "active" : "problem";
  const reported = hw as (typeof hw & { fans?: boolean[]; heaters?: boolean[] }) | null;
  const fans = online && Array.isArray(reported?.fans) ? reported.fans : null;
  const heaters = online && Array.isArray(reported?.heaters) ? reported.heaters : null;
  const gates = feeding?.gates ? Object.entries(feeding.gates) : [];

  const groups: { title: string; components: Component[] }[] = [
    { title: "Connectivity & processing", components: [
      { name: "Raspberry Pi / API", detail: hardwareError ? `API unavailable: ${hardwareError}` : "Poultrix hardware API", condition: hardwareError ? "problem" : hw ? "active" : "unknown" },
      { name: "Arduino Mega 2560", detail: online ? "USB serial connected" : "Serial connection not confirmed", condition: connection(health?.arduino) },
      { name: "Internet", detail: "Internet reachability check", condition: connection(health?.internet) },
      { name: "Pi Camera V3", detail: "Camera initialization and availability", condition: connection(health?.camera) },
      { name: "AI classification model", detail: aiError ? `AI endpoint: ${aiError}` : ai?.status ? `Model status: ${ai.status}` : "Model status not reported", condition: aiError ? "unknown" : connection(health?.aiModel) },
    ] },
    { title: "Environmental sensors", components: [
      { name: "DHT22 temperature", detail: !live ? "LIVE mode required to validate sensor" : typeof hw?.temperature === "number" ? `${hw.temperature.toFixed(1)} °C reported` : "No live temperature reading", condition: sensors(hw?.temperature) },
      { name: "DHT22 humidity", detail: !live ? "LIVE mode required to validate sensor" : typeof hw?.humidity === "number" ? `${hw.humidity.toFixed(1)}% reported` : "No live humidity reading", condition: sensors(hw?.humidity) },
      { name: "LDR light sensor", detail: !live ? "LIVE mode required to validate sensor" : typeof hw?.lightRaw === "number" ? `ADC reading: ${hw.lightRaw}` : "No live light reading", condition: sensors(hw?.lightRaw) },
    ] },
    { title: "Environmental controls", components: [
      ...Array.from({ length: 4 }, (_, i): Component => ({ name: `Cooling fan ${i + 1}`, detail: "Arduino-reported relay command; not physical feedback", condition: actuator(fans?.[i]) })),
      { name: "Heater relay (2 lamps, D28 / IN7)", detail: "Arduino-reported relay command; not physical feedback", condition: actuator(heaters?.[0] ?? (online && typeof hw?.heatersOn === "number" ? hw.heatersOn > 0 : undefined)) },
      { name: "Lighting tube", detail: "Arduino-reported relay command; not physical feedback", condition: actuator(online ? hw?.led : undefined) },
    ] },
    { title: "Feeding hardware", components: [
      { name: "Hopper weight / HX711", detail: weightError ? `Weight endpoint: ${weightError}` : `Arduino-reported: ${formatWeight(weight?.hopperWeight)}`, condition: weightError ? "unknown" : grams(weight?.hopperWeight) !== null ? "active" : "unknown" },
      { name: "Trough weight / HX711", detail: weightError ? `Weight endpoint: ${weightError}` : `Arduino-reported: ${formatWeight(weight?.troughWeight)}`, condition: weightError ? "unknown" : grams(weight?.troughWeight) !== null ? "active" : "unknown" },
      ...[1, 2, 3].map((gate): Component => {
        const item = gates.find(([key]) => key === String(gate) || key === `gate${gate}`)?.[1];
        const status = item?.status?.toUpperCase();
        return { name: `Feeding gate ${gate}`, detail: status ? `Arduino-reported status: ${status}` : "No confirmed gate status", condition: feedingError || !feeding?.connected || !status ? "unknown" : status === "DISPENSING" || status === "OPEN" ? "active" : status === "FAULT" || status === "ERROR" ? "problem" : status === "CLOSED" || status === "IDLE" || status === "STOPPED" ? "inactive" : "unknown" };
      }),
    ] },
  ];

  const summary = groups.flatMap(group => group.components);
  const count = (condition: Condition) => summary.filter(item => item.condition === condition).length;
  const status = healthError ? "API unavailable" : health?.status || "Checking";

  return (
    <>
      <PageHeader title="System Status" subtitle="Live component activity and monitored problems, refreshed every 3 seconds." />
      <Card className="mb-5">
        <CardTitle icon={<Activity className="h-4 w-4" />} right={<Pill tone={status === "READY" ? "ok" : status === "FAULT" ? "danger" : "warn"}>{status}</Pill>}>System overview</CardTitle>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {(["active", "inactive", "problem", "unknown"] as Condition[]).map(condition => (
            <div key={condition} className="rounded-lg bg-surface p-3"><div className="text-2xl font-bold">{count(condition)}</div><div className="text-xs text-muted-foreground">{label[condition]}</div></div>
          ))}
        </div>
        {issues.length > 0 && <div className="mt-4 rounded-lg border border-destructive/30 p-3 text-sm"><div className="font-semibold text-destructive">Reported problems</div><ul className="mt-2 list-inside list-disc">{issues.map((issue, i) => <li key={i}>{issue}</li>)}</ul></div>}
        {healthError && <p className="mt-3 text-sm text-destructive">Health endpoint unavailable: {healthError}</p>}
        {!live && <p className="mt-3 text-xs text-muted-foreground">Sensors require LIVE mode for actual readings. Unknown does not automatically mean faulty.</p>}
        <p className="mt-3 flex items-center gap-2 text-xs text-muted-foreground"><RefreshCw className="h-3.5 w-3.5" /> Automatic refresh every 3 seconds. Relay and servo statuses are commands/reports, not proof of physical movement.</p>
      </Card>
      <div className="grid gap-5 lg:grid-cols-2">
        {groups.map(group => <Card key={group.title}><CardTitle>{group.title}</CardTitle><ul>{group.components.map(item => <ComponentRow key={item.name} item={item} />)}</ul></Card>)}
      </div>
    </>
  );
}
