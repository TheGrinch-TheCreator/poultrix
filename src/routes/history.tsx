import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { alerts, envHistory, feedHistory } from "@/lib/demo-data";
import { Card, CardTitle, DemoTag, PageHeader } from "@/components/poultrix/ui";
import { FeedBars, MultiLine, TrendChart } from "@/components/poultrix/charts";

export const Route = createFileRoute("/history")({
  head: () => ({
    meta: [
      { title: "History & Reports — POULTRIX" },
      { name: "description", content: "Review temperature, humidity, light, feeding and alert history for the current cycle." },
      { property: "og:title", content: "History & Reports — POULTRIX" },
      { property: "og:description", content: "Review temperature, humidity, light, feeding and alert history for the current cycle." },
    ],
  }),
  component: HistoryPage,
});

const RANGES = ["Today", "Last 7 days", "Current cycle", "Custom"] as const;

function HistoryPage() {
  const [r, setR] = useState<(typeof RANGES)[number]>("Today");
  return (
    <>
      <PageHeader title="History & Reports" subtitle="Look back at how the house and flock have been doing." right={<DemoTag />} />
      <div className="mb-5 flex gap-2 overflow-x-auto">
        {RANGES.map((x) => (
          <button key={x} onClick={() => setR(x)} className={`shrink-0 rounded-full border px-4 py-2 text-sm font-semibold ${r === x ? "border-primary bg-primary text-primary-foreground" : "bg-card"}`}>{x}</button>
        ))}
      </div>
      <div className="grid gap-5 lg:grid-cols-2">
        <Card><CardTitle>Temperature & humidity</CardTitle><MultiLine data={envHistory} /></Card>
        <Card><CardTitle>Light level</CardTitle><TrendChart data={envHistory} dataKey="light" color="var(--chart-3)" unit="" height={260} /></Card>
        <Card className="lg:col-span-2"><CardTitle>Feed consumption & accuracy</CardTitle><FeedBars data={feedHistory} /></Card>
      </div>
      <Card className="mt-5">
        <CardTitle>Event log</CardTitle>
        <ul className="divide-y text-sm">
          {alerts.map((a) => (
            <li key={a.id} className="flex justify-between gap-3 py-3"><span>{a.title}</span><span className="shrink-0 text-muted-foreground">{a.time}</span></li>
          ))}
        </ul>
      </Card>
    </>
  );
}
