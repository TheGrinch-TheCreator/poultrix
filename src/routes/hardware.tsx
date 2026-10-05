import { createFileRoute } from "@tanstack/react-router";
import { ArrowRight } from "lucide-react";
import { hardware } from "@/lib/demo-data";
import { Card, CardTitle, DemoTag, Dot, PageHeader, healthTone } from "@/components/poultrix/ui";

export const Route = createFileRoute("/hardware")({
  head: () => ({
    meta: [
      { title: "System Status — POULTRIX" },
      { name: "description", content: "Health of the Raspberry Pi, Arduino, sensors, feed gates, relays, camera and connection." },
      { property: "og:title", content: "System Status — POULTRIX" },
      { property: "og:description", content: "Health of the Raspberry Pi, Arduino, sensors, feed gates, relays, camera and connection." },
    ],
  }),
  component: HardwarePage,
});

const FLOW = ["Camera", "Raspberry Pi 5", "Arduino Mega", "Sensors · Gates · Relays", "Poultry house", "Web app"];

function HardwarePage() {
  return (
    <>
      <PageHeader title="System Status" subtitle="Every part of POULTRIX, in plain words." right={<DemoTag />} />
      <Card className="mb-5">
        <CardTitle>How data flows</CardTitle>
        <div className="flex flex-wrap items-center gap-2">
          {FLOW.map((f, i) => (
            <div key={f} className="flex items-center gap-2">
              <span className="rounded-lg border bg-surface px-3 py-2 text-sm font-semibold">{f}</span>
              {i < FLOW.length - 1 && <ArrowRight className="h-4 w-4 text-muted-foreground" />}
            </div>
          ))}
        </div>
        <p className="mt-3 text-xs text-muted-foreground">Feeding and climate control run on-site and keep working even if the internet drops.</p>
      </Card>
      <div className="grid gap-5 lg:grid-cols-2">
        {hardware.map((g) => (
          <Card key={g.group}>
            <CardTitle>{g.group}</CardTitle>
            <ul className="divide-y">
              {g.items.map((h) => (
                <li key={h.name} className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 py-3">
                  <Dot tone={healthTone(h.status)} />
                  <div className="min-w-0">
                    <div className="truncate font-semibold">{h.plain}</div>
                    <div className="truncate text-xs text-muted-foreground">{h.name} · {h.detail}</div>
                  </div>
                  <span className="text-xs text-muted-foreground">{h.last}</span>
                </li>
              ))}
            </ul>
          </Card>
        ))}
      </div>
    </>
  );
}
