import type { ReactNode } from "react";
import { useRouterState } from "@tanstack/react-router";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

/* ---------- Reusable building blocks (mirror Card / PageHeader sizing) ---------- */

export function SkeletonCard({ className, children }: { className?: string | undefined; children?: ReactNode }) {
  return (
    <div className={cn("rounded-2xl border bg-card p-5 shadow-card", className)}>
      <Skeleton className="mb-4 h-4 w-32" />
      {children}
    </div>
  );
}

export function SkeletonHeader({ action = false }: { action?: boolean }) {
  return (
    <div className="mb-6 flex items-end justify-between gap-4">
      <div className="space-y-2">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-4 w-64 max-w-[60vw]" />
      </div>
      {action && <Skeleton className="h-6 w-20 rounded-full" />}
    </div>
  );
}

export function SkeletonStat() {
  return (
    <SkeletonCard>
      <Skeleton className="h-10 w-28" />
      <Skeleton className="mt-3 h-3 w-40" />
    </SkeletonCard>
  );
}

export function SkeletonChart({ height = 220, className }: { height?: number; className?: string | undefined }) {
  return (
    <SkeletonCard className={className}>
      <Skeleton className="w-full rounded-xl" style={{ height }} />
    </SkeletonCard>
  );
}

export function SkeletonList({ rows = 4, className }: { rows?: number; className?: string | undefined }) {
  return (
    <SkeletonCard className={className}>
      <div className="space-y-3">
        {Array.from({ length: rows }).map((_, i) => (
          <div key={i} className="flex items-center gap-3">
            <Skeleton className="h-8 w-8 shrink-0 rounded-full" />
            <Skeleton className="h-4 flex-1" />
            <Skeleton className="h-3 w-14" />
          </div>
        ))}
      </div>
    </SkeletonCard>
  );
}

function Loading({ children, label = "Loading page" }: { children: ReactNode; label?: string }) {
  return (
    <div role="status" aria-live="polite" aria-busy="true">
      <span className="sr-only">{label}…</span>
      {children}
    </div>
  );
}

/* ---------- Page-shaped layouts ---------- */

const layouts: Record<string, () => ReactNode> = {
  "/": () => (
    <>
      <Skeleton className="mb-5 h-20 w-full rounded-2xl" />
      <div className="grid gap-5 lg:grid-cols-3">
        <SkeletonChart height={200} className="lg:col-span-2" />
        <SkeletonStat />
        <SkeletonChart height={200} className="lg:col-span-2" />
        <SkeletonList rows={5} />
      </div>
      <SkeletonChart height={220} className="mt-5" />
    </>
  ),
  "/feeding": () => (
    <div className="grid gap-5 lg:grid-cols-2">
      <SkeletonStat /><SkeletonStat />
      <SkeletonCard><Skeleton className="h-3 w-full rounded-full" /><Skeleton className="mt-4 h-3 w-2/3 rounded-full" /></SkeletonCard>
      <SkeletonCard><Skeleton className="h-3 w-full rounded-full" /><Skeleton className="mt-4 h-3 w-1/2 rounded-full" /></SkeletonCard>
      <SkeletonChart height={240} className="lg:col-span-2" />
    </div>
  ),
  "/environment": () => (
    <>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">{Array.from({ length: 4 }).map((_, i) => <SkeletonStat key={i} />)}</div>
      <div className="mt-5 grid gap-5 lg:grid-cols-2"><SkeletonChart /><SkeletonList rows={4} /></div>
    </>
  ),
  "/ai-stage": () => (
    <div className="grid gap-5 lg:grid-cols-2">
      <div className="grid aspect-video place-items-center rounded-2xl border bg-surface text-xs text-muted-foreground">Connecting to camera…</div>
      <SkeletonCard><Skeleton className="h-12 w-40" /><Skeleton className="mt-4 h-3 w-full rounded-full" /><Skeleton className="mt-3 h-3 w-3/4 rounded-full" /></SkeletonCard>
      <SkeletonList rows={5} className="lg:col-span-2" />
    </div>
  ),
  "/history": () => (
    <>
      <div className="mb-5 flex gap-2">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-9 w-24 rounded-full" />)}</div>
      <div className="grid gap-5 lg:grid-cols-2"><SkeletonChart height={260} /><SkeletonChart height={260} /><SkeletonChart height={240} className="lg:col-span-2" /></div>
      <SkeletonList rows={5} className="mt-5" />
    </>
  ),
  "/alerts": () => <SkeletonList rows={6} />,
  "/settings": () => <div className="grid gap-5 lg:grid-cols-2"><SkeletonList rows={4} /><SkeletonList rows={1} /><SkeletonList rows={4} /></div>,
  "/profile": () => <div className="grid gap-5 lg:grid-cols-[320px_1fr]"><SkeletonCard><Skeleton className="mx-auto h-24 w-24 rounded-full" /><Skeleton className="mx-auto mt-4 h-4 w-32" /></SkeletonCard><SkeletonList rows={5} /></div>,
};

const fallback = () => (
  <div className="grid gap-5 lg:grid-cols-2"><SkeletonStat /><SkeletonStat /><SkeletonChart className="lg:col-span-2" /></div>
);

/** Skeleton shaped like the given page; shown only while a route is genuinely pending. */
export function PageSkeleton({ path }: { path?: string }) {
  const current = useRouterState({ select: (s) => s.location.pathname });
  const key = path ?? current;
  const body = (layouts[key] ?? fallback)();
  return (
    <Loading>
      <SkeletonHeader action={key !== "/settings" && key !== "/profile"} />
      {body}
    </Loading>
  );
}
