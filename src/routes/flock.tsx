import { FeedingPlanner } from "@/components/poultrix/FeedingPlanner";
import { createFileRoute } from "@tanstack/react-router";
import { Camera } from "lucide-react";
import { FlockWebRTCPreview } from "@/components/poultrix/FlockWebRTCPreview";
import { useEffect, useState } from "react";
import { Card, CardTitle, PageHeader, Pill, StageBadge } from "@/components/poultrix/ui";
import { API_URL, useAI, useHardware, stageName } from "@/lib/live-hardware";
import type { Stage } from "@/lib/demo-data";
import { getMyFarm } from "@/lib/farm-store";
import { toast } from "sonner";

export const Route = createFileRoute("/flock")({
  head: () => ({ meta: [{ title: "Flock — Poultrix" }] }),
  component: FlockPage,
});

function FlockPage() {
  const [birdCount, setBirdCount] = useState<number | null>(null);
  useEffect(() => {
    let active = true;
    const refresh = async () => {
      try {
        const response = await fetch(`${API_URL}/api/feeding/config`, { cache: "no-store" });
        if (!response.ok) throw new Error("Feeding configuration unavailable");
        const config = await response.json();
        const count = Number(config.birdCount);
        if (active && Number.isInteger(count) && count > 0) setBirdCount(count);
      } catch {
        try {
          const farm = await getMyFarm();
          if (active && farm) setBirdCount(farm.bird_count);
        } catch { /* retain last confirmed value */ }
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 5000);
    window.addEventListener("poultrix:feeding-updated", refresh);
    return () => { active = false; clearInterval(timer); window.removeEventListener("poultrix:feeding-updated", refresh); };
  }, []);
  const validBirds = birdCount !== null && Number.isInteger(birdCount) && birdCount > 0;
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
  const dailyFlockGrams = validBirds && allowance ? birdCount! * allowance.dailyGrams : null;
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
            <FlockWebRTCPreview />
            <div className="absolute left-3 top-3 flex items-center gap-2 rounded-full bg-card/90 px-3 py-1 text-xs font-semibold">
              <Camera className="h-4 w-4" />
              {cameraReady ? "Live flock camera" : "Camera offline"}
            </div>
          </div>
          <p className="p-4 text-xs text-muted-foreground">
            Raspberry Pi Camera V3 · WebRTC local preview (SSH tunnel required)
          </p>
        </Card>
        <Card>
          <CardTitle>Batch overview</CardTitle>
          <div className="grid grid-cols-2 gap-4">
            {[
              ["Birds", validBirds ? String(birdCount) : "—"],
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
      <FeedingPlanner editable />
      <Card className="mt-5">
        <CardTitle>Batch timeline</CardTitle>
        <p className="text-sm text-muted-foreground">
          No recorded stage-transition history is available from the current API.
        </p>
      </Card>
    </>
  );
}
