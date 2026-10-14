import { createFileRoute } from "@tanstack/react-router";
import { Check } from "lucide-react";
import { farm, feed, feedHistory, feedingEvents, stageInfo } from "@/lib/demo-data";
import { Card, CardTitle, DemoTag, Meter, PageHeader, Pill, StageBadge } from "@/components/poultrix/ui";
import { DeclarationForm, FeedHoldAlert, FeedSchedulePanel, FeedStockPanel, LeftoverNotice, MaeCard } from "@/components/poultrix/v3";
import { FeedBars } from "@/components/poultrix/charts";

export const Route = createFileRoute("/feeding")({
  head: () => ({
    meta: [
      { title: "Feeding — POULTRIX" },
      { name: "description", content: "Stage-based feed dispensing, compartment levels, trough weight and feeding accuracy." },
      { property: "og:title", content: "Feeding — POULTRIX" },
      { property: "og:description", content: "Stage-based feed dispensing, compartment levels, trough weight and feeding accuracy." },
    ],
  }),
  component: FeedingPage,
});

const STEPS = ["Growth stage", "Feed type", "Target amount", "Gates open", "Weighing", "Target reached", "Complete"];

function FeedingPage() {
  const st = stageInfo(farm.stage);
  return (
    <>
      <PageHeader title="Feeding" subtitle="POULTRIX picks the feed and amount from the AI growth stage." right={<DemoTag />} />
      <div className="mb-5 space-y-3"><FeedHoldAlert /><LeftoverNotice /></div>
      <div className="mb-5 grid gap-5 lg:grid-cols-3">
        <FeedSchedulePanel />
        <FeedStockPanel />
        <MaeCard />
      </div>
      <div className="mb-5"><DeclarationForm /></div>
      <div className="grid gap-5 lg:grid-cols-3">
        <Card>
          <CardTitle>Last feeding session</CardTitle>
          <div className="num text-5xl font-extrabold">{feed.dispensed}g</div>
          <p className="text-muted-foreground">of {feed.targetPerFeeding}g target · {feed.accuracy}% accurate</p>
          <div className="mt-3"><Meter value={(feed.dispensed / feed.targetPerFeeding) * 100} /></div>
          <dl className="mt-5 space-y-2 text-sm">
            <Row k="Recommended feed" v={st.feed} />
            <Row k="Daily guide" v={st.feedRange} />
            <Row k="Feed in trough now" v={`${feed.trough} g`} />
            <Row k="Status" v={feed.status} />
            <Row k="Next feeding" v={feed.nextFeeding} />
          </dl>
        </Card>

        <Card className="lg:col-span-2">
          <CardTitle>How the last feeding went</CardTitle>
          <ol className="grid gap-2 sm:grid-cols-7">
            {STEPS.map((s, i) => (
              <li key={s} className="flex items-center gap-2 sm:flex-col sm:text-center">
                <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-ok text-primary-foreground"><Check className="h-4 w-4" /></span>
                <span className="text-xs font-medium">{i + 1}. {s}</span>
              </li>
            ))}
          </ol>
          <div className="mt-6 hidden gap-3 sm:grid-cols-2">
            {feed.compartments.map((c) => {
              const pct = (c.kg / c.capacity) * 100;
              const tone = pct < 25 ? "danger" : pct < 50 ? "warn" : "ok";
              return (
                <div key={c.id} className="rounded-xl border bg-surface p-4">
                  <div className="flex items-center justify-between">
                    <span className="font-semibold">Compartment {c.id}</span>
                    <Pill tone={tone}>{tone === "ok" ? "Good" : tone === "warn" ? "Getting low" : "Refill now"}</Pill>
                  </div>
                  <div className="mt-1 text-sm text-muted-foreground">{c.contents}</div>
                  <div className="num mt-2 text-3xl font-bold">{c.kg} kg <span className="text-sm text-muted-foreground">/ {c.capacity} kg</span></div>
                  <div className="mt-2"><Meter value={pct} tone={tone} /></div>
                  <p className="mt-2 text-xs text-muted-foreground">{c.note}</p>
                </div>
              );
            })}
          </div>
        </Card>
      </div>

      <Card className="mt-5">
        <CardTitle>Daily feed: target vs dispensed (whole flock)</CardTitle>
        <FeedBars data={feedHistory} />
      </Card>

      <Card className="mt-5 overflow-x-auto">
        <CardTitle>Recent feedings</CardTitle>
        <table className="w-full min-w-[680px] text-sm">
          <thead className="text-left text-xs uppercase tracking-wider text-muted-foreground">
            <tr><th className="pb-2">Time</th><th>Stage</th><th>Compartments</th><th>Target</th><th>Dispensed</th><th>MAE</th><th>Leftover / reduced</th></tr>
          </thead>
          <tbody>
            {feedingEvents.map((e) => (
              <tr key={e.time} className="border-t">
                <td className="py-3">{e.time}</td><td><StageBadge stage={e.stage} /></td><td>{e.comps}</td><td>{e.target}g</td><td className="font-semibold">{e.actual}g</td>
                <td>±{Math.abs(e.actual - e.target)}g</td><td><Pill tone={e.leftover === "No" ? "neutral" : "info"}>{e.leftover}</Pill></td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return <div className="flex justify-between gap-3 border-b pb-2 last:border-0"><dt className="text-muted-foreground">{k}</dt><dd className="text-right font-medium">{v}</dd></div>;
}
