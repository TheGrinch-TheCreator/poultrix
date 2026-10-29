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
  const [systemMode, setSystemMode] = useState<"live" | "safe" | "unknown">("unknown");
  const [hardwareConnected, setHardwareConnected] = useState(false);
  const [modeBusy, setModeBusy] = useState(false);
  const [modeError, setModeError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    let fetching = false;
    const refresh = async () => {
      if (fetching) return;
      fetching = true;
      try {
        const response = await fetch(`${API_URL}/api/recovery/status`, { cache: "no-store" });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const status = await response.json() as { connected?: boolean; mode?: string };
        if (active) {
          setHardwareConnected(status.connected === true);
          setSystemMode(status.connected === true && status.mode?.toLowerCase() === "live" ? "live" : status.connected === true && status.mode?.toLowerCase() === "safe" ? "safe" : "unknown");
        }
      } catch {
        if (active) { setHardwareConnected(false); setSystemMode("unknown"); }
      } finally { fetching = false; }
    };
    void refresh();
    const timer = window.setInterval(() => { if (!modeBusy) void refresh(); }, 2000);
    return () => { active = false; window.clearInterval(timer); };
  }, [modeBusy]);
  const toggleSystemMode = async () => {
    if (modeBusy || !hardwareConnected || systemMode === "unknown") return;
    const target = systemMode === "live" ? "safe" : "live";
    if (target === "live" && !window.confirm("Activate LIVE mode? Poultrix may turn on fans, lights, heaters, and other connected outputs. Confirm the hardware is safe.")) return;
    setModeBusy(true);
    setModeError(null);
    try {
      const response = await fetch(`${API_URL}/api/mode/${target}`, { method: "POST", cache: "no-store" });
      const result = await response.json().catch(() => ({})) as { success?: boolean; message?: string; error?: string };
      if (!response.ok || result.success === false) throw new Error(result.error || result.message || `HTTP ${response.status}`);
      // Wait for the Arduino to report its actual mode, rather than assuming the command succeeded.
      let confirmed = false;
      for (let attempt = 0; attempt < 12; attempt++) {
        await new Promise<void>((resolve) => window.setTimeout(resolve, 500));
        const check = await fetch(`${API_URL}/api/recovery/status`, { cache: "no-store" });
        if (!check.ok) continue;
        const status = await check.json() as { connected?: boolean; mode?: string };
        if (status.connected && status.mode?.toLowerCase() === target) {
          setSystemMode(target); setHardwareConnected(true); confirmed = true; break;
        }
      }
      if (!confirmed) throw new Error("Mode change not confirmed by Arduino. Check System Status.");
    } catch (error) {
      setModeError(error instanceof Error ? error.message : "Mode change failed");
    } finally { setModeBusy(false); }
  };
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
                <button
                  type="button"
                  onClick={() => void toggleSystemMode()}
                  disabled={modeBusy || !hardwareConnected || systemMode === "unknown"}
                  aria-label={`System ${systemMode}. ${systemMode === "live" ? "Click to enter SAFE mode" : "Click to request LIVE mode"}`}
                  title={!hardwareConnected ? "Arduino unavailable" : systemMode === "live" ? "Switch to SAFE mode" : "Switch to LIVE mode"}
                  className="flex items-center gap-2 rounded-full border bg-card px-3 py-1.5 text-xs font-medium transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-60"
                >
                  <span className={`h-2.5 w-2.5 rounded-full ${systemMode === "live" && hardwareConnected ? "bg-green-500" : systemMode === "safe" && hardwareConnected ? "bg-amber-500" : "bg-red-500"}`} />
                  <span>{modeBusy ? "Switching…" : !hardwareConnected ? "Offline" : systemMode === "live" ? "Live" : systemMode === "safe" ? "Safe" : "Unknown"}</span>
                  <Wifi className="hidden h-3.5 w-3.5 text-muted-foreground sm:block" />
                  <span className="hidden text-muted-foreground sm:inline">· {farm.lastUpdate}</span>
                </button>
                {modeError && <span role="alert" className="max-w-64 text-right text-[11px] text-red-600">{modeError}</span>}
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
