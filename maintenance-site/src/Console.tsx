import { useEffect, useState } from "react";
import { Card, CardTitle, Pill } from "@/components/poultrix/ui";
import poultrixLogo from "@/assets/poultrix-logo.png";
import { piRequest, SESSION_KEY, sessionExpired, useCameraUrl, usePoll } from "./pi";

// Maintenance console: today's bypass controls (moved from the main app's
// /bypass page) plus a live camera and a status strip. Bypass password only.

const inputClass = "w-full rounded-lg border bg-background px-3 py-2 text-sm";
const btn = "rounded-lg border px-3 py-2 text-sm font-medium disabled:opacity-40 hover:bg-muted";
const RELAY_NAMES = ["Fan 1", "Fan 2", "Fan 3", "Fan 4", "LED", "Heater Lamps (2 × D28/IN7)"];
const SENSOR_KEYS = [["temperature", "Temperature °C"], ["ldr", "LDR raw"], ["hopper", "Hopper grams"], ["trough", "Trough grams"]] as const;
type SensorKey = (typeof SENSOR_KEYS)[number][0];

type BypassStatus = {
  active?: boolean;
  manualControlsPaused?: boolean;
  connectionLostAt?: string | null;
  expiresSeconds?: number;
  relays?: boolean[];
  readings?: Partial<Record<SensorKey, number | null>>;
  simulation?: { active?: boolean; stage?: string; framesAnalyzed?: number; confidence?: number | null };
};
type Snapshot = {
  status?: {
    connected?: boolean; piSeenByArduino?: boolean | null; operatingStatus?: string; stage?: string;
    temperature?: number | null; humidity?: number | null; fansOn?: number; heatersOn?: number; led?: boolean;
    camera?: { connected?: boolean };
  } | null;
};

function readToken(): string {
  try { return localStorage.getItem(SESSION_KEY) || ""; } catch { return ""; }
}

function fixed(value: number | null | undefined, unit: string): string {
  return typeof value === "number" && Number.isFinite(value) ? `${value.toFixed(1)}${unit}` : "—";
}

