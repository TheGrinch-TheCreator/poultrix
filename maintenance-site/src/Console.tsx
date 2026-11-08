import { useEffect, useState } from "react";
import { Card, CardTitle, Pill } from "@/components/poultrix/ui";
import poultrixLogo from "@/assets/poultrix-logo.png";
import { piRequest, SESSION_KEY, sessionExpired, useCameraUrl, usePoll } from "./pi";
import type { AI, StageSchedule } from "@/lib/live-hardware";

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
  schedule?: StageSchedule;
  manualStageHistory?: { at: string; from: string | null; to: string }[];
  trough?: {
    raw: number | null; zeroRaw: number | null; countsPerGram: number | null; zeroAt: string | null; checkedAt: string | null;
    commissioned: boolean; grams: number | null; reading: { valid: boolean; grams: number | null; reason: string | null };
  };
};
const STAGES = ["STARTER", "GROWER", "FINISHER"] as const;
const title = (stage: string | null | undefined) => (stage ? stage.charAt(0) + stage.slice(1).toLowerCase() : "—");
type Snapshot = {
  status?: {
    connected?: boolean; piSeenByArduino?: boolean | null; operatingStatus?: string; stage?: string;
    temperature?: number | null; humidity?: number | null; fansOn?: number; heatersOn?: number; led?: boolean;
    camera?: { connected?: boolean };
  } | null;
  ai?: AI | null;
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

  async function confirmStage(target: (typeof STAGES)[number]) {
    if (!window.confirm(`Set the house to ${title(target)}? Temperature and lighting change immediately.`)) return;
    setBusy(true);
    try {
      const result = await call<{ changed?: boolean; previous?: string | null }>("confirm-stage", { stage: target });
      setMessage(result.changed ? `Stage set to ${title(target)} (was ${title(result.previous)}). The Arduino confirmed it.` : `The house is already on ${title(target)}.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
      if (sessionExpired(error)) clearSession();
    } finally { setBusy(false); }
  }

  async function troughStep(step: "trough-zero" | "trough-check") {
    const prompt = step === "trough-zero"
      ? "Zero the trough?\n\nThe trough must be EMPTY and still. This takes about 20 seconds."
      : "Check with the 500 g weight?\n\nPut the 500 g weight in the otherwise empty trough and keep it still. This takes about 20 seconds.";
    if (!window.confirm(prompt)) return;
    setBusy(true);
    setMessage(step === "trough-zero" ? "Zeroing the trough… keep it still (about 20 s)." : "Checking 500 g… keep it still (about 20 s).");
    try {
      const result = await call<{ zeroRaw?: number; countsPerGram?: number; spreadCounts?: number }>(step, step === "trough-check" ? { grams: 500 } : {});
      setMessage(step === "trough-zero"
        ? `Trough zeroed (raw ${result.zeroRaw}, spread ${result.spreadCounts} counts). Now put the 500 g weight in and press Check 500 g.`
        : `Trough calibrated: ${result.countsPerGram} counts/g. Remove the weight; the empty trough should read about 0 g.`);
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
              <p className="my-2 text-xs text-muted-foreground">Entering maintenance changes nothing: everything keeps running automatically. An output you switch here (fans, LED, heater relay D28 / IN7) stays manual until you exit, use Return to automatic, or the 10 s safety timeout expires. Each switch needs the Arduino's acknowledgement.</p>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {RELAY_NAMES.map((name, i) => (
                  <button key={name} className={btn} disabled={busy || !relayReady || !active} onClick={() => void toggleRelay(i + 1)}>{name}: {relayState[i + 1] ? "ON" : "OFF"}</button>
                ))}
              </div>
            </Card>

            <Card>
              <CardTitle>Sensor test readings</CardTitle>
              <p className="my-2 text-xs text-muted-foreground">Temperature test values drive the fan relays; LDR raw values drive the LED relay. Values fluctuate every 2 s around what you enter. Test values show only on this site (temperature and hopper also on the LCD); the main app keeps showing real readings. Simulations never turn on the heater.</p>
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
              <CardTitle>Confirm real stage</CardTitle>
              {(() => {
                const schedule = status?.schedule;
                const current = hw?.stage?.toUpperCase() ?? null;
                return (
                  <>
                    <p className="my-2 text-sm">
                      {schedule?.batchDay ? `Day ${schedule.batchDay}` : "No batch start date"} · current stage <span className="font-semibold">{title(current)}</span>
                      {schedule?.nextCheckAt ? ` · next AI check ${new Date(schedule.nextCheckAt).toLocaleString()}` : ""}
                    </p>
                    {schedule && schedule.overdueDays > 0 && (
                      <p className="mb-2 text-sm text-warn">{title(schedule.overdueStage)} not confirmed by the AI for {schedule.overdueDays} day{schedule.overdueDays === 1 ? "" : "s"}.</p>
                    )}
                    <p className="mb-3 text-xs text-muted-foreground">Sets the real stage on the Arduino (any stage, also backwards). The app shows it as the confirmed stage. The AI then continues from this stage, forward only.</p>
                    <div className="flex flex-wrap gap-2">
                      {STAGES.map((value) => (
                        <button key={value} className={btn} disabled={busy || current === value} onClick={() => void confirmStage(value)}>
                          {current === value ? `${title(value)} (current)` : `Set ${title(value)}`}
                        </button>
                      ))}
                      <button className={btn} disabled={busy || !active} onClick={() => void perform("analyse-real")}>Analyse real stage (camera check)</button>
                    </div>
                    {(() => {
                      // The real AI result, always (the main app shows a detection only when it agrees with the confirmed stage).
                      const ai = snapshot?.ai;
                      const votes = ai?.votes ?? {};
                      const last = schedule?.lastAttempt;
                      return (
                        <div className="mt-4 rounded-lg border p-3 text-sm">
                          <p className="font-semibold">Real AI detection</p>
                          <p className="mt-1">
                            {ai?.detectedStage ? `${title(ai.detectedStage.toUpperCase())}${typeof ai.confidence === "number" ? ` · ${ai.confidence.toFixed(1)}%` : ""}` : "No result yet"}
                            {ai?.lastInference ? ` · ${new Date(ai.lastInference).toLocaleString()}` : ""}
                            {ai?.cycleRunning ? " · analysing now" : ""}
                          </p>
                          <p className="mt-1 text-xs text-muted-foreground">
                            Votes: Starter {votes["Starter"] ?? 0} · Grower {votes["Grower"] ?? 0} · Finisher {votes["Finisher"] ?? 0}
                            {ai?.transitionStatus ? ` · status ${ai.transitionStatus.replaceAll("_", " ")}` : ""}
                            {ai?.transitionStatus === "pending" ? ` (${ai.transitionConfirmations ?? 0}/${ai.transitionRequired ?? 3}${ai.transitionCandidate ? `, candidate ${title(ai.transitionCandidate)}` : ""})` : ""}
                          </p>
                          {last && (
                            <p className="mt-1 text-xs text-muted-foreground">
                              Last daily check {last.date}: {last.result.replaceAll("_", " ")} after {last.cycles} checks, last seen {last.detectedStage ? `${title(last.detectedStage)}${typeof last.confidence === "number" ? ` ${last.confidence.toFixed(1)}%` : ""}` : "no clear result"}
                            </p>
                          )}
                          {ai?.detectedStage && current && ai.detectedStage.toUpperCase() !== current && (
                            <p className="mt-1 text-xs text-warn">Differs from the confirmed stage, so the main app shows "—" for the AI detection.</p>
                          )}
                        </div>
                      );
                    })()}
                    {!!status?.manualStageHistory?.length && (
                      <ul className="mt-3 space-y-1 text-xs text-muted-foreground">
                        {status.manualStageHistory.slice().reverse().map((entry) => (
                          <li key={entry.at}>{new Date(entry.at).toLocaleString()}: {title(entry.from)} → {title(entry.to)} (set here)</li>
                        ))}
                      </ul>
                    )}
                  </>
                );
              })()}
            </Card>

            <Card>
              <CardTitle>Trough scale</CardTitle>
              {(() => {
                const trough = status?.trough;
                const reasons: Record<string, string> = { too_few_samples: "not enough readings", stale: "readings stopped", unstable: "unstable (moving more than 25 g)", negative: "below zero (zero it again)", not_commissioned: "not calibrated yet" };
                return (
                  <>
                    <p className="my-2 text-sm">
                      {trough?.commissioned ? <>Calibrated · <span className="font-semibold tabular-nums">{trough.grams ?? "—"} g</span></> : "Not calibrated"}
                      {" · raw "}<span className="tabular-nums">{trough?.raw ?? "—"}</span>
                    </p>
                    <p className="mb-2 text-xs text-muted-foreground">
                      Reading for automatic feeding: {trough?.reading?.valid ? `OK (${trough.reading.grams} g)` : reasons[trough?.reading?.reason ?? ""] ?? "unavailable"}
                      {trough?.checkedAt ? ` · calibrated ${new Date(trough.checkedAt).toLocaleString()} (${trough.countsPerGram} counts/g)` : ""}
                    </p>
                    <ol className="mb-3 list-decimal pl-5 text-xs text-muted-foreground">
                      <li>Empty the trough, then press <span className="font-semibold">Zero trough</span>.</li>
                      <li>Put the 500 g weight in, then press <span className="font-semibold">Check 500 g</span>.</li>
                      <li>Remove the weight: the empty trough should stay within 25 g of 0.</li>
                    </ol>
                    <div className="flex flex-wrap gap-2">
                      <button className={btn} disabled={busy} onClick={() => void troughStep("trough-zero")}>Zero trough</button>
                      <button className={btn} disabled={busy || !trough?.zeroRaw} onClick={() => void troughStep("trough-check")}>Check 500 g</button>
                    </div>
                  </>
                );
              })()}
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
