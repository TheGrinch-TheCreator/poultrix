import { createFileRoute } from "@tanstack/react-router";
import { Hand } from "lucide-react";
import { STAGES, farm } from "@/lib/demo-data";
import { PageHeader, StageBadge, stageBar } from "@/components/poultrix/ui";

export const Route = createFileRoute("/cycle")({
  head: () => ({
    meta: [
      { title: "Growth Cycle — POULTRIX" },
      { name: "description", content: "The 35-day broiler cycle: Starter, Grower and Finisher feed, temperature and lighting targets." },
      { property: "og:title", content: "Growth Cycle — POULTRIX" },
      { property: "og:description", content: "The 35-day broiler cycle: Starter, Grower and Finisher feed, temperature and lighting targets." },
    ],
  }),
  component: CyclePage,
});

function CyclePage() {
  return (
    <>
      <PageHeader title="Growth Cycle" subtitle="The AI decides the stage from the camera. Days are only a rough guide." />
      <div className="card-surface mb-5 p-5">
        <div className="relative flex h-10 overflow-hidden rounded-full">
          {STAGES.map((s) => (
            <div key={s.name} className={`${stageBar[s.name]} flex items-center justify-center text-xs font-bold text-primary-foreground`} style={{ flex: s.days[1] - s.days[0] + 1 }}>{s.name}</div>
          ))}
          
        </div>
        <div className="mt-2 flex justify-between text-xs text-muted-foreground"><span>Starter</span><span>Now: {farm.stage} (AI detected)</span><span>Finisher</span></div>
      </div>

      <div className="grid gap-5 md:grid-cols-3">
        {STAGES.map((s) => {
          const current = s.name === farm.stage;
          return (
            <div key={s.name} className={`card-surface p-5 ${current ? "ring-2 ring-primary" : ""}`}>
              <div className="flex items-center justify-between"><StageBadge stage={s.name} size="lg" />{current && <span className="text-xs font-bold text-primary">NOW</span>}</div>
              <div className="num mt-3 text-2xl font-bold"><span className="text-sm font-medium text-muted-foreground">Usually about day {s.days[0]}–{s.days[1]}</span></div>
              <dl className="mt-4 space-y-2 text-sm">
                <div><dt className="text-xs text-muted-foreground">Feed</dt><dd className="font-semibold">{s.feed}</dd></div>
                <div><dt className="text-xs text-muted-foreground">Amount</dt><dd>{s.feedRange}</dd></div>
                <div><dt className="text-xs text-muted-foreground">Temperature</dt><dd>{s.tempNote}</dd></div>
                <div><dt className="text-xs text-muted-foreground">Light</dt><dd>{s.light}</dd></div>
              </dl>
            </div>
          );
        })}
      </div>

      <div className="mt-5 flex items-start gap-3 rounded-xl border-2 border-dashed border-warn/50 bg-warn-soft p-5">
        <Hand className="mt-0.5 h-5 w-5 shrink-0 text-warn" />
        <div>
          <div className="text-xs font-bold uppercase tracking-wider text-warn">When AI detects Finisher · Action required</div>
          <p className="font-semibold">Change Compartment 1 from Starter Crumble to Finisher Pellet.</p>
        </div>
      </div>
    </>
  );
}
