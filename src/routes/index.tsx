import { createFileRoute, Link } from "@tanstack/react-router";
import { AlertTriangle, ArrowRight, Bird, Droplets, Fan, Flame, Lightbulb, ScanEye, Sun, Thermometer, Wheat, Cpu } from "lucide-react";
import { alerts, env, envHistory, envStatus, farm, feed, hardware, stageInfo, STAGES } from "@/lib/demo-data";
import { Card, CardTitle, DemoTag, Dot, Meter, Pill, StageBadge, healthTone, stageBar } from "@/components/poultrix/ui";
import { ClassificationStatus, FeedHoldAlert, FeedSchedulePanel, FeedStockPanel, TransitionIndicator } from "@/components/poultrix/v3";
import { TrendChart } from "@/components/poultrix/charts";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Dashboard — POULTRIX" },
      { name: "description", content: "At-a-glance view of your broiler house: growth stage, temperature, feeding and system health." },
      { property: "og:title", content: "Dashboard — POULTRIX" },
      { property: "og:description", content: "At-a-glance view of your broiler house: growth stage, temperature, feeding and system health." },
    ],
  }),
  component: Dashboard,
});

function Dashboard() {
  const st = stageInfo(farm.stage);
  const es = envStatus(env.temp, farm.stage);
  const activeAlerts = alerts.filter((a) => a.status === "Active");
  const allHw = hardware.flatMap((g) => g.items);
  const hwWarn = allHw.filter((i) => i.status !== "ok").length;

  return (
    <div className="space-y-5">
      {/* 1. System health / alerts */}
      <div className="grid gap-3 md:grid-cols-[1fr_auto]">
        <div className="flex items-start gap-3 rounded-xl border border-ok/30 bg-ok-soft p-4">
          <Dot tone="ok" pulse />
          <div className="-mt-1 min-w-0">
            <div className="font-display text-lg font-bold text-foreground">All systems running automatically</div>
            <p className="text-sm text-muted-foreground">
              {activeAlerts.length} things need a look · {hwWarn} device warnings · nothing critical
            </p>
          </div>
        </div>
        <Link to="/alerts" className="flex items-center justify-between gap-3 rounded-xl border bg-card px-4 py-3 text-sm font-semibold hover:bg-muted">
          <span className="flex items-center gap-2"><AlertTriangle className="h-4 w-4 text-warn" /> {activeAlerts.length} active alerts</span>
          <ArrowRight className="h-4 w-4" />
        </Link>
      </div>

      <FeedHoldAlert />
      <TransitionIndicator />

      <div className="grid gap-5 lg:grid-cols-3">
        {/* 2. Growth stage */}
        <Card className="lg:col-span-2">
          <CardTitle icon={<ScanEye className="h-4 w-4" />} right={<DemoTag />}>AI Growth Stage</CardTitle>
          <div className="flex flex-col gap-6 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <StageBadge stage={farm.stage} size="lg" />
              <div className="mt-3 flex items-baseline gap-2">
                <span className="num text-6xl font-extrabold">{farm.stage}</span>
                <span className="text-lg text-muted-foreground">stage</span>
              </div>
              <div className="mt-1"><ClassificationStatus /></div>
            </div>
            <div className="grid grid-cols-3 gap-3 text-center sm:w-72">
              <Mini label="Birds" value={String(farm.birds)} />
              <Mini label="Confidence" value={`${Math.round(farm.confidence * 100)}%`} />
              <Mini label="Batch" value="Active" />
            </div>
          </div>
          <div className="mt-6 flex gap-1">
            {STAGES.map((s) => {
              const len = s.days[1] - s.days[0] + 1;
              const idx = STAGES.findIndex((x) => x.name === farm.stage);
              const me = STAGES.findIndex((x) => x.name === s.name);
              const done = me < idx ? len : me === idx ? len / 2 : 0;
              return (
                <div key={s.name} style={{ flex: len }} className="min-w-0">
                  <div className="h-3 overflow-hidden rounded-full bg-muted">
                    <div className={`h-full ${stageBar[s.name]}`} style={{ width: `${(done / len) * 100}%` }} />
                  </div>
                  <div className="mt-1.5 truncate text-xs text-muted-foreground">{s.name}{s.name === farm.stage && " · detected now"}</div>
                </div>
              );
            })}
          </div>
        </Card>

        {/* 3. Temperature */}
        <Card>
          <CardTitle icon={<Thermometer className="h-4 w-4" />} right={<Pill tone={es.tone}>{es.label}</Pill>}>Temperature</CardTitle>
          <div className="num text-6xl font-extrabold">{env.temp}<span className="text-3xl text-muted-foreground">°C</span></div>
          <p className="mt-1 text-sm font-medium">Current: {env.temp}°C | Target: {st.temp[0]}–{st.temp[1]}°C</p>
          <p className="mt-3 rounded-lg bg-surface px-3 py-2 text-sm font-medium">{es.msg}</p>
          <div className="mt-4 grid grid-cols-2 gap-3">
            <SmallStat icon={<Droplets className="h-4 w-4" />} label="Humidity" value={`${env.humidity}%`} />
            <SmallStat icon={<Sun className="h-4 w-4" />} label="Light hours" value={`${env.lightHoursOn} / ${st.lightHours[0]}–${st.lightHours[1]}h`} />
          </div>
        </Card>
      </div>

      <div className="grid gap-5 lg:grid-cols-3">
        {/* 4. Feeding */}
        <Card className="lg:col-span-2">
          <CardTitle icon={<Wheat className="h-4 w-4" />} right={<Link to="/feeding" className="text-xs font-semibold text-primary">Details →</Link>}>Feeding</CardTitle>
          <div className="grid gap-5 sm:grid-cols-2">
            <div>
              <div className="text-xs uppercase tracking-wider text-muted-foreground">Now feeding</div>
              <div className="font-display text-2xl font-bold">{feed.type}</div>
              <div className="text-sm text-muted-foreground">From Compartment {feed.activeCompartment}</div>
              <div className="mt-4 flex items-baseline gap-2">
                <span className="num text-4xl font-extrabold">{feed.dispensed}g</span>
                <span className="text-muted-foreground">of {feed.targetPerFeeding}g target</span>
              </div>
              <div className="mt-2"><Meter value={(feed.dispensed / feed.targetPerFeeding) * 100} /></div>
              <div className="mt-3 grid grid-cols-2 gap-2 text-sm">
                <div><span className="text-muted-foreground">Last:</span> {feed.lastFeeding}</div>
                <div><span className="text-muted-foreground">Next:</span> {feed.nextFeeding}</div>
                <div><span className="text-muted-foreground">Accuracy:</span> {feed.accuracy}%</div>
              </div>
            </div>
            {/* 5. Inventory */}
            <div className="space-y-3">
              {feed.compartments.map((c) => {
                const pct = (c.kg / c.capacity) * 100;
                const tone = pct < 25 ? "danger" : pct < 50 ? "warn" : "ok";
                return (
                  <div key={c.id} className="rounded-xl border bg-surface p-4">
                    <div className="flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <div className="text-xs text-muted-foreground">Compartment {c.id}{c.id === feed.activeCompartment && " · ACTIVE"}</div>
                        <div className="truncate font-semibold">{c.contents}</div>
                      </div>
                      <div className="num shrink-0 text-2xl font-bold">{c.kg}<span className="text-sm text-muted-foreground"> kg</span></div>
                    </div>
                    <div className="mt-2"><Meter value={pct} tone={tone} /></div>
                  </div>
                );
              })}
            </div>
          </div>
        </Card>

        {/* Devices + hardware */}
        <Card>
          <CardTitle icon={<Cpu className="h-4 w-4" />} right={<Link to="/hardware" className="text-xs font-semibold text-primary">All →</Link>}>Devices & system</CardTitle>
          <div className="grid grid-cols-3 gap-2">
            <DevChip icon={<Fan className="h-5 w-5" />} label="Fans" on={env.fans.on} total={env.fans.total} />
            <DevChip icon={<Flame className="h-5 w-5" />} label="Heat" on={env.heatLamps.on} total={env.heatLamps.total} standby={farm.stage !== "Starter"} />
            <DevChip icon={<Lightbulb className="h-5 w-5" />} label="Lights" on={env.leds.on} total={env.leds.total} />
          </div>
          <ul className="mt-4 grid grid-cols-2 gap-x-3 gap-y-2 text-sm">
            {allHw.slice(0, 10).map((h) => (
              <li key={h.name} className="flex min-w-0 items-center gap-2">
                <Dot tone={healthTone(h.status)} />
                <span className="truncate">{h.plain}</span>
              </li>
            ))}
          </ul>
        </Card>
      </div>

      <div className="grid gap-5 md:grid-cols-2">
        <FeedSchedulePanel />
        <FeedStockPanel />
      </div>

      {/* 7. Trend */}
      <Card>
        <CardTitle icon={<Bird className="h-4 w-4" />} right={<span className="text-xs text-muted-foreground">Last 24 hours · green band = target</span>}>Temperature trend</CardTitle>
        <TrendChart data={envHistory} dataKey="temp" color="var(--chart-5)" unit="°" band={st.temp} />
      </Card>
    </div>
  );
}

function Mini({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-surface p-3">
      <div className="num text-xl font-bold">{value}</div>
      <div className="text-[11px] text-muted-foreground">{label}</div>
    </div>
  );
}
function SmallStat({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="rounded-xl border p-3">
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">{icon}{label}</div>
      <div className="num mt-1 text-xl font-bold">{value}</div>
    </div>
  );
}
function DevChip({ icon, label, on, total, standby }: { icon: React.ReactNode; label: string; on: number; total: number; standby?: boolean }) {
  const active = on > 0;
  return (
    <div className={`rounded-xl border p-3 text-center ${active ? "border-ok/30 bg-ok-soft text-ok" : "bg-surface text-muted-foreground"}`}>
      <div className="flex justify-center">{icon}</div>
      <div className="mt-1 text-xs font-semibold text-foreground">{label}</div>
      <div className="text-[11px] font-bold">{active ? `ON ${on}/${total}` : standby ? "Standby" : "OFF"}</div>
    </div>
  );
}
