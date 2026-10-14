import { createFileRoute } from "@tanstack/react-router";
import { Camera } from "lucide-react";
import { useEffect, useState } from "react";
import { Card, CardTitle, PageHeader, Pill, StageBadge } from "@/components/poultrix/ui";
import { API_URL, useAI, useHardware, stageName } from "@/lib/live-hardware";
import type { Stage } from "@/lib/demo-data";
import { getMyFarm, saveMyFarm } from "@/lib/farm-store";
import { toast } from "sonner";

export const Route = createFileRoute("/flock")({
  head: () => ({ meta: [{ title: "Flock — Poultrix" }] }),
  component: FlockPage,
});

function FlockPage() {
  const [birdCount, setBirdCount] = useState("");
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    try {
      getMyFarm().then(f => { if (f) setBirdCount(String(f.bird_count)); }).catch(console.error);
    } catch { /* storage unavailable */ }
  }, []);
  const validBirds = /^\d+$/.test(birdCount) && Number(birdCount) > 0;
  async function saveFeedingSetup() {
    if (!validBirds) return;
    try {
      const farm = await getMyFarm();
      if (!farm) throw new Error("Farm not found");
      await saveMyFarm({ name: farm.name, location: farm.location, bird_count: Number(birdCount) });
      setSaved(true);
    } catch (error) { setSaved(false); toast.error(error instanceof Error ? error.message : "Could not save bird count"); }
  }
  const { data: hardware, error: hardwareError } = useHardware();
  const { data: ai } = useAI();
  const cameraReady = hardware?.camera?.connected === true;
  const stage = stageName(hardware?.stage) as Stage | null;
  const detected = stageName(ai?.detectedStage) as Stage | null;
  const confidence = typeof ai?.confidence === "number" ? `${ai.confidence.toFixed(1)}%` : "—";
  // Stage-only midpoint estimates from Poultrix System Documentation v3.
  // The document specifies age-dependent ranges; without bird age, this is an estimate.
  const allowances: Record<Stage, { dailyGrams: number; sessions: number; range: string }> = {
    Starter: { dailyGrams: 24, sessions: 6, range: "13–35 g/bird/day" },
    Grower: { dailyGrams: 75, sessions: 4, range: "50–100 g/bird/day" },
    Finisher: { dailyGrams: 140, sessions: 4, range: "120–160 g/bird/day" },
  };
  const allowance = stage ? allowances[stage] : null;
  // The confirmed Arduino stage is the only source of the feeding allowance.
  // Changing bird count scales the flock target, never the per-bird requirement.
  const dailyFlockGrams = validBirds && allowance ? Number(birdCount) * allowance.dailyGrams : null;
  const totalGrams = dailyFlockGrams !== null && allowance ? dailyFlockGrams / allowance.sessions : null;

  return (
    <>
      <PageHeader
        title="Flock"
        subtitle="Live monitoring of your broiler flock"
        right={<Pill tone={hardwareError ? "warn" : hardware ? "ok" : "neutral"}>
          {hardwareError ? "API offline" : hardware ? "Connected" : "Connecting"}
        </Pill>}
      />
      <div className="grid gap-5 lg:grid-cols-2">
        <Card className="overflow-hidden p-0">
          <div className="relative aspect-video bg-black">
            {cameraReady ? (
              <img
                src={`${API_URL}/api/camera/stream`}
                alt="Live flock preview from Raspberry Pi Camera V3"
                className="h-full w-full object-contain"
              />
            ) : (
              <div className="flex h-full items-center justify-center text-sm text-white/80">
                Waiting for camera
              </div>
            )}
            <div className="absolute left-3 top-3 flex items-center gap-2 rounded-full bg-card/90 px-3 py-1 text-xs font-semibold">
              <Camera className="h-4 w-4" />
              {cameraReady ? "Live flock camera" : "Camera offline"}
            </div>
          </div>
          <p className="p-4 text-xs text-muted-foreground">
            Raspberry Pi Camera V3 · live preview
          </p>
        </Card>
        <Card>
          <CardTitle>Batch overview</CardTitle>
          <div className="grid grid-cols-2 gap-4">
            {[
              ["Birds", validBirds ? birdCount : "—"],
              ["AI confidence", confidence],
              ["Connection", hardware?.connected ? "Online" : "—"],
              ["Last checked", ai?.lastInference ? new Date(ai.lastInference).toLocaleString() : "—"],
            ].map(([label, value]) => (
              <div key={label} className="rounded-xl bg-surface p-4">
                <div className="text-xs text-muted-foreground">{label}</div>
                <div className="mt-1 break-words text-xl font-bold">{value}</div>
              </div>
            ))}
          </div>
          <div className="mt-5 flex items-center gap-3">
            <span className="text-sm text-muted-foreground">Confirmed stage</span>
            {stage ? <StageBadge stage={stage} /> : <span>—</span>}
          </div>
          <div className="mt-3 flex items-center gap-3">
            <span className="text-sm text-muted-foreground">Latest AI detection</span>
            {detected ? <StageBadge stage={detected} /> : <span>—</span>}
          </div>
          <p className="mt-4 text-xs text-muted-foreground">
            Bird count is editable below. Batch dates will appear when real batch records are connected.
          </p>
        </Card>
      </div>
      <Card className="mt-5">
        <CardTitle>Feeding setup</CardTitle>
        <p className="mb-4 text-sm text-muted-foreground">Enter the flock size. The feed allowance is estimated automatically from the confirmed growth stage.</p>
        <label className="block text-sm font-medium">Number of birds
          <input type="number" min="1" step="1" value={birdCount} onChange={(e) => { setBirdCount(e.target.value); setSaved(false); }} placeholder="e.g. 10" className="mt-2 w-full rounded-lg border bg-background px-3 py-2" />
        </label>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <div className="rounded-xl bg-surface p-4">
            <p className="text-sm text-muted-foreground">Confirmed stage allowance</p>
            <p className="mt-1 text-xl font-bold">{allowance ? `${allowance.dailyGrams} g/bird/day` : "—"}</p>
            <p className="mt-1 text-xs text-muted-foreground">{allowance?.range ?? "Waiting for confirmed stage"} · midpoint estimate</p>
          </div>
          <div className="rounded-xl bg-surface p-4">
            <p className="text-sm text-muted-foreground">Feeding sessions per day</p>
            <p className="mt-1 text-xl font-bold">{allowance?.sessions ?? "—"}</p>
          </div>
        </div>
        <div className="mt-4 rounded-xl bg-surface p-4">
          <p className="text-sm text-muted-foreground">Estimated feed target per session · confirmed {stage ?? "stage unavailable"}</p>
          <p className="mt-1 text-2xl font-bold">{totalGrams === null ? "—" : `${totalGrams.toLocaleString(undefined, {maximumFractionDigits: 1})} g`}</p>
          {allowance && validBirds && (
            <p className="mt-2 text-xs text-muted-foreground">
              {Number(birdCount).toLocaleString()} birds × {allowance.dailyGrams} g/bird/day ÷ {allowance.sessions} sessions/day
              {dailyFlockGrams !== null ? ` · ${dailyFlockGrams.toLocaleString()} g/day for the flock` : ""}
            </p>
          )}
          {!stage && <p className="mt-2 text-xs text-muted-foreground">Waiting for the confirmed stage from Arduino. AI detections do not change the feed allowance until the stage is confirmed.</p>}
        </div>
        <button type="button" onClick={saveFeedingSetup} disabled={!validBirds} className="mt-4 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-50">Save bird count</button>
        {saved && <p className="mt-2 text-sm text-muted-foreground">Bird count saved in this browser.</p>}
        <p className="mt-3 text-xs text-muted-foreground">The feeding ranges are from Poultrix System Documentation v3, not an independently verified feed-manufacturer chart. The documentation varies feed by age within each stage; this stage-only midpoint is an estimate, not a precise ration. The count is stored only in this browser and does not yet control the feeder. Raspberry Pi integration, load-cell verification, and safety limits are required before automatic dispensing.</p>
      </Card>
      <Card className="mt-5">
        <CardTitle>Batch timeline</CardTitle>
        <p className="text-sm text-muted-foreground">
          No recorded stage-transition history is available from the current API.
        </p>
      </Card>
    </>
  );
}
