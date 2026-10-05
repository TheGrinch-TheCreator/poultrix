import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import type { Health, Stage } from "@/lib/demo-data";

export type Tone = "ok" | "warn" | "danger" | "info" | "neutral";

const toneText: Record<Tone, string> = {
  ok: "text-ok",
  warn: "text-warn",
  danger: "text-danger",
  info: "text-info",
  neutral: "text-muted-foreground",
};
const toneBg: Record<Tone, string> = {
  ok: "bg-ok-soft text-ok",
  warn: "bg-warn-soft text-warn",
  danger: "bg-danger-soft text-danger",
  info: "bg-info-soft text-info",
  neutral: "bg-muted text-muted-foreground",
};

export function healthTone(h: Health): Tone {
  return h === "ok" ? "ok" : h === "warn" ? "warn" : "danger";
}

export function Dot({ tone, pulse }: { tone: Tone; pulse?: boolean }) {
  return (
    <span className={cn("inline-block h-2.5 w-2.5 shrink-0 rounded-full bg-current", toneText[tone], pulse && "pulse-dot")} />
  );
}

export function Pill({ tone, children, className }: { tone: Tone; children: ReactNode; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold", toneBg[tone], className)}>
      {children}
    </span>
  );
}

const stageCls: Record<Stage, string> = {
  Starter: "bg-starter-soft text-finisher border-starter/40",
  Grower: "bg-grower-soft text-grower border-grower/30",
  Finisher: "bg-finisher-soft text-finisher border-finisher/30",
};
export const stageBar: Record<Stage, string> = {
  Starter: "bg-starter",
  Grower: "bg-grower",
  Finisher: "bg-finisher",
};

export function StageBadge({ stage, size = "sm" }: { stage: Stage; size?: "sm" | "lg" }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border font-bold uppercase tracking-wider",
        stageCls[stage],
        size === "lg" ? "px-4 py-1.5 text-sm" : "px-2.5 py-0.5 text-[11px]",
      )}
    >
      {stage}
    </span>
  );
}

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("card-surface p-5", className)}>{children}</div>;
}

export function CardTitle({ icon, children, right }: { icon?: ReactNode; children: ReactNode; right?: ReactNode }) {
  return (
    <div className="mb-4 flex items-center justify-between gap-3">
      <div className="flex min-w-0 items-center gap-2 text-sm font-semibold text-muted-foreground">
        {icon && <span className="shrink-0 text-primary">{icon}</span>}
        <span className="truncate">{children}</span>
      </div>
      {right}
    </div>
  );
}

export function PageHeader({ title, subtitle, right }: { title: string; subtitle?: string; right?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        <h1 className="text-2xl font-bold sm:text-3xl">{title}</h1>
        {subtitle && <p className="mt-1 text-muted-foreground">{subtitle}</p>}
      </div>
      {right}
    </div>
  );
}

export function Meter({ value, tone = "ok" }: { value: number; tone?: Tone }) {
  const bar: Record<Tone, string> = { ok: "bg-ok", warn: "bg-warn", danger: "bg-danger", info: "bg-info", neutral: "bg-muted-foreground" };
  return (
    <div className="h-2.5 w-full overflow-hidden rounded-full bg-muted">
      <div className={cn("h-full rounded-full transition-all", bar[tone])} style={{ width: `${Math.min(100, Math.max(0, value))}%` }} />
    </div>
  );
}

export function DemoTag() {
  return <span className="rounded-md border border-dashed px-2 py-0.5 text-[11px] font-medium text-muted-foreground">Demo data</span>;
}

export function DeviceState({ label, on, total, reason }: { label: string; on: number; total: number; reason: string }) {
  const active = on > 0;
  return (
    <div className={cn("rounded-xl border p-4", active ? "border-ok/30 bg-ok-soft" : "bg-surface")}>
      <div className="flex items-center justify-between">
        <span className="font-semibold">{label}</span>
        <Pill tone={active ? "ok" : "neutral"}>{active ? "ON" : "OFF"}</Pill>
      </div>
      <div className="mt-3 flex gap-1.5">
        {Array.from({ length: total }, (_, i) => (
          <span key={i} className={cn("h-2 flex-1 rounded-full", i < on ? "bg-ok" : "bg-border")} />
        ))}
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        {on} of {total} · {reason}
      </p>
    </div>
  );
}
