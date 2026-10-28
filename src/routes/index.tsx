import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Activity, Camera, Cpu, Droplets, Fan, Flame, Lightbulb, ScanEye, Sun, Thermometer, Wheat } from "lucide-react";
import { Card, CardTitle, Pill } from "@/components/poultrix/ui";
import { API_URL, useAI, useHardware, display, stageName } from "@/lib/live-hardware";
import { formatWeight, readingStatus, formatReadingTime, type WeightPayload } from "@/lib/live-weights";

export const Route = createFileRoute("/")({
  head: () => ({ meta: [{ title: "Dashboard — POULTRIX" }, { name: "description", content: "Live Poultrix hardware monitoring" }] }),
  component: Dashboard,
});

type Health = { status?: string; issues?: string[]; lastChecked?: string; internet?: boolean; camera?: boolean; arduino?: boolean; aiModel?: boolean; dht22?: string | null };

type Gate = { status?: string; durationMs?: number; estimatedGrams?: number | null; updatedAt?: string | null };
type Feeding = { connected?: boolean; gates?: Record<string, Gate>; events?: unknown[]; pending?: { gate?: number; durationMs?: number } | null };

function useEndpoint<T>(path: string) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    let busy = false;
    const load = async () => {
      if (busy) return;
      busy = true;
      try {
        const response = await fetch(`${API_URL}${path}`, { cache: "no-store" });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const value = await response.json() as T;
        if (active) { setData(value); setError(null); }
      } catch (cause) {
        if (active) { setData(null); setError(cause instanceof Error ? cause.message : "Unavailable"); }
      } finally { busy = false; }
    };
    void load();
    const timer = setInterval(() => void load(), 3000);
    return () => { active = false; clearInterval(timer); };
  }, [path]);
  return { data, error };
}

