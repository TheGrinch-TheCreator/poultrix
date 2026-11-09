import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Camera, Cpu, Droplets, Fan, Flame, Lightbulb, ScanEye, Sun, Thermometer, Wheat } from "lucide-react";
import { Card, CardTitle, Pill } from "@/components/poultrix/ui";
import { agreeingDetection, sameStage, useAI, useHardware, display, stageName } from "@/lib/live-hardware";
import { usePiEndpoint } from "@/lib/live-endpoints";
import { formatWeight, formatGrams, readingStatus, formatReadingTime, type WeightPayload } from "@/lib/live-weights";

export const Route = createFileRoute("/")({
  head: () => ({ meta: [{ title: "Dashboard — POULTRIX" }, { name: "description", content: "Live Poultrix hardware monitoring" }] }),
  component: Dashboard,
});

type FeedingPlan = { targetGrams?: number | null; times?: string[]; selectedCompartment?: number | null; confirmedStage?: string; automationStatus?: string };

type Health = { status?: string; issues?: string[]; lastChecked?: string; internet?: boolean; camera?: boolean; arduino?: boolean; aiModel?: boolean; dht22?: string | null };

type Gate = { status?: string; durationMs?: number; estimatedGrams?: number | null; updatedAt?: string | null };
type Feeding = { connected?: boolean; gates?: Record<string, Gate>; events?: unknown[]; pending?: { gate?: number; durationMs?: number } | null };

function useEndpoint<T>(path: string) {
  // Live parts come from the shared snapshot; the feeding plan is polled every 60 s.
  return usePiEndpoint<T>(path);
}

