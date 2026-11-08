import { STAGE_REQUIREMENTS } from "@/lib/stage-requirements";
import { createFileRoute } from "@tanstack/react-router";
import { Camera } from "lucide-react";
import { Card, CardTitle, Dot, PageHeader, Pill, StageBadge } from "@/components/poultrix/ui";
import { agreeingDetection, sameStage, useAI, useHardware, stageName } from "@/lib/live-hardware";
import { useCameraStreamUrl } from "@/lib/live-endpoints";
export const Route=createFileRoute("/ai-stage")({component:AIPage});
function AIPage(){const {data:ai,error,busy,classify}=useAI();const {data:hw}=useHardware();const agreeing=agreeingDetection(ai,hw?.stage);const detected=agreeing?.stage??null;const shownConfidence=agreeing?.confidence;const confirmed=stageName(hw?.stage);const camera=!!hw?.camera?.connected;const streamUrl=useCameraStreamUrl(camera);return <><PageHeader title="AI Growth Stage" subtitle="Camera classification and daily stage checks" right={<Pill tone={error?"warn":ai?"ok":"neutral"}>{error?"API offline":ai?"Connected":"Waiting for AI"}</Pill>}/>
<div className="grid gap-5 lg:grid-cols-5"><Card className="overflow-hidden p-0 lg:col-span-3"><div className="relative aspect-video bg-black">{camera&&streamUrl?<img src={streamUrl} alt="Live Raspberry Pi camera" className="h-full w-full object-contain"/>:<div className="flex h-full items-center justify-center text-sm text-white">Waiting for camera</div>}<div className="absolute left-3 top-3 flex items-center gap-2 rounded-full bg-card/90 px-3 py-1 text-xs font-semibold"><Dot tone={camera?"ok":"danger"} pulse={camera}/><Camera className="h-3.5 w-3.5"/>{camera?"Camera · live":"Camera · offline"}</div></div><div className="p-5"><p className="font-semibold">AI status: {ai?.status||"Waiting for classification"}</p><p className="mt-2 text-xs text-muted-foreground">Stage changes happen only at the daily {ai?.schedule?.checkTime??"10:00"} check from day {ai?.schedule?.fromDay?.GROWER??"—"} (Grower) and day {ai?.schedule?.fromDay?.FINISHER??"—"} (Finisher), after 3 confident checks in a row, forward only. This button is a camera check and never changes the stage.</p><button disabled={busy||!!error} onClick={()=>void classify()} className="mt-4 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-50">{busy?"Analyzing…":"Camera check (doesn't change the stage)"}</button>{error&&<p className="mt-2 text-sm text-danger">{error}</p>}</div></Card>
<Card className="lg:col-span-2"><CardTitle>Current result</CardTitle><p className="text-lg">Most recent detected stage</p><div className="my-3">{detected?<StageBadge stage={detected} size="lg"/>:<span className="text-muted-foreground">{"—"}</span>}</div><div className="num text-5xl font-extrabold">{typeof shownConfidence==="number"?`${shownConfidence.toFixed(1)}%`:"—"}</div><p className="text-sm text-muted-foreground">Confidence · last checked {ai?.lastInference?new Date(ai.lastInference).toLocaleString():"—"}</p><h3 className="mt-6 text-sm font-semibold text-muted-foreground">Confirmed hardware stage</h3><div className="mt-2">{confirmed?<StageBadge stage={confirmed}/>:"—"}</div><h3 className="mt-6 text-sm font-semibold text-muted-foreground">Stage changes</h3><p className="mt-2 text-sm text-muted-foreground">No persisted transition history available from this API yet.</p></Card></div>
<Card className="mt-5"><CardTitle>Fixed AI-stage requirements · Philippine reference</CardTitle>
  <p className="mb-4 text-sm text-muted-foreground">The AI confirms the stage; the batch day decides when it checks and which stage it may confirm. The fixed temperature bands are engineering approximations; Finisher has no source-defined numerical temperature target. These cards do not themselves change Arduino controls.</p>
  <div className="grid gap-3 md:grid-cols-3">{(Object.entries(STAGE_REQUIREMENTS) as [keyof typeof STAGE_REQUIREMENTS, typeof STAGE_REQUIREMENTS[keyof typeof STAGE_REQUIREMENTS]][]).map(([name,req])=><div key={name} className={`rounded-xl border p-4 ${confirmed===name?'border-primary':'border-border'}`}><p className="font-semibold">{name}{confirmed===name?' · Confirmed':''}</p><p className="text-xs text-muted-foreground">From day {ai?.schedule?.fromDay?.[name.toUpperCase() as "STARTER"|"GROWER"|"FINISHER"]??"—"}</p><p className="mt-2 text-sm">Temperature: {req.temperature}</p><p className="mt-1 text-sm">Lighting: {req.lighting}</p><p className="mt-1 text-sm">Planned feeding: {req.feedings} sessions/day</p><p className="mt-2 text-xs text-muted-foreground">{req.note}</p></div>)}</div>
  <p className="mt-3 text-xs text-muted-foreground">Feeding session counts are planning targets, not proof that automatic feeding is enabled. Existing calibration and live API readings are preserved.</p>
</Card>
<Card className="mt-5">
  <CardTitle>30-second vote result</CardTitle>
  <p className="mb-5 text-sm text-muted-foreground">Votes update during the 30-second cycle.</p>
  {(() => {
    const record = ai as (typeof ai & { lastCycle?: { votes?: Record<string, number>; voteCounts?: Record<string, number> }; voteCounts?: Record<string, number>; transitionMode?: string; automaticControlEnabled?: boolean }) | null;
    const votes = record?.lastCycle?.votes ?? record?.lastCycle?.voteCounts ?? record?.voteCounts ?? ai?.votes;
    const names = ["Starter", "Grower", "Finisher"] as const;
    const counts = names.map(name => {
      const raw = votes?.[name] ?? votes?.[name.toUpperCase()] ?? votes?.[name.toLowerCase()];
      return typeof raw === "number" && Number.isFinite(raw) && raw >= 0 ? raw : 0;
    });
    const leader = names[counts.indexOf(Math.max(...counts))];
    // Option 2: only show the votes when they agree with the confirmed stage.
    const agrees = sameStage(leader, hw?.stage);
    const total = agrees ? counts.reduce((sum, value) => sum + value, 0) : 0;
    const running = agrees && Boolean(ai?.cycleRunning);
    const failed = Number(ai?.failedFrames ?? 0);
    const processed = Number(ai?.framesAnalyzed ?? 0) + failed;
    return (total > 0 || running) ? (
      <div className="space-y-4">
        {names.map((name, index) => (
          <div key={name}>
            <div className="mb-2 flex justify-between text-sm font-medium"><span>{name}</span><span className="tabular-nums">{counts[index]}</span></div>
            <div className="h-2.5 overflow-hidden rounded-full bg-muted">
              <div className="h-full rounded-full bg-emerald-700 transition-all duration-300" style={{ width: `${(counts[index] / total) * 100}%` }} />
            </div>
          </div>
        ))}
        <div className="space-y-2 rounded-lg bg-surface p-3">
          <div className="flex justify-between text-sm font-medium"><span>{running ? "Analyzing images live" : "Latest completed analysis"}</span><span className="tabular-nums">{Math.min(processed,30)}/30 images analyzed</span></div>
          <div className="h-2 overflow-hidden rounded-full bg-muted"><div className="h-full bg-emerald-700 transition-all duration-300" style={{width:`${Math.min(100,processed/30*100)}%`}} /></div>
          <p className="text-xs text-muted-foreground">{total} valid votes{failed ? ` · ${failed} failed images` : ""}{running ? " · updating every second" : ""}</p>
        </div>
      </div>
    ) : <p className="rounded-lg bg-surface p-4 text-sm text-muted-foreground">Waiting for completed analysis cycle. The backend must provide vote counts to display this chart.</p>;
  })()}
  <div className="mt-6 rounded-2xl border p-5">
    <h3 className="font-semibold">AI transition status</h3>
    <p className="mt-2 text-sm">Confirmed hardware stage: <strong>{confirmed ?? "unavailable"}</strong></p>
    {(() => {
      const result = ai?.lastTransitionResult;
      const transition = String(ai?.transitionStatus ?? "idle");
      const hardware = String(ai?.hardwareTransitionStatus ?? "idle");
      const success = result?.status === "applied";
      const failed = ["send_failed", "ack_timeout", "blocked"].includes(hardware);
      return <div className="mt-3 space-y-2 text-sm">
        <p><span className="font-semibold">Confirmation:</span> {transition === "pending" ? `Pending · ${ai?.transitionConfirmations ?? 0}/${ai?.transitionRequired ?? 3} valid cycles` : transition === "same_stage" ? "Already matches hardware stage" : transition.replaceAll("_"," ")}</p>
        <p><span className="font-semibold">Hardware transition:</span> <span className={failed ? "text-red-600" : hardware === "applied" ? "text-emerald-700" : "text-muted-foreground"}>{hardware === "applied" ? "Completed — Arduino stage acknowledged" : hardware === "sending" ? "Waiting for Arduino acknowledgment" : hardware.replaceAll("_"," ")}</span></p>
        {result && <p className={success ? "text-emerald-700" : "text-red-600"}>{success ? "✓ Last transition completed successfully" : "Last transition not completed"}: {result.from} → {result.to}{result.timestamp ? ` · ${new Date(result.timestamp).toLocaleString()}` : ""}</p>}
        {ai?.hardwareTransitionError && <p className="text-red-600">{ai.hardwareTransitionError}</p>}
        <p className="text-xs text-muted-foreground">Success is shown only after the Raspberry Pi observes the Arduino reporting the target stage. A completed 30-second vote alone is not a hardware transition.</p>
      </div>;
    })()}
  </div>
</Card>
<Card className="mt-5 overflow-x-auto"><CardTitle>Recent checks</CardTitle><p className="text-sm text-muted-foreground">No recorded classification history available yet. Latest result is shown above.</p></Card>
<details className="card-surface mt-5 p-5"><summary className="cursor-pointer font-semibold">Technical details</summary><dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2">{[["Model","YOLOv8s-cls"],["Classes","Starter, Grower, Finisher"],["Method","30-second majority vote"],["Transition","3 consecutive valid confirmations"],["Runs on","Raspberry Pi 5"]].map(([k,v])=><div key={k} className="rounded-lg bg-surface p-3"><dt className="text-xs text-muted-foreground">{k}</dt><dd className="font-medium">{v}</dd></div>)}</dl></details></>}