function Dashboard() {
  const { data: hw, error: hardwareError } = useHardware();
  const { data: ai, error: aiError } = useAI();
  const { data: health, error: healthError } = useEndpoint<Health>("/api/system/health");
  const { data: weight, error: weightError } = useEndpoint<WeightPayload>("/api/feeding/weight");
  const { data: feeding, error: feedingError } = useEndpoint<Feeding>("/api/feeding/status");

  const connected = hw?.connected === true && !hardwareError;
  const mode = hw?.mode?.toLowerCase();
  const live = connected && mode === "live";
  const temp = live ? hw?.temperature : null;
  const humidity = live ? hw?.humidity : null;
  const rawLight = live ? hw?.lightRaw : null;
  const target = hw?.temperatureTarget;
  const high = typeof temp === "number" && target && temp > target.max;
  const low = typeof temp === "number" && target && temp < target.min;
  const stage = stageName(ai?.detectedStage);
  const systemStatus = healthError ? "API unavailable" : health?.status || "Checking";
  const healthReady = health?.status === "READY" && connected;
  const gates = Object.entries(feeding?.gates ?? {});
  const activeGates = gates.filter(([, gate]) => gate.status === "DISPENSING");
  const hopper = weight?.hopperWeight;
  const trough = weight?.troughWeight;

  return (
    <div className="space-y-5">
      <Card>
        <CardTitle icon={<Activity className="h-4 w-4" />} right={<Pill tone={healthReady ? "ok" : "warn"}>{systemStatus}</Pill>}>Live Poultrix system</CardTitle>
        <p className="text-sm text-muted-foreground">{healthReady ? "Monitored services are responding." : health?.issues?.length ? health.issues.join(" · ") : "Waiting for a healthy connection to the Raspberry Pi."}</p>
        <div className="mt-3 flex flex-wrap gap-2 text-xs text-muted-foreground">
          <span>Arduino: {connected ? "Connected" : "Unavailable"}</span><span>·</span>
          <span>Mode: {connected ? mode?.toUpperCase() || "Unknown" : "Unavailable"}</span><span>·</span>
          <span>Camera: {hw?.camera?.connected ? "Connected" : "Unavailable"}</span><span>·</span>
          <span>AI: {aiError ? "Unavailable" : ai?.status || "Waiting"}</span>
        </div>
        {mode === "test" && <p className="mt-3 rounded-lg bg-surface px-3 py-2 text-sm">Arduino is in TEST mode. Simulated temperature and lighting values are intentionally hidden here. Switch to LIVE mode when the sensors are ready.</p>}
        {hardwareError && <p className="mt-2 text-xs text-destructive">Hardware API: {hardwareError}</p>}
      </Card>

      <div className="grid gap-5 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardTitle icon={<ScanEye className="h-4 w-4" />} right={<Link to="/ai-stage" className="text-xs font-semibold text-primary">AI details →</Link>}>AI growth stage</CardTitle>
          <div className="mt-2 text-5xl font-extrabold">{stage || "—"}</div>
          <p className="mt-2 text-sm text-muted-foreground">{stage && typeof ai?.confidence === "number" ? `${ai.confidence.toFixed(1)}% confidence` : "Awaiting a completed classification"}</p>
          <div className="mt-4 grid grid-cols-2 gap-3">
            <Stat label="AI status" value={ai?.status || "Unavailable"} />
            <Stat label="Last analyzed" value={formatDate(ai?.lastInference)} />
          </div>
          <p className="mt-3 text-xs text-muted-foreground">AI-detected stage is shown separately from the Arduino's current control stage ({connected ? stageName(hw?.stage) || "Unknown" : "Unavailable"}).</p>
        </Card>
        <Card>
          <CardTitle icon={<Thermometer className="h-4 w-4" />} right={<Pill tone={!live || temp == null ? "neutral" : high || low ? "warn" : "ok"}>{!live || temp == null ? "No live reading" : high ? "Above target" : low ? "Below target" : "In range"}</Pill>}>Temperature</CardTitle>
          <div className="num mt-2 text-5xl font-extrabold">{display(temp, "°C")}</div>
          <p className="mt-2 text-sm text-muted-foreground">Target: {connected && target ? `${target.min}–${target.max}°C` : "—"}</p>
          <div className="mt-4 grid grid-cols-2 gap-3">
            <Stat label="Humidity" value={display(humidity, "%")} icon={<Droplets className="h-4 w-4" />} />
            <Stat label="LDR raw" value={typeof rawLight === "number" ? String(rawLight) : "—"} icon={<Sun className="h-4 w-4" />} />
          </div>
          <p className="mt-3 text-xs text-muted-foreground">{!live ? "LIVE mode required for actual sensor readings." : "Readings reported by Arduino sensors."}</p>
        </Card>
      </div>

      <div className="grid gap-5 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardTitle icon={<Wheat className="h-4 w-4" />} right={<Link to="/feeding" className="text-xs font-semibold text-primary">Feeding details →</Link>}>Feed compartments · live monitoring</CardTitle>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="rounded-xl bg-surface p-4">
              <div className="text-xs uppercase tracking-wider text-muted-foreground">Hopper · calibrated load cell</div>
              <div className="num mt-2 text-4xl font-extrabold">{formatWeight(hopper)}</div>
              <p className="mt-2 text-xs text-muted-foreground">{weightError ? `Weight API: ${weightError}` : readingStatus(hopper)}</p>
              <p className="mt-1 text-xs text-muted-foreground">{formatReadingTime(hopper)}</p>
              <div className="mt-4 text-xs uppercase tracking-wider text-muted-foreground">Trough · calibrated load cell</div>
              <div className="num mt-2 text-4xl font-extrabold">{formatWeight(trough)}</div>
              <p className="mt-2 text-xs text-muted-foreground">{weightError ? `Weight API: ${weightError}` : readingStatus(trough)}</p>
              <p className="mt-1 text-xs text-muted-foreground">{formatReadingTime(trough)}</p>
              {!hopper && !trough && <p className="mt-2 text-xs text-amber-600">The API has not supplied separate hopper and trough fields. Verify the Raspberry Pi parser before displaying weights.</p>}
            </div>
            <div className="rounded-xl border p-4">
              <div className="text-xs uppercase tracking-wider text-muted-foreground">Dispensing status</div>
              <div className="mt-2 text-2xl font-bold">{feedingError || !feeding?.connected ? "Unavailable" : activeGates.length ? "Dispensing" : feeding?.pending ? "Starting" : gates.length ? "Not dispensing" : "Waiting"}</div>
              <p className="mt-2 text-sm text-muted-foreground">{activeGates.length ? `Active gate(s): ${activeGates.map(([id]) => id).join(", ")}` : "Servo states reported by Arduino"}</p>
              <p className="mt-2 text-xs text-muted-foreground">{feedingError ? `Feeding API: ${feedingError}` : "Dispensed amounts based on servo timing are estimates, not verified scale measurements."}</p>
            </div>
          </div>
          <div className="mt-4 grid gap-2 sm:grid-cols-3">
            {["1", "2", "3"].map(id => <Stat key={id} label={`Gate ${id}`} value={feeding?.connected ? feeding.gates?.[id]?.status || "Unknown" : "Unavailable"} />)}
          </div>
        </Card>
        <Card>
          <CardTitle icon={<Cpu className="h-4 w-4" />} right={<Link to="/environment" className="text-xs font-semibold text-primary">Environment →</Link>}>Devices</CardTitle>
          <div className="grid grid-cols-3 gap-2">
            <Device icon={<Fan className="h-5 w-5" />} label="Fans" value={connected ? `${hw?.fansOn ?? 0}/4 ON` : "—"} />
            <Device icon={<Flame className="h-5 w-5" />} label="Heat" value={connected ? `${(hw?.heatersOn ?? 0) > 0 ? 1 : 0}/1 relay ON` : "—"} />
            <Device icon={<Lightbulb className="h-5 w-5" />} label="Light" value={connected ? hw?.led ? "ON" : "OFF" : "—"} />
          </div>
          <div className="mt-4 flex items-center gap-2 text-sm text-muted-foreground"><Camera className="h-4 w-4" /> Camera: {hw?.camera?.connected ? "Connected" : "Unavailable"}</div>
          <p className="mt-3 text-xs text-muted-foreground">Device states are Arduino-reported commands, not independent electrical feedback.</p>
        </Card>
      </div>
      <Card>
        <CardTitle>Historical trends</CardTitle>
        <p className="text-sm text-muted-foreground">Historical temperature and feeding charts will appear after persistent data logging is connected. No sample readings are displayed as real history.</p>
      </Card>
    </div>
  );
}

function formatDate(value?: string | null) {
  if (!value) return "—";
  const time = new Date(value);
  return Number.isNaN(time.getTime()) ? "—" : time.toLocaleString();
}
function Stat({ label, value, icon }: { label: string; value: string; icon?: React.ReactNode }) {
  return <div className="rounded-xl bg-surface p-3"><div className="flex items-center gap-1.5 text-xs text-muted-foreground">{icon}{label}</div><div className="mt-1 break-words text-lg font-bold">{value}</div></div>;
}
function Device({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return <div className="rounded-xl border bg-surface p-3 text-center"><div className="flex justify-center">{icon}</div><div className="mt-1 text-xs font-semibold">{label}</div><div className="mt-1 text-xs text-muted-foreground">{value}</div></div>;
}
