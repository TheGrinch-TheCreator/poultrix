import { Link, useRouterState } from "@tanstack/react-router";
import { useEffect, useState, type ReactNode } from "react";
import {
  LayoutDashboard, Bird, Wheat, Thermometer, ScanEye, Bell, Cpu, CalendarRange, LineChart, Settings, UserRound, Wifi,
} from "lucide-react";
import { farm } from "@/lib/demo-data";
import { getMyFarm, type PoultrixFarm } from "@/lib/farm-store";
import poultrixLogo from "@/assets/poultrix-logo.png";
import { useLiveAlerts } from "@/lib/live-alerts";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { useProfile } from "@/hooks/use-profile";
import { API_URL } from "@/lib/live-hardware";

const NAV = [
  { to: "/", label: "Dashboard", icon: LayoutDashboard },
  { to: "/flock", label: "Flock", icon: Bird },
  { to: "/feeding", label: "Feeding", icon: Wheat },
  { to: "/environment", label: "Environment", icon: Thermometer },
  { to: "/ai-stage", label: "AI Growth Stage", icon: ScanEye },
  { to: "/alerts", label: "Alerts", icon: Bell },
  { to: "/hardware", label: "System Status", icon: Cpu },
  { to: "/cycle", label: "Growth Cycle", icon: CalendarRange },
  { to: "/history", label: "History", icon: LineChart },
  { to: "/settings", label: "Settings", icon: Settings },
] as const;

const MOBILE = [
  { to: "/", label: "Home", icon: LayoutDashboard },
  { to: "/feeding", label: "Feed", icon: Wheat },
  { to: "/environment", label: "Climate", icon: Thermometer },
  { to: "/ai-stage", label: "AI Stage", icon: ScanEye },
  { to: "/more", label: "More", icon: Settings },
] as const;