export function Console() {
  const [token, setToken] = useState(readToken);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("Maintenance controls are inactive.");
  const [seconds, setSeconds] = useState("0.5");
  const [stage, setStage] = useState("STARTER");
  const [values, setValues] = useState<Record<SensorKey, string>>({ temperature: "", ldr: "", hopper: "", trough: "" });
  const [relayState, setRelayState] = useState<Record<number, boolean>>({});

  function clearSession(note?: string) {
    setToken("");
    setRelayState({});
    try { localStorage.removeItem(SESSION_KEY); } catch { /* storage unavailable */ }
    if (note) setMessage(note);
  }
  const onPollError = (error: unknown) => {
    if (sessionExpired(error)) clearSession("Maintenance session expired or revoked. Enter the bypass password again.");
  };

  const { data: status, error: statusError } = usePoll<BypassStatus>("/bypass/status", token, 3000, onPollError);
  const { data: snapshot } = usePoll<Snapshot>("/snapshot", token, 5000, onPollError);
  const relayReady = Array.isArray(status?.relays) && status.relays.length === 6;
  useEffect(() => {
    if (relayReady && status?.relays) setRelayState(Object.fromEntries(status.relays.map((on, i) => [i + 1, Boolean(on)])));
  }, [relayReady, status?.relays]);

  async function call<T = Record<string, unknown>>(path: string, body?: unknown): Promise<T> {
    return piRequest<T>(`/bypass/${path}`, { token, method: "POST", body: body ?? {} });
  }

  async function perform(path: string, body?: unknown) {
    setBusy(true);
    try {
      const result = await call<{ action?: string; group?: number; durationMs?: number; simulation?: boolean }>(path, body);
      if (path === "return-live") setMessage("Overrides cleared; the Arduino is back under automatic control. Maintenance stays unlocked.");
      else if (path === "resume") setMessage("Manual bypass resumed.");
      else if (path === "exit") clearSession("Bypass ended. Gates closed and the Arduino is under automatic control.");
      else if (result.action === "dispense") setMessage(`Arduino acknowledged compartment ${result.group} for ${Number(result.durationMs) / 1000}s. Check the gate on the camera.`);
      else if (result.simulation) setMessage("Test value saved. Fan/LED responses (when applicable) were acknowledged; real sensors and calibration unchanged.");
      else setMessage("Command accepted by the Raspberry Pi. Check the hardware on the camera.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
      if (sessionExpired(error)) clearSession();
    } finally { setBusy(false); }
  }

  async function toggleRelay(index: number) {
    const next = !relayState[index];
    setBusy(true);
    try {
      await call("action", { action: "relay", relay: index, on: next });
      setRelayState((state) => ({ ...state, [index]: next }));
      setMessage("Relay command acknowledged. Check the output on the camera.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally { setBusy(false); }
  }

  async function login() {
    setBusy(true);
    try {
      const result = await piRequest<{ token: string }>("/bypass/login", { body: { password } });
      setToken(result.token);
      try { localStorage.setItem(SESSION_KEY, result.token); } catch { /* storage unavailable */ }
      setPassword("");
      setMessage("Maintenance active. The session lasts eight hours or until you exit.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally { setBusy(false); }
  }

  const active = status?.active === true;
  const hw = snapshot?.status ?? null;
  const link = !hw ? { tone: "neutral" as const, label: "Checking…" }
    : hw.connected !== true ? { tone: "danger" as const, label: "Arduino offline" }
    : hw.piSeenByArduino === false ? { tone: "warn" as const, label: "Connecting…" }
    : { tone: "ok" as const, label: "Online" };

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="sticky top-0 z-20 border-b bg-background/90 backdrop-blur">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-3 px-4 py-3">
          <div className="flex min-w-0 items-center gap-2">
            <img src={poultrixLogo} alt="" className="h-8 w-8 rounded-lg object-contain" />
            <div className="min-w-0">
              <div className="truncate font-semibold">Poultrix Maintenance</div>
              <div className="truncate text-xs text-muted-foreground">Manual bypass · authorized use only</div>
            </div>
          </div>
          {token && <Pill tone={link.tone}>{link.label}</Pill>}
        </div>
      </header>

      <main className="mx-auto max-w-5xl space-y-4 px-4 py-6">
        {!token ? (
          <Card>
            <CardTitle>Unlock maintenance controls</CardTitle>
            <form className="mt-4 flex flex-wrap gap-2" onSubmit={(event) => { event.preventDefault(); if (password) void login(); }}>
              <input aria-label="Bypass password" type="password" autoComplete="off" className={inputClass + " max-w-sm"} value={password} onChange={(event) => setPassword(event.target.value)} placeholder="Bypass password" />
              <button type="submit" className={btn} disabled={busy || !password}>Enter bypass</button>
            </form>
            <p className="mt-3 text-xs text-muted-foreground">This site doesn't replace physical emergency controls. Manual outputs return to automatic control when you exit or 10 s after the Pi stops responding.</p>
          </Card>
        ) : (
          <>
            <CameraCard token={token} cameraOnline={hw?.camera?.connected !== false} />

            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Stat label="Temperature" value={fixed(hw?.temperature, " °C")} />
              <Stat label="Humidity" value={fixed(hw?.humidity, " %")} />
              <Stat label="Stage" value={hw?.stage ?? "—"} />
              <Stat label="Fans · Heater · LED" value={hw ? `${hw.fansOn ?? 0} · ${hw.heatersOn ? "on" : "off"} · ${hw.led ? "on" : "off"}` : "—"} />
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3">
              <div>
                <b>{status?.manualControlsPaused ? (status.connectionLostAt ? "Connection lost — manual control paused" : "Manual control paused") : active ? "Manual bypass active" : "Checking session…"}</b>
                <p className="text-xs text-muted-foreground">
                  {status?.expiresSeconds != null ? `${Math.ceil(status.expiresSeconds / 60)} min remaining` : statusError ?? "Checking session…"}
                  {" · "}
                  {status?.manualControlsPaused
                    ? status.connectionLostAt ? "The Arduino returned to automatic control while the connection was down. Resume to take manual control again." : "The Arduino is under automatic control. Resume to take manual control again."
                    : "Return to automatic control clears overrides without locking this site."}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <button className={btn} disabled={busy} onClick={() => void perform("exit")}>Exit bypass & close gates</button>
                <button className={btn + " border-green-600 text-green-700"} disabled={busy} onClick={() => { if (window.confirm("Clear all manual overrides and return to automatic control? Fans, heater and lights may switch on automatically.")) void perform("return-live"); }}>Return to automatic control</button>
                {status?.manualControlsPaused && <button className={btn} disabled={busy} onClick={() => void perform("resume")}>Resume manual bypass</button>}
              </div>
            </div>

            <Card>
              <CardTitle>Servo control — 2 compartments (10 servos)</CardTitle>
              <p className="my-2 text-xs text-muted-foreground">Supervised timed group dispensing. Closed 0° · open 90°. The Arduino closes the group after the requested time (max 10 s). One group at a time. Keep compartments empty for tests.</p>
              <label className="block max-w-xs text-sm">Duration (seconds)
                <input type="number" min="0.1" max="10" step="0.1" className={inputClass + " mt-1"} value={seconds} onChange={(event) => setSeconds(event.target.value)} />
              </label>
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                {([1, 2] as const).map((group) => (
                  <div key={group} className="rounded-lg border p-4">
                    <p className="font-medium">Compartment {group} — 5 servos</p>
                    <p className="mt-1 text-xs text-muted-foreground">PCA9685 channels {group === 1 ? "0–4" : "11–15"}</p>
                    <button
                      className={btn + " mt-3 w-full border-blue-600 text-blue-700"}
                      disabled={busy || !active || !Number.isFinite(Number(seconds)) || Number(seconds) < 0.1 || Number(seconds) > 10}
                      onClick={() => { if (window.confirm(`Open all 5 servos of compartment ${group} for ${seconds} s? Confirm the gates are clear and supervised.`)) void perform("action", { action: "dispense", group, seconds: Number(seconds) }); }}
                    >Dispense group {group}</button>
                  </div>
                ))}
              </div>
              <button className={btn + " mt-3 border-red-500 text-red-600"} onClick={() => void perform("action", { action: "stop" })}>STOP ALL GATES</button>
            </Card>

            <Card>
              <CardTitle>Relay control</CardTitle>
              <p className="my-2 text-xs text-muted-foreground">Fans, LED and the heater relay (D28 / IN7, both lamps together) need the Arduino's acknowledgement. Outputs return to automatic control when bypass ends or the 10 s safety timeout expires.</p>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {RELAY_NAMES.map((name, i) => (
                  <button key={name} className={btn} disabled={busy || !relayReady || !active} onClick={() => void toggleRelay(i + 1)}>{name}: {relayState[i + 1] ? "ON" : "OFF"}</button>
                ))}
              </div>
            </Card>

            <Card>
              <CardTitle>Sensor test readings</CardTitle>
              <p className="my-2 text-xs text-muted-foreground">Temperature test values drive the fan relays; LDR raw values drive the LED relay. Values fluctuate every 2 s around what you enter. Hopper/trough values show as SIMULATED in the app. Simulations never turn on the heater.</p>
              <div className="grid gap-3 sm:grid-cols-2">
                {SENSOR_KEYS.map(([key, label]) => (
                  <label key={key} className="text-sm">{label}
                    <div className="mt-1 flex gap-2">
                      <input className={inputClass} type="number" value={values[key]} onChange={(event) => setValues((v) => ({ ...v, [key]: event.target.value }))} />
                      <button className={btn} disabled={busy || !active} onClick={() => void perform("action", { action: "override", key, value: values[key] === "" ? null : Number(values[key]) })}>Set</button>
                    </div>
                    {status?.readings?.[key] != null && (
                      <p className="mt-1 text-xs text-muted-foreground">Simulated reading: <span className="font-semibold tabular-nums">{key === "ldr" ? Math.round(Number(status.readings[key])) : Number(status.readings[key]).toFixed(1)}</span> {key === "temperature" ? "°C" : key === "ldr" ? "raw" : "g"}</p>
                    )}
                  </label>
                ))}
              </div>
            </Card>

            <Card>
              <CardTitle>Chicken stage test target</CardTitle>
              <p className="my-2 text-xs text-muted-foreground">Sets a test target only. Three "Analyze now" runs on the app's AI Stage page confirm it and apply a real stage change.</p>
              <div className="flex flex-wrap gap-2">
                <select className={inputClass + " max-w-xs"} value={stage} onChange={(event) => setStage(event.target.value)}>
                  {["NO_CHICKEN", "STARTER", "GROWER", "FINISHER"].map((value) => <option key={value} value={value}>{value === "NO_CHICKEN" ? "No Chicken Detected" : value}</option>)}
                </select>
                <button className={btn} disabled={busy || !active} onClick={() => void perform("action", { action: "stage", stage })}>Apply stage</button>
                <button className={btn} disabled={busy || !active} onClick={() => void perform("analyse-real")}>Analyse real stage</button>
              </div>
              {status?.simulation?.active && (
                <p className="mt-2 text-sm">{status.simulation.stage === "NO_CHICKEN" ? "No Chicken Detected · simulated" : `SIMULATED ${status.simulation.stage} · ${status.simulation.framesAnalyzed}/30 · ${status.simulation.confidence ?? "—"}%`}</p>
              )}
            </Card>
          </>
        )}
        <p role="status" className="text-sm text-muted-foreground">{message}</p>
      </main>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border bg-card p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 font-semibold tabular-nums">{value}</div>
    </div>
  );
}

/** Live camera, shown automatically; reconnects every 5 s if the stream drops. */
function CameraCard({ token, cameraOnline }: { token: string; cameraOnline: boolean }) {
  const url = useCameraUrl(token);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!failed) return;
    const timer = setTimeout(() => { setFailed(false); setAttempt((n) => n + 1); }, 5000);
    return () => clearTimeout(timer);
  }, [failed]);
  const show = cameraOnline && !!url && !failed;
  return (
    <Card className="overflow-hidden p-0">
      <div className="relative aspect-video bg-black">
        {show ? (
          <img key={attempt} src={url} alt="Live poultry house camera" className="h-full w-full object-contain" onError={() => setFailed(true)} />
        ) : (
          <div className="flex h-full items-center justify-center p-4 text-center text-sm text-white">
            {!cameraOnline ? "Camera offline" : failed ? "Stream interrupted, reconnecting…" : "Connecting…"}
          </div>
        )}
      </div>
    </Card>
  );
}
