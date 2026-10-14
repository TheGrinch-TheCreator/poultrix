import { Area, AreaChart, Bar, BarChart, CartesianGrid, Line, LineChart, ReferenceArea, ResponsiveContainer, Tooltip, XAxis, YAxis, Legend } from "recharts";

const axis = { stroke: "var(--muted-foreground)", fontSize: 11, tickLine: false, axisLine: false } as const;
const tip = { contentStyle: { background: "var(--card)", border: "1px solid var(--border)", borderRadius: 12, fontSize: 12, color: "var(--card-foreground)", boxShadow: "var(--shadow-card)" }, labelStyle: { color: "var(--muted-foreground)" }, cursor: { stroke: "var(--border)", fill: "var(--muted)", fillOpacity: 0.4 } };

export function TrendChart({
  data, dataKey, color, unit, band, height = 220,
}: { data: Record<string, unknown>[]; dataKey: string; color: string; unit: string; band?: [number, number]; height?: number }) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={data} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
        <defs>
          <linearGradient id={`g-${dataKey}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity={0.25} />
            <stop offset="100%" stopColor={color} stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid stroke="var(--border)" vertical={false} />
        {band && <ReferenceArea y1={band[0]} y2={band[1]} fill="var(--ok)" fillOpacity={0.08} />}
        <XAxis dataKey="time" {...axis} interval={3} />
        <YAxis {...axis} unit={unit} domain={["auto", "auto"]} />
        <Tooltip {...tip} />
        <Area type="monotone" dataKey={dataKey} stroke={color} strokeWidth={2.5} fill={`url(#g-${dataKey})`} />
      </AreaChart>
    </ResponsiveContainer>
  );
}

export function FeedBars({ data, height = 240 }: { data: Record<string, unknown>[]; height?: number }) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
        <CartesianGrid stroke="var(--border)" vertical={false} />
        <XAxis dataKey="day" {...axis} />
        <YAxis {...axis} unit="g" />
        <Tooltip {...tip} />
        <Legend wrapperStyle={{ fontSize: 12, color: "var(--muted-foreground)" }} />
        <Bar dataKey="target" name="Target" fill="var(--muted-foreground)" fillOpacity={0.35} radius={[4, 4, 0, 0]} />
        <Bar dataKey="actual" name="Dispensed" fill="var(--chart-1)" radius={[4, 4, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}

export function MultiLine({ data, height = 260 }: { data: Record<string, unknown>[]; height?: number }) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <LineChart data={data} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
        <CartesianGrid stroke="var(--border)" vertical={false} />
        <XAxis dataKey="time" {...axis} interval={3} />
        <YAxis {...axis} />
        <Tooltip {...tip} />
        <Legend wrapperStyle={{ fontSize: 12, color: "var(--muted-foreground)" }} />
        <Line type="monotone" dataKey="temp" name="Temp (°C)" stroke="var(--chart-5)" strokeWidth={2} dot={false} />
        <Line type="monotone" dataKey="humidity" name="Humidity (%)" stroke="var(--chart-2)" strokeWidth={2} dot={false} />
      </LineChart>
    </ResponsiveContainer>
  );
}
