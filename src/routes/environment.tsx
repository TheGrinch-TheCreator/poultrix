import { createFileRoute } from "@tanstack/react-router";
import { Droplets, Sun, Thermometer, ShieldCheck } from "lucide-react";
import { env, envHistory, envStatus, farm, stageInfo } from "@/lib/demo-data";
import { Card, CardTitle, DemoTag, DeviceState, PageHeader, Pill } from "@/components/poultrix/ui";
import { TrendChart } from "@/components/poultrix/charts";

export const Route = createFileRoute("/environment")({
  head: () => ({
    meta: [
      { title: "Environment — POULTRIX" },
      { name: "description", content: "Live temperature, humidity and light with automatic fan, heat lamp and LED control." },
      { property: "og:title", content: "Environment — POULTRIX" },
      { property: "og:description", content: "Live temperature, humidity and light with automatic fan, heat lamp and LED control." },
    ],
  }),
  component: EnvPage,
});

function EnvPage() {
  const st = stageInfo(farm.stage);
  const es = envStatus(env.temp, farm.stage);
  return (
    <>
      <PageHeader title="Environment" subtitle={`Philippine climate targets for the ${farm.stage} stage — cooling is the main job.`} right={<DemoTag />} />
      <div className="grid gap-5 md:grid-cols-3">
        <Card>
          <CardTitle icon={<Thermometer className="h-4 w-4" />} right={<Pill tone={es.tone}>{es.label}</Pill>}>Temperature</CardTitle>
          <div className="num text-5xl font-extrabold">{env.temp}°C</div>
          <p className="text-sm font-medium">Current: {env.temp}°C | Target: {st.temp[0]}–{st.temp[1]}°C</p>
        </Card>
        <Card>
          <CardTitle icon={<Droplets className="h-4 w-4" />} right={<Pill tone="ok">Normal</Pill>}>Humidity</CardTitle>
          <div className="num text-5xl font-extrabold">{env.humidity}%</div>
          <p className="text-sm text-muted-foreground">Monitored only — no humidity control</p>
        </Card>
        <Card>
          <CardTitle icon={<Sun className="h-4 w-4" />} right={<Pill tone="ok">{env.lightLabel}</Pill>}>Light level</CardTitle>
          <div className="num text-5xl font-extrabold">{env.lightLux}<span className="text-xl text-muted-foreground"> lux</span></div>
          <p className="text-sm text-muted-foreground">Target {st.lux[0]}–{st.lux[1]} lux</p>
          <p className="mt-2 text-sm font-medium">Light hours today: {env.lightHoursOn}h · target {st.lightHours[0]}–{st.lightHours[1]}h</p>
        </Card>
      </div>

      <Card className="mt-5">
        <CardTitle icon={<ShieldCheck className="h-4 w-4" />} right={<Pill tone="ok">Automatic</Pill>}>Devices — and why</CardTitle>
        <p className="mb-4 rounded-lg bg-surface px-3 py-2 text-sm font-medium">{es.msg}</p>
        <div className="grid gap-3 sm:grid-cols-3">
          <DeviceState label="Exhaust fans" on={env.fans.on} total={env.fans.total} reason="turn on when above target" />
          <DeviceState label="Heat lamps" on={env.heatLamps.on} total={env.heatLamps.total} reason={farm.stage === "Starter" ? "turn on when below target" : "Standby — Starter stage only"} />
          <DeviceState label="LED lights" on={env.leds.on} total={env.leds.total} reason="ON — within light schedule" />
        </div>
        <p className="mt-4 text-xs text-muted-foreground">
          These 220V devices are controlled on-site by POULTRIX. Manual override from the web is not available — TBD / requires implementation decision.
        </p>
      </Card>

      <div className="mt-5 grid gap-5 lg:grid-cols-3">
        <Card><CardTitle>Temperature · 24h</CardTitle><TrendChart data={envHistory} dataKey="temp" color="var(--chart-5)" unit="°" band={st.temp} height={200} /></Card>
        <Card><CardTitle>Humidity · 24h</CardTitle><TrendChart data={envHistory} dataKey="humidity" color="var(--chart-2)" unit="%" height={200} /></Card>
        <Card><CardTitle>Light · 24h</CardTitle><TrendChart data={envHistory} dataKey="light" color="var(--chart-3)" unit="" height={200} /></Card>
      </div>
    </>
  );
}