function Dashboard() {
  const { data: hw, error: hardwareError } = useHardware();
  const { data: ai, error: aiError } = useAI();
  const { data: weight, error: weightError } = useEndpoint<WeightPayload>("/api/feeding/weight");
  const { data: feeding, error: feedingError } = useEndpoint<Feeding>("/api/feeding/status");
  const { data: feedingPlan, error: planError } = useEndpoint<FeedingPlan>("/api/feeding/config");
  const [clock, setClock] = useState(() => Date.now());
  useEffect(() => { const timer = setInterval(() => setClock(Date.now()), 1000); return () => clearInterval(timer); }, []);

  const connected = hw?.connected === true && !hardwareError;
  const mode = hw?.mode?.toLowerCase();
  const live = connected && mode === "live";
  const temp = live ? hw?.temperature : null;
  const humidity = live ? hw?.humidity : null;
  const rawLight = live ? hw?.lightRaw : null;
  const target = hw?.temperatureTarget;
  const high = typeof temp === "number" && target && temp > target.max;
  const low = typeof temp === "number" && target && temp < target.min;
  const stage = connected ? stageName(hw?.stage) : null;
  const agreeing = agreeingDetection(ai, hw?.stage);
  const detectedStage = agreeing?.stage ?? null;
  const gates = Object.entries(feeding?.gates ?? {});
  const activeGates = gates.filter(([, gate]) => gate.status === "DISPENSING");
  const hopper = weight?.hopper;
  const trough = weight?.trough;
  const nextFeeding = getNextFeeding(feedingPlan?.times, clock);
  const assignedCompartment = feedingPlan?.selectedCompartment;
  const schedule = ai?.schedule;
  // Confidence: the latest reading if it agrees with the confirmed stage, else
  // the last REAL confident reading that matched it (never computed).
  const lastMatch = ai?.lastAgreeingDetection && sameStage(ai.lastAgreeingDetection.stage, hw?.stage) ? ai.lastAgreeingDetection : null;
  const aiConfidence = typeof agreeing?.confidence === "number" && ai?.lastInference ? `${agreeing.confidence.toFixed(1)}%` : lastMatch ? `${lastMatch.confidence.toFixed(1)}%` : "—";
  // Last analyzed: when the last scheduled daily AI check ran (not manual camera checks).
  const lastScheduled = schedule?.lastAttempt?.startedAt ?? schedule?.lastAttempt?.finishedAt ?? null;
  const nextStage = stageName(schedule?.nextStage);

  return (
    <div className="space-y-5">
      <div className="grid gap-5 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardTitle icon={<ScanEye className="h-4 w-4" />} right={<Link to="/ai-stage" className="text-xs font-semibold text-primary">AI details →</Link>}>Confirmed growth stage</CardTitle>
          <div className="mt-2 text-5xl font-extrabold">{stage || "—"}</div>
          <p className="mt-2 text-sm text-muted-foreground">{stage ? "Arduino-confirmed growth stage (restored after restart)" : "Waiting for Arduino confirmation"}</p>
          <div className="mt-4 grid grid-cols-2 gap-3">
            <Stat label="AI confidence" value={aiConfidence} />
            <Stat label="Last analyzed" value={lastScheduled ? formatDate(lastScheduled) : "—"} />
          </div>
          {schedule && schedule.batchDay !== null && (
            <div className="mt-4 grid grid-cols-2 gap-3">
              <Stat label="Next AI check" value={schedule.windowOpen ? "Checking now" : countdown(schedule.nextCheckAt, clock)} />
            </div>
          )}
          <p className="mt-3 text-xs text-muted-foreground">Latest AI detection: {detectedStage || "—"}. The main stage above comes from Arduino confirmation, not an unconfirmed AI prediction.{nextStage && schedule?.nextStageFromDay ? ` ${nextStage} can be confirmed from day ${schedule.nextStageFromDay}; the AI checks once a day at ${schedule.checkTime}.` : ""}</p>
        </Card>
        <Card>
          <CardTitle icon={<Thermometer className="h-4 w-4" />} right={<Pill tone={!live || temp == null ? "neutral" : high || low ? "warn" : "ok"}>{!live || temp == null ? "No live reading" : high ? "Above target" : low ? "Below target" : "In range"}</Pill>}>Temperature</CardTitle>
          <div className="num mt-2 text-5xl font-extrabold">{display(temp, "°C")}</div>
          <p className="mt-2 text-sm text-muted-foreground">Target: {connected && target ? `${target.min}–${target.max}°C` : "—"}</p>
          <div className="mt-4 grid grid-cols-2 gap-3">
            <Stat label="Humidity" value={display(humidity, "%")} icon={<Droplets className="h-4 w-4" />} />
            <Stat label="LDR raw" value={typeof rawLight === "number" ? String(rawLight) : "—"} icon={<Sun className="h-4 w-4" />} />
          </div>
          <p className="mt-3 text-xs text-muted-foreground">{!live ? "Waiting for the Arduino to report sensor readings." : "Readings reported by Arduino sensors."}</p>
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
              <div className="num mt-2 text-4xl font-extrabold">{formatGrams(trough)}</div>
              <p className="mt-2 text-xs text-muted-foreground">{weightError ? `Weight API: ${weightError}` : readingStatus(trough)}</p>
              <p className="mt-1 text-xs text-muted-foreground">{formatReadingTime(trough)}</p>
              {!hopper && !trough && <p className="mt-2 text-xs text-amber-600">The API has not supplied separate hopper and trough fields. Verify the Raspberry Pi parser before displaying weights.</p>}
            </div>
            <div className="rounded-xl border p-4" aria-live="off">
              <div className="text-xs uppercase tracking-wider text-muted-foreground">Next scheduled feeding</div>
              <div className="num mt-2 text-3xl font-extrabold">{nextFeeding ? nextFeeding.time : "—"}</div>
              <div className="mt-3 text-xs text-muted-foreground">Countdown</div>
              <div className="num mt-1 text-3xl font-bold tabular-nums" aria-label="Time remaining until next scheduled feeding">{nextFeeding ? formatCountdown(nextFeeding.remainingMs) : "—"}</div>
              {nextFeeding && <p className="mt-1 text-xs text-muted-foreground">{nextFeeding.tomorrow ? "Tomorrow" : "Today"} · device local time</p>}
              <div className="mt-4 text-xs uppercase tracking-wider text-muted-foreground">Next feeding target</div>
              <div className="num mt-1 text-2xl font-bold">{nextFeeding && typeof feedingPlan?.targetGrams === "number" && Number.isFinite(feedingPlan.targetGrams) && feedingPlan.targetGrams > 0 ? `${feedingPlan.targetGrams.toLocaleString(undefined, { maximumFractionDigits: 2 })} g` : "—"}</div>
              <p className="mt-1 text-xs text-muted-foreground">Planned amount per session, based on the saved flock size and confirmed growth stage.</p>
              <div className="mt-4 text-xs uppercase tracking-wider text-muted-foreground">Assigned feed compartment</div>
              <div className="mt-2 flex items-center gap-2">
                {assignedCompartment === 1 || assignedCompartment === 2 ? <>
                  {/* Same colors as the Feeding page: compartment 1 green, compartment 2 orange. */}
                  <span className="inline-block h-3 w-3 rounded-full" style={{ background: assignedCompartment === 1 ? "#8acb32" : "#f59a30" }} aria-hidden="true" />
                  <span className="font-semibold" style={{ color: assignedCompartment === 1 ? "#5f9a1c" : "#d97a12" }}>Compartment {assignedCompartment}</span>
                </> : <span className="text-sm text-muted-foreground">Not assigned</span>}
              </div>
              {planError && <p className="mt-2 text-xs text-destructive">Feeding plan unavailable: {planError}</p>}
              {!planError && !nextFeeding && <p className="mt-2 text-xs text-muted-foreground">No valid feeding times configured.</p>}
              <p className="mt-4 text-xs text-muted-foreground">Schedule preview only. Automatic dispensing remains locked until hardware safety tests pass.</p>
            </div>
          </div>
        </Card>
        <Card>
          <CardTitle icon={<Cpu className="h-4 w-4" />} right={<Link to="/environment" className="text-xs font-semibold text-primary">Environment →</Link>}>Devices</CardTitle>
          <div className="grid grid-cols-3 gap-2">
            <Device on={connected && (hw?.fansOn ?? 0) > 0} icon={<Fan className="h-5 w-5" />} label="Fans" value={connected ? `${hw?.fansOn ?? 0}/4 ON` : "—"} />
            <Device on={connected && (hw?.heatersOn ?? 0) > 0} icon={<Flame className="h-5 w-5" />} label="Heat" value={connected ? `${(hw?.heatersOn ?? 0) > 0 ? 1 : 0}/1 relay ON` : "—"} />
            <Device on={connected && !!hw?.led} icon={<Lightbulb className="h-5 w-5" />} label="Light" value={connected ? hw?.led ? "ON" : "OFF" : "—"} />
          </div>
          <div className="mt-4 flex items-center gap-2 text-sm text-muted-foreground"><Camera className={`h-4 w-4 ${hw?.camera?.connected ? "text-ok" : ""}`} /> Camera: <span className={hw?.camera?.connected ? "font-semibold text-ok" : ""}>{hw?.camera?.connected ? "Connected" : "Unavailable"}</span></div>
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

/** "17 h 58 m 12 s" / "1 d 2 h 3 m 4 s" / "58 s" until `iso`; "—" when unknown. */
function countdown(iso: string | null | undefined, now: number): string {
  if (!iso) return "—";
  const ms = new Date(iso).getTime() - now;
  if (!Number.isFinite(ms)) return "—";
  if (ms <= 0) return "Due now";
  const s = Math.floor(ms / 1000), d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return d > 0 ? `${d} d ${h} h ${m} m ${sec} s` : h > 0 ? `${h} h ${m} m ${sec} s` : m > 0 ? `${m} m ${sec} s` : `${sec} s`;
}

function formatDate(value?: string | null) {
  if (!value) return "—";
  const time = new Date(value);
  return Number.isNaN(time.getTime()) ? "—" : time.toLocaleString();
}
function Stat({ label, value, icon }: { label: string; value: string; icon?: React.ReactNode }) {
  return <div className="rounded-xl bg-surface p-3"><div className="flex items-center gap-1.5 text-xs text-muted-foreground">{icon}{label}</div><div className="mt-1 break-words text-lg font-bold">{value}</div></div>;
}
/** Green icon and tile while the Arduino reports the device on. */
function Device({
  icon,
  label,
  value,
  on,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  on: boolean;
}) {
  return (
    <div
      className={`rounded-xl border p-3 text-center transition-colors ${on ? "border-ok/40 bg-ok-soft" : "bg-surface"}`}
    >
      <div className={`flex justify-center ${on ? "text-ok" : "text-muted-foreground"}`}>
        {icon}
      </div>
      <div className="mt-1 text-xs font-semibold">{label}</div>
      <div className={`mt-1 text-xs ${on ? "font-semibold text-ok" : "text-muted-foreground"}`}>
        {value}
      </div>
    </div>
  );
}

/** Finds the next configured HH:mm slot in the browser's local time zone. */
function getNextFeeding(times: string[] | undefined, nowMs: number): { time: string; remainingMs: number; tomorrow: boolean } | null {
  if (!Array.isArray(times)) return null;
  const now = new Date(nowMs);
  const candidates = times.flatMap(time => {
    const match = /^(\d{1,2}):(\d{2})$/.exec(time);
    if (!match) return [];
    const hour = Number(match[1]);
    const minute = Number(match[2]);
    if (hour > 23 || minute > 59) return [];
    const next = new Date(now);
    next.setHours(hour, minute, 0, 0);
    if (next.getTime() <= nowMs) next.setDate(next.getDate() + 1);
    return [{ time: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`, nextMs: next.getTime() }];
  });
  candidates.sort((a, b) => a.nextMs - b.nextMs);
  const next = candidates[0];
  if (!next) return null;
  return { time: next.time, remainingMs: Math.max(0, next.nextMs - nowMs), tomorrow: new Date(next.nextMs).getDate() !== now.getDate() || new Date(next.nextMs).getMonth() !== now.getMonth() };
}
function formatCountdown(ms: number): string {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  return [hours, minutes, remainder].map(n => String(n).padStart(2, "0")).join(":");
}
