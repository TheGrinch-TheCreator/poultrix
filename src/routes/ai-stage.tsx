import { createFileRoute } from "@tanstack/react-router";
import { Camera } from "lucide-react";
import { classifications, farm, stageTransitions } from "@/lib/demo-data";
import { Card, CardTitle, DemoTag, Dot, PageHeader, StageBadge } from "@/components/poultrix/ui";
import { ClassificationStatus, DemoControls, TransitionIndicator } from "@/components/poultrix/v3";
import flockImg from "@/assets/flock-camera.jpg";

export const Route = createFileRoute("/ai-stage")({
  head: () => ({
    meta: [
      { title: "AI Growth Stage — POULTRIX" },
      { name: "description", content: "Camera view and AI classification of the flock as Starter, Grower or Finisher." },
      { property: "og:title", content: "AI Growth Stage — POULTRIX" },
      { property: "og:description", content: "Camera view and AI classification of the flock as Starter, Grower or Finisher." },
    ],
  }),
  component: AIPage,
});

function AIPage() {
  return (
    <>
      <PageHeader title="AI Growth Stage" subtitle="The camera watches the flock and decides which stage they are in." right={<DemoTag />} />
      <div className="mb-5 space-y-3"><TransitionIndicator /><DemoControls /></div>
      <div className="grid gap-5 lg:grid-cols-5">
        <Card className="overflow-hidden p-0 lg:col-span-3">
          <div className="relative">
            <img src={flockImg} alt="Camera view of broiler flock" className="aspect-video w-full object-cover" width={1280} height={720} />
            <div className="absolute left-3 top-3 flex items-center gap-2 rounded-full bg-card/90 px-3 py-1 text-xs font-semibold">
              <Dot tone="danger" pulse /> <Camera className="h-3.5 w-3.5" /> Camera · live preview
            </div>
          </div>
          <div className="p-5">
            <ClassificationStatus />
            <p className="mt-2 text-xs text-muted-foreground">A stage change needs 3 matching checks in a row. Only forward changes count; checks under 60% confidence are skipped.</p>
          </div>
        </Card>
        <Card className="lg:col-span-2">
          <CardTitle>Current result</CardTitle>
          <p className="text-lg">POULTRIX currently identifies the flock as</p>
          <div className="my-3"><StageBadge stage={farm.stage} size="lg" /></div>
          <div className="num text-5xl font-extrabold">{Math.round(farm.confidence * 100)}%</div>
          <p className="text-sm text-muted-foreground">confidence · last checked {farm.lastClassified}</p>
          <h3 className="mt-6 text-sm font-semibold text-muted-foreground">Stage changes</h3>
          <ul className="mt-2 space-y-3">
            {stageTransitions.map((t) => (
              <li key={t.when} className="flex gap-3 text-sm"><span className="num w-12 shrink-0 font-bold">{t.when}</span><span><StageBadge stage={t.stage} /> <span className="text-muted-foreground">{t.note}</span></span></li>
            ))}
          </ul>
        </Card>
      </div>

      <Card className="mt-5 overflow-x-auto">
        <CardTitle>Recent checks</CardTitle>
        <table className="w-full min-w-[420px] text-sm">
          <thead className="text-left text-xs uppercase tracking-wider text-muted-foreground"><tr><th className="pb-2">Time</th><th>Result</th><th>Confidence</th><th>Status</th><th>Counter</th></tr></thead>
          <tbody>
            {classifications.map((c) => (
              <tr key={c.time} className="border-t"><td className="py-3">{c.time}</td><td>{c.stage ? <StageBadge stage={c.stage} /> : "—"}</td><td className="font-semibold">{c.confidence ? `${Math.round(c.confidence * 100)}%` : "—"}</td><td>{c.result}</td><td>{c.counter}/3</td></tr>
            ))}
          </tbody>
        </table>
      </Card>

      <details className="card-surface mt-5 p-5">
        <summary className="cursor-pointer font-semibold">Technical details</summary>
        <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
          {[["Model", "YOLOv8s-cls (small, classification)"], ["Classes", "Starter, Grower, Finisher"], ["Dataset", "1,178 self-collected images (Roboflow)"], ["Method", "Whole-frame classification"], ["Decision", "3 consecutive matching checks (~15 min)"], ["Schedule", "Every 5 min · 30 s before feeding · paused at night"], ["Runs on", "Raspberry Pi 5"]].map(([k, v]) => (
            <div key={k} className="rounded-lg bg-surface p-3"><dt className="text-xs text-muted-foreground">{k}</dt><dd className="font-medium">{v}</dd></div>
          ))}
        </dl>
      </details>
    </>
  );
}
