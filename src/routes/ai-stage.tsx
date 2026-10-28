import { STAGE_REQUIREMENTS } from "@/lib/stage-requirements";
import { createFileRoute } from "@tanstack/react-router";
import { Camera } from "lucide-react";
import { Card, CardTitle, Dot, PageHeader, Pill, StageBadge } from "@/components/poultrix/ui";
import { API_URL, useAI, useHardware, stageName } from "@/lib/live-hardware";
export const Route=createFileRoute("/ai-stage")({component:AIPage});
function AIPage(){const {data:ai,error,busy,classify}=useAI();const {data:hw}=useHardware();const sim=(ai as any)?.simulation;const detected=sim?.active?(sim.stage==="NO_CHICKEN"?null:stageName(sim.stage)):stageName(ai?.detectedStage);const confirmed=stageName(hw?.stage);const camera=!!hw?.camera?.connected;return <><PageHeader title="AI Growth Stage" subtitle="Real-time flock classification from Raspberry Pi 5" right={<Pill tone={error?"warn":ai?"ok":"neutral"}>{error?"API offline":ai?"Connected":"Waiting for AI"}</Pill>}/>
<div className="grid gap-5 lg:grid-cols-5"><Card className="overflow-hidden p-0 lg:col-span-3"><div className="relative aspect-video bg-black">{camera?<img src={`${API_URL}/api/camera/stream`} alt="Live Raspberry Pi camera" className="h-full w-full object-contain"/>:<div className="flex h-full items-center justify-center text-sm text-white">Waiting for camera</div>}<div className="absolute left-3 top-3 flex items-center gap-2 rounded-full bg-card/90 px-3 py-1 text-xs font-semibold"><Dot tone={camera?"ok":"danger"} pulse={camera}/><Camera className="h-3.5 w-3.5"/>{camera?"Camera · live":"Camera · offline"}</div></div><div className="p-5"><p className="font-semibold">AI status: {sim?.active ? (sim.stage==="NO_CHICKEN"?"No Chicken Detected · SIMULATED":`SIMULATED ${sim.stage} · ${sim.framesAnalyzed}/30`) : (ai?.status||"Waiting for classification")}</p><p className="mt-2 text-xs text-muted-foreground">Growth-stage transitions are controlled by the Raspberry Pi backend, including consecutive confirmation and required feed-refill acknowledgement.</p><button disabled={busy||!!error} onClick={()=>void classify()} className="mt-4 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-50">{busy?"Analyzing…":"Analyze now"}</button>{error&&<p className="mt-2 text-sm text-danger">{error}</p>}</div></Card>
<Card className="lg:col-span-2"><CardTitle>Current result</CardTitle><p className="text-lg">{sim?.active?"Effective simulated stage":"Most recent detected stage"}</p><div className="my-3">{detected?<StageBadge stage={detected} size="lg"/>:<span className="text-muted-foreground">{sim?.stage==="NO_CHICKEN"?"No Chicken Detected (SIMULATED)":"Waiting for classification"}</span>}</div><div className="num text-5xl font-extrabold">{typeof (sim?.active?sim.confidence:ai?.confidence)==="number"?`${(sim?.active?sim.confidence:ai?.confidence).toFixed(1)}%`:"—"}</div><p className="text-sm text-muted-foreground">{sim?.active?"Simulated confidence":"Real AI confidence"} · last checked {ai?.lastInference?new Date(ai.lastInference).toLocaleString():"—"}</p><h3 className="mt-6 text-sm font-semibold text-muted-foreground">Confirmed hardware stage</h3><div className="mt-2">{confirmed?<StageBadge stage={confirmed}/>:"—"}</div><h3 className="mt-6 text-sm font-semibold text-muted-foreground">Stage changes</h3><p className="mt-2 text-sm text-muted-foreground">No persisted transition history available from this API yet.</p></Card></div>
<Card className="mt-5"><CardTitle>Fixed AI-stage requirements · Philippine reference</CardTitle>
  <p className="mb-4 text-sm text-muted-foreground">Stage is selected by AI classification, not by flock day count. Age ranges are reference labels only. The fixed temperature bands are engineering approximations; Finisher has no source-defined numerical temperature target. These cards do not themselves change Arduino controls.</p>
  <div className="grid gap-3 md:grid-cols-3">{(Object.entries(STAGE_REQUIREMENTS) as [keyof typeof STAGE_REQUIREMENTS, typeof STAGE_REQUIREMENTS[keyof typeof STAGE_REQUIREMENTS]][]).map(([name,req])=><div key={name} className={`rounded-xl border p-4 ${confirmed===name?'border-primary':'border-border'}`}><p className="font-semibold">{name}{confirmed===name?' · Confirmed':''}</p><p className="text-xs text-muted-foreground">Reference days {req.referenceDays}</p><p className="mt-2 text-sm">Temperature: {req.temperature}</p><p className="mt-1 text-sm">Lighting: {req.lighting}</p><p className="mt-1 text-sm">Planned feeding: {req.feedings} sessions/day</p><p className="mt-2 text-xs text-muted-foreground">{req.note}</p></div>)}</div>
  <p className="mt-3 text-xs text-muted-foreground">Feeding session counts are planning targets, not proof that automatic feeding is enabled. Existing calibration and live API readings are preserved.</p>
</Card>
<Card className="mt-5">
  <CardTitle>30-second vote result</CardTitle>
  <p className="mb-5 text-sm text-muted-foreground">Votes from the most recently completed analysis cycle.</p>
  {(() => {
    const record = ai as (typeof ai & { lastCycle?: { votes?: Record<string, number>; voteCounts?: Record<string, number> }; voteCounts?: Record<string, number>; transitionMode?: string; automaticControlEnabled?: boolean }) | null;
    const votes = sim?.active ? sim.votes : record?.lastCycle?.votes ?? record?.lastCycle?.voteCounts ?? record?.voteCounts ?? ai?.votes;
    const names = ["Starter", "Grower", "Finisher"] as const;
    const counts = names.map(name => {
      const raw = votes?.[name] ?? votes?.[name.toUpperCase()] ?? votes?.[name.toLowerCase()];
      return typeof raw === "number" && Number.isFinite(raw) && raw >= 0 ? raw : 0;
    });
    const total = counts.reduce((sum, value) => sum + value, 0);
    return total > 0 ? (
      <div className="space-y-4">
        {names.map((name, index) => (
          <div key={name}>
            <div className="mb-2 flex justify-between text-sm font-medium"><span>{name}</span><span className="tabular-nums">{counts[index]}</span></div>
            <div className="h-2.5 overflow-hidden rounded-full bg-muted">
              <div className="h-full rounded-full bg-emerald-700 transition-all duration-300" style={{ width: `${(counts[index] / total) * 100}%` }} />
            </div>
          </div>
        ))}
        <p className="text-xs text-muted-foreground">{total} votes in the latest reported cycle.</p>
      </div>
    ) : <p className="rounded-lg bg-surface p-4 text-sm text-muted-foreground">Waiting for completed analysis cycle. The backend must provide vote counts to display this chart.</p>;
  })()}
  <div className="mt-6 rounded-2xl border p-5">
    <h3 className="font-semibold">AI transition status</h3>
    <p className="mt-2 text-sm text-muted-foreground">
      The confirmed growth stage is <strong>{confirmed ?? "unavailable"}</strong>. Classification alone does not prove that a new stage was sent to Arduino. Automatic transition status will be shown when confirmed by the backend.
    </p>
  </div>
</Card>
<Card className="mt-5 overflow-x-auto"><CardTitle>Recent checks</CardTitle><p className="text-sm text-muted-foreground">No recorded classification history available yet. Latest result is shown above.</p></Card>
<details className="card-surface mt-5 p-5"><summary className="cursor-pointer font-semibold">Technical details</summary><dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2">{[["Model","YOLOv8s-cls"],["Classes","Starter, Grower, Finisher"],["Method","30-second majority vote"],["Transition","3 consecutive valid confirmations"],["Runs on","Raspberry Pi 5"]].map(([k,v])=><div key={k} className="rounded-lg bg-surface p-3"><dt className="text-xs text-muted-foreground">{k}</dt><dd className="font-medium">{v}</dd></div>)}</dl></details></>}