function Logo() {
  return (
    <img
      src={poultrixLogo}
      alt="Poultrix — Smart Feeding & Climate Control"
      width={1489}
      height={490}
      draggable={false}
      className="w-full select-none"
    />
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const path = useRouterState({ select: (s) => s.location.pathname });
  const { count: active } = useLiveAlerts();
  const { profile, avatarUrl } = useProfile();
  // Read-only connection indicator. No UI control can force LIVE or SAFE.
  const [hardwareConnected, setHardwareConnected] = useState(false);
  useEffect(() => {
    let active = true;
    let fetching = false;
    const refresh = async () => {
      if (fetching) return;
      fetching = true;
      try {
        const response = await fetch(`${API_URL}/api/status`, { cache: "no-store" });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const status = await response.json() as { connected?: boolean; mode?: string; lastSeen?: string; systemHealth?: string };
        const seen = status.lastSeen ? Date.parse(status.lastSeen) : NaN;
        const fresh = Number.isFinite(seen) && Math.abs(Date.now() - seen) < 15000;
        const live = status.connected === true && status.mode?.toLowerCase() === "live" &&
          ["READY", "OK"].includes(String(status.systemHealth ?? "").toUpperCase()) && fresh;
        if (active) setHardwareConnected(live);
      } catch {
        if (active) setHardwareConnected(false);
      } finally { fetching = false; }
    };
    void refresh();
    const timer = window.setInterval(() => { void refresh(); }, 2000);
    return () => { active = false; window.clearInterval(timer); };
  }, []);
  const [savedFarm, setSavedFarm] = useState<PoultrixFarm | null>(null);
  useEffect(() => { let mounted=true; const refresh=()=>{getMyFarm().then(f=>{if(mounted)setSavedFarm(f);}).catch(console.error);};refresh();window.addEventListener("poultrix:farm-updated",refresh);return()=>{mounted=false;window.removeEventListener("poultrix:farm-updated",refresh);};},[]);

  return (
    <div className="min-h-screen lg:grid lg:grid-cols-[260px_1fr]">
      <aside className="sticky top-0 hidden h-screen flex-col bg-sidebar p-5 text-sidebar-foreground lg:flex">
        <Logo />
        <nav className="mt-8 flex flex-1 flex-col gap-1">
          {NAV.map(({ to, label, icon: Icon }) => {
            const on = to === "/" ? path === "/" : path.startsWith(to);
            return (
              <Link
                key={to}
                to={to}
                className={`flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors ${
                  on ? "bg-sidebar-accent text-sidebar-accent-foreground" : "opacity-80 hover:bg-sidebar-accent/60 hover:opacity-100"
                }`}
              >
                <Icon className={`h-[18px] w-[18px] ${on ? "text-sidebar-primary" : ""}`} />
                <span className="flex-1">{label}</span>
                {to === "/alerts" && active > 0 && (
                  <span className="rounded-full bg-sidebar-primary px-2 text-xs font-bold text-sidebar-primary-foreground">{active}</span>
                )}
              </Link>
            );
          })}
        </nav>
        <Link to="/profile" className="mt-4 flex items-center gap-3 rounded-lg border border-sidebar-border p-3 hover:bg-sidebar-accent/60">
          <Avatar className="h-9 w-9 bg-sidebar-accent">
            {avatarUrl && <AvatarImage src={avatarUrl} alt={profile?.full_name || "Profile photo"} className="object-cover" />}
            <AvatarFallback className="bg-sidebar-accent"><UserRound className="h-4 w-4" /></AvatarFallback>
          </Avatar>
          <div className="min-w-0 text-sm">
            <div className="truncate font-semibold">{profile?.full_name || "My profile"}</div>
            <div className="truncate text-xs opacity-70">{savedFarm?.location ?? "Farm location unavailable"}</div>
          </div>
        </Link>
      </aside>

      <div className="min-w-0 pb-24 lg:pb-0">
        <header className="sticky top-0 z-20 border-b bg-background/90 backdrop-blur">
          <div className="mx-auto flex max-w-7xl items-center justify-between gap-3 px-4 py-3 sm:px-6">
            <div className="min-w-0">
              <div className="truncate font-semibold">{savedFarm?.name ?? "Poultrix"}</div>
              <div className="truncate text-xs text-muted-foreground">{farm.batch} · {farm.stage} (AI)</div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Link
                to="/alerts"
                aria-label={`${active} active alert${active === 1 ? "" : "s"}`}
                title="Alerts"
                className={`relative grid h-10 w-10 place-items-center rounded-full border bg-card transition-colors hover:bg-accent ${path.startsWith("/alerts") ? "text-primary" : "text-foreground"}`}
              >
                <Bell className={`h-5 w-5 ${active > 0 ? "bell-ring" : ""}`} />
                {active > 0 && (
                  <span className="absolute -right-1 -top-1 grid h-5 min-w-5 place-items-center rounded-full bg-danger px-1 text-[10px] font-bold text-danger-foreground">
                    {active}
                  </span>
                )}
              </Link>
              <div className="flex flex-col items-end gap-1">
                <div role="status" aria-live="polite" title={hardwareConnected ? "Live Arduino telemetry confirmed" : "Hardware offline, unready, or telemetry stale"} className="flex items-center gap-2 rounded-full border bg-card px-3 py-1.5 text-xs font-medium">
                  <span className={`h-2.5 w-2.5 rounded-full ${hardwareConnected ? "bg-green-500" : "bg-red-500"}`} />
                  <span>{hardwareConnected ? "LIVE" : "OFFLINE"}</span>
                  <Wifi className="hidden h-3.5 w-3.5 text-muted-foreground sm:block" />
                </div>
              </div>
            </div>
          </div>
        </header>
        <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6 sm:py-8">{children}</main>
      </div>

      <nav className="fixed inset-x-0 bottom-0 z-30 grid grid-cols-5 border-t bg-card lg:hidden">
        {MOBILE.map(({ to, label, icon: Icon }) => {
          const on = to === "/" ? path === "/" : path.startsWith(to);
          return (
            <Link key={to} to={to} className={`relative flex flex-col items-center gap-1 py-2.5 text-[11px] font-semibold ${on ? "text-primary" : "text-muted-foreground"}`}>
              <Icon className="h-5 w-5" />
              {label}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}

export { NAV };
