import { createFileRoute } from "@tanstack/react-router";
import { farm, stageInfo, stageTransitions } from "@/lib/demo-data";
import { Card, CardTitle, DemoTag, Meter, PageHeader, StageBadge } from "@/components/poultrix/ui";
import flockImg from "@/assets/flock-camera.jpg";

export const Route = createFileRoute("/flock")({
  head: () => ({
    meta: [
      { title: "Flock — POULTRIX" },
      { name: "description", content: "Your current broiler batch: bird count, cycle day, growth stage and batch progress." },
      { property: "og:title", content: "Flock — POULTRIX" },
      { property: "og:description", content: "Your current broiler batch: bird count, cycle day, growth stage and batch progress." },
    ],
  }),
  component: FlockPage,
});

function FlockPage() {
  const st = stageInfo(farm.stage);
  return (
    <>
      <PageHeader title="Flock" subtitle={farm.batch} right={<DemoTag />} />
      <div className="grid gap-5 lg:grid-cols-2">
        <Card className="overflow-hidden p-0">
          <img src={flockImg} alt="Current flock" className="aspect-video w-full object-cover" loading="lazy" width={1280} height={720} />
        </Card>
        <Card>
          <CardTitle>Batch overview</CardTitle>
          <div className="grid grid-cols-2 gap-4">
            {[["Birds", farm.birds], ["AI confidence", `${Math.round(farm.confidence * 100)}%`], ["Batch status", "Active"], ["Last checked", farm.lastClassified]].map(([k, v]) => (
              <div key={String(k)} className="rounded-xl bg-surface p-4"><div className="text-xs text-muted-foreground">{k}</div><div className="num text-3xl font-bold">{v}</div></div>
            ))}
          </div>
          <div className="mt-5 flex items-center gap-3"><span className="text-sm text-muted-foreground">Stage</span><StageBadge stage={farm.stage} /></div>
          
        </Card>
      </div>
      <Card className="mt-5">
        <CardTitle>Batch timeline</CardTitle>
        <ul className="space-y-3 text-sm">
          {stageTransitions.map((t) => <li key={t.when} className="flex gap-3"><b className="w-14 shrink-0">{t.when}</b><StageBadge stage={t.stage} /><span className="text-muted-foreground">{t.note}</span></li>)}
          <li className="flex gap-3 opacity-60"><b className="w-14 shrink-0">Next</b><StageBadge stage="Finisher" /><span>Expected when AI detects it · change Compartment 1 feed</span></li>
        </ul>
      </Card>
    </>
  );
}
