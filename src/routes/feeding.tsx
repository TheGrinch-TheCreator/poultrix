import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Wheat, RefreshCw } from "lucide-react";
import { Card, CardTitle, PageHeader, Pill } from "@/components/poultrix/ui";
import { API_URL, useHardware } from "@/lib/live-hardware";
import { formatWeight, readingStatus, formatReadingTime, type WeightPayload } from "@/lib/live-weights";
import { SERVO_COMPARTMENTS, servoReading, type ServoTelemetry } from "@/lib/servo-compartments";

export const Route = createFileRoute("/feeding")({
  head: () => ({ meta: [{ title: "Feeding — POULTRIX" }, { name: "description", content: "Live Arduino feed weight and dispensing status." }] }),
  component: FeedingPage,
});

type Gate = { status?: string; durationMs?: number; estimatedGrams?: number | null; updatedAt?: string | null };
type FeedingStatus = { connected?: boolean; gates?: Record<string, Gate>; pending?: { gate?: number; durationMs?: number } | null; events?: unknown[] };

function useLiveEndpoint<T>(path: string) {
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
        if (active) { setData(null); setError(cause instanceof Error ? cause.message : "Connection unavailable"); }
      } finally { busy = false; }
    };
    void load();
    const interval = setInterval(() => void load(), 3000);
    return () => { active = false; clearInterval(interval); };
  }, [path]);
  return { data, error };
}

function FeedingPage() {
  const { data: hw, error: hardwareError } = useHardware();
  const { data: weight, error: weightError } = useLiveEndpoint<WeightPayload>("/api/feeding/weight");
  const { data: feeding, error: feedingError } = useLiveEndpoint<FeedingStatus>("/api/feeding/status");
  const { data: servos } = useLiveEndpoint<ServoTelemetry>("/api/servos/status");
  const gates = Object.entries(feeding?.gates ?? {});
  const dispensing = gates.some(([, gate]) => gate.status?.toUpperCase() === "DISPENSING");
  const connected = hw?.connected === true && !hardwareError;
  return (
    <div className="space-y-5">
      <PageHeader title="Feeding" subtitle="Live Arduino load-cell readings and reported feeding states. No simulated feeding data." />
      <Card>
        <CardTitle icon={<Wheat className="h-4 w-4" />} right={<Pill tone={connected ? "ok" : "warn"}>{connected ? "Arduino connected" : "Arduino unavailable"}</Pill>}>Live feeding monitoring</CardTitle>
        <p className="text-sm text-muted-foreground">Mode: {connected ? hw?.mode?.toUpperCase() || "Unknown" : "Unavailable"}. Weight values come from Arduino calibration; the web app does not recalibrate them.</p>
        <p className="mt-2 flex items-center gap-2 text-xs text-muted-foreground"><RefreshCw className="h-3.5 w-3.5" /> Updates every 3 seconds.</p>
      </Card>
      <div className="grid gap-5 md:grid-cols-2">
        {([ ["Hopper", weight?.hopper], ["Trough", weight?.trough] ] as const).map(([name, reading]) => (
          <Card key={name}>
            <CardTitle>{name} weight</CardTitle>
            <div className="num mt-2 text-4xl font-extrabold">{formatWeight(reading)}</div>
            <p className="mt-2 text-sm text-muted-foreground">{weightError ? `Weight API: ${weightError}` : readingStatus(reading)}</p>
            <p className="mt-1 text-xs text-muted-foreground">{formatReadingTime(reading)}</p>
          </Card>
        ))}
      </div>
      {!weightError && weight && !weight.hopper && !weight.trough && <Card><p className="text-sm text-amber-600">Separate hopper/trough readings are not present in the API response. Check Raspberry Pi serial parsing; no combined weight is presented as a compartment measurement.</p></Card>}
      <Card>
        <CardTitle>Dispensing status</CardTitle>
        <div className="mt-2 text-2xl font-bold">{feedingError || !feeding?.connected ? "Unavailable" : dispensing ? "Dispensing" : feeding.pending ? "Starting" : gates.length ? "Not dispensing" : "Waiting for status"}</div>
        {feedingError && <p className="mt-2 text-sm text-destructive">Feeding API: {feedingError}</p>}
        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          {["1", "2", "3"].map(id => {
            const gate = feeding?.gates?.[id] ?? feeding?.gates?.[`gate${id}`];
            return <div key={id} className="rounded-xl bg-surface p-3"><div className="text-xs text-muted-foreground">Gate {id}</div><div className="mt-1 text-lg font-bold">{feeding?.connected ? gate?.status || "Unknown" : "Unavailable"}</div></div>;
          })}
        </div>
        <p className="mt-3 text-xs text-muted-foreground">Gate status is reported by Arduino and does not independently verify mechanical movement. Servo-timed quantities are estimates, not measured dispensing accuracy.</p>
      </Card>
      <Card>
        <CardTitle>PCA9685 servo compartments</CardTitle>
        <p className="mt-2 text-sm text-muted-foreground">Physical channel assignment. Channel states appear only when the Raspberry Pi reports individual servo telemetry; these are not inferred from the three legacy feeding gates.</p>
        <div className="mt-4 grid gap-4 md:grid-cols-2">
          {SERVO_COMPARTMENTS.map(compartment => (
            <div key={compartment.name} className="rounded-xl border p-4">
              <div className="font-semibold">{compartment.name}</div>
              <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
                {compartment.channels.map(channel => (
                  <div key={channel} className="rounded-lg bg-surface p-3">
                    <div className="text-xs text-muted-foreground">Channel {channel}</div>
                    <div className="mt-1 text-sm font-semibold">{servoReading(servos, channel)}</div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
        <p className="mt-3 text-xs text-amber-600">Servo control and actual channel feedback require matching Arduino firmware and Raspberry Pi API support. This page does not send servo commands.</p>
      </Card>
      <Card>
        <CardTitle>Feeding history and accuracy</CardTitle>
        <p className="text-sm text-muted-foreground">No sample history or fabricated accuracy percentages are displayed. Verified historical feed measurements can be shown after the corresponding persistent API fields are confirmed.</p>
      </Card>
    </div>
  );
}
