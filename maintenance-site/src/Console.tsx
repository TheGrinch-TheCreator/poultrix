import { useEffect, useState } from "react";
import { Card, CardTitle, Pill } from "@/components/poultrix/ui";
import { LiveVideoPlayer } from "@/components/poultrix/LiveVideoPlayer";
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
  manualStageHistory?: { at: string; from: string | null; to: string | null; stage?: string; votes?: number; counts?: Record<string, number>; confidence?: number | null; confirmations?: number; required?: number; result?: string; error?: string | null }[];
  stagePreset?: { stage: string; votes: number; counts?: Record<string, number>; confidence: number | null; setAt: string; by: string } | null;
  stageSession?: { id: number; status: string; stage: string | null; votes: number | null; submitted: number; confirmations?: number; required?: number; result: string | null; error: string | null; startedAt: string | null; finishedAt: string | null };
  trough?: {
    raw: number | null; zeroRaw: number | null; countsPerGram: number | null; zeroAt: string | null; checkedAt: string | null;
    commissioned: boolean; grams: number | null; reading: { valid: boolean; grams: number | null; reason: string | null };
  };
};
const STAGES = ["STARTER", "GROWER", "FINISHER"] as const;
// Must match raspberry-pi/ai_votes.py (SIM_VOTES_MIN / SIM_VOTES_MAX / SIM_VOTES_DEFAULT).
const VOTES_MIN = 1;
const VOTES_MAX = 300;
const VOTES_DEFAULT = 30;
const MIN_VALID_VOTES = 10; // AI_MIN_VALID_FRAMES on the Pi
const SESSION_TEXT: Record<string, string> = {
  starting: "Starting…", voting: "Voting", applying: "Sending the stage to the Arduino…",
  pending: "Counted, stage not changed yet", applied: "Stage applied", unchanged: "Stage already matched", not_confirmed: "Not confirmed (too few votes)",
  failed: "Failed", cancelled: "Cancelled",
};
// Optional preset confidence: blank (none) or above 0 and at most 100 (raspberry-pi/ai_votes.py parse_confidence).
const MIN_CONFIDENCE = 60; // AI_MIN_CONFIDENCE on the Pi
const validConfidence = (value: string) => value.trim() === "" || (Number.isFinite(Number(value)) && Number(value) > 0 && Number(value) <= 100);
const pct = (value: number | null | undefined) => (typeof value === "number" ? `${value.toFixed(1)}%` : "no confidence");
const title = (stage: string | null | undefined) => (stage ? stage.charAt(0) + stage.slice(1).toLowerCase() : "—");
const MIN_WINNING_SHARE = 0.6; // AI_MIN_WINNING_VOTE_FRACTION on the Pi
type StageKey = (typeof STAGES)[number];
type VoteCounts = Record<StageKey, number>;
// Saved presets live in this browser (owner, 2026-11-26); "Use" stores one on the Pi.
type SavedPreset = { id: string; name: string; counts: VoteCounts; confidence: number | null };
const PRESETS_KEY = "poultrix-maintenance-stage-presets";
const wholeOrBlank = (value: string) => value.trim() === "" || /^\d+$/.test(value.trim());
const countsOf = (text: Record<StageKey, string>): VoteCounts =>
  ({ STARTER: Number(text.STARTER || 0), GROWER: Number(text.GROWER || 0), FINISHER: Number(text.FINISHER || 0) });
// Same rules as raspberry-pi/ai_votes.py parse_vote_counts: total 1–300, one clear top stage.
function judgeCounts(counts: VoteCounts) {
  const total = STAGES.reduce((sum, stage) => sum + counts[stage], 0);
  const top = Math.max(...STAGES.map((stage) => counts[stage]));
  const leaders = STAGES.filter((stage) => counts[stage] === top);
  const error = total < VOTES_MIN || total > VOTES_MAX ? `Total votes must be ${VOTES_MIN} to ${VOTES_MAX}.`
    : leaders.length !== 1 ? "Two stages have the most votes; give one stage more votes." : null;
  return { total, winner: leaders.length === 1 ? leaders[0] : null, share: total ? top / total : 0, error };
}
// Pi results use "Starter" keys, saved presets use "STARTER".
const countOf = (counts: Partial<Record<string, number>> | undefined, stage: StageKey) => counts?.[stage] ?? counts?.[title(stage)] ?? 0;
const countsText = (counts: Partial<Record<string, number>> | undefined) =>
  STAGES.map((stage) => `${title(stage)} ${countOf(counts, stage)}`).join(" · ");
const sameCounts = (a: Partial<Record<string, number>> | undefined, b: VoteCounts) =>
  !!a && STAGES.every((stage) => countOf(a, stage) === b[stage]);
function loadPresets(): SavedPreset[] {
  try {
    const value = JSON.parse(localStorage.getItem(PRESETS_KEY) || "[]");
    return Array.isArray(value) ? value : [];
  } catch { return []; }
}
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
  const [countText, setCountText] = useState<Record<StageKey, string>>({ STARTER: "0", GROWER: String(VOTES_DEFAULT), FINISHER: "0" });
  const [confidenceText, setConfidenceText] = useState("");
  const [presetName, setPresetName] = useState("");
  const [saved, setSaved] = useState<SavedPreset[]>(loadPresets);
  function storePresets(next: SavedPreset[]) {
    setSaved(next);
    try { localStorage.setItem(PRESETS_KEY, JSON.stringify(next)); } catch { /* storage unavailable */ }
  }

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
      const result = await call<{ action?: string; group?: number; hole?: number; durationMs?: number; simulation?: boolean }>(path, body);
      if (path === "return-live") setMessage("Overrides cleared; the Arduino is back under automatic control. Maintenance stays unlocked.");
      else if (path === "resume") setMessage("Manual bypass resumed.");
      else if (path === "exit") clearSession("Bypass ended. Gates closed and the Arduino is under automatic control.");
      else if (result.action === "hole") setMessage(`Arduino acknowledged compartment ${result.group}, hole ${result.hole} for ${Number(result.durationMs) / 1000}s. Weigh what you caught.`);
      else if (result.action === "dispense") setMessage(`Arduino acknowledged compartment ${result.group} for ${Number(result.durationMs) / 1000}s. Check the gate on the camera.`);
      else if (result.simulation) setMessage("Test value saved. Fan/LED responses (when applicable) were acknowledged; real sensors and calibration unchanged.");
      else setMessage("Command accepted by the Raspberry Pi. Check the hardware on the camera.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
      if (sessionExpired(error)) clearSession();
    } finally { setBusy(false); }
  }

  // Stores a preset on the Pi (null clears it): the app's next Camera checks vote with it.
  async function savePreset(preset: { counts: VoteCounts; confidence: number | null; name?: string } | null) {
    const winner = preset ? judgeCounts(preset.counts) : null;
    if (winner?.error) { setMessage(winner.error); return; }
    setBusy(true);
    try {
      await call("stage-preset", preset ? { votes: preset.counts, confidence: preset.confidence } : { clear: true });
      setMessage(preset
        ? `Preset ${preset.name ? `"${preset.name}" ` : ""}set: ${countsText(preset.counts)}, ${pct(preset.confidence)}. Press Camera check in the app; the votes arrive in a random order and ${title(winner?.winner)} has the most.`
        : "Preset cleared. Camera checks in the app use the camera again.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
      if (sessionExpired(error)) clearSession();
    } finally { setBusy(false); }
  }

  const [countdown, setCountdown] = useState(0);
  async function troughStep(step: "trough-zero" | "trough-check") {
    const prompt = step === "trough-zero"
      ? "Zero the trough?\n\nThe trough must be EMPTY and still. This takes about 20 seconds."
      : "Check with the 500 g weight?\n\nPut the 500 g weight in the otherwise empty trough and keep it still. This takes about 20 seconds.";
    if (!window.confirm(prompt)) return;
    setBusy(true);
    setMessage(step === "trough-zero" ? "Zeroing the trough… keep it still." : "Checking 500 g… keep it still.");
    // Ten readings arrive every 2 s: show a countdown while the Pi measures.
    setCountdown(20);
    const timer = setInterval(() => setCountdown((value) => Math.max(0, value - 1)), 1000);
    try {
      const result = await call<{ zeroRaw?: number; countsPerGram?: number; spreadCounts?: number }>(step, step === "trough-check" ? { grams: 500 } : {});
      setMessage(step === "trough-zero"
        ? `Trough zeroed (raw ${result.zeroRaw}, spread ${result.spreadCounts} counts). Now put the 500 g weight in and press Check 500 g.`
        : `Trough calibrated: ${result.countsPerGram} counts/g. Remove the weight; the empty trough should read about 0 g.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
      if (sessionExpired(error)) clearSession();
    } finally { clearInterval(timer); setCountdown(0); setBusy(false); }
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
                    <p className="mt-3 text-xs text-muted-foreground">Or one hole at a time (catch and weigh each):</p>
                    <div className="mt-1 grid grid-cols-5 gap-1">
                      {[1, 2, 3, 4, 5].map((hole) => (
                        <button
                          key={hole}
                          className={btn + " px-0"}
                          disabled={busy || !active || !Number.isFinite(Number(seconds)) || Number(seconds) < 0.1 || Number(seconds) > 10}
                          onClick={() => { if (window.confirm(`Open only hole ${hole} of compartment ${group} for ${seconds} s? Hold your container under it.`)) void perform("action", { action: "hole", group, hole, seconds: Number(seconds) }); }}
                        >Hole {hole}</button>
                      ))}
                    </div>
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
                    <p className="mb-3 text-xs text-muted-foreground">Set how many votes each stage gets (the stage with the most is the one the vote confirms), or save presets and press Use. While maintenance is unlocked, each Camera check on the app's AI Growth Stage page runs the same 30-second AI vote with these votes instead of the camera, submitted in a random order, and the app shows the result as an AI result. Like the daily AI check, the stage changes only after 3 confident checks in a row for the same new stage (any stage, also backwards); the 3rd check sets it on the Arduino when its 30 seconds end. The preset ends when you clear it, Return to automatic, Exit, or the session expires. Daily AI checks and Analyse real stage always use the camera. Test votes are recorded as simulated; no camera image or confidence is created.</p>
                    {(() => {
                      const session = status?.stageSession;
                      const running = !!session && ["starting", "voting", "applying"].includes(session.status);
                      return (
                        <>
                          {(() => {
                            const counts = countsOf(countText);
                            const countsValid = STAGES.every((stage) => wholeOrBlank(countText[stage]));
                            const check = judgeCounts(counts);
                            const ready = countsValid && !check.error && validConfidence(confidenceText);
                            const confidence = confidenceText.trim() === "" ? null : Number(confidenceText);
                            return (
                              <>
                                <div className="mb-2 grid max-w-md grid-cols-3 gap-2">
                                  {STAGES.map((stage) => (
                                    <label key={stage} className="block text-sm">{title(stage)} votes
                                      <input type="number" min="0" max={VOTES_MAX} step="1" className={inputClass + " mt-1"} value={countText[stage]}
                                        onChange={(event) => setCountText((prev) => ({ ...prev, [stage]: event.target.value }))} />
                                    </label>
                                  ))}
                                </div>
                                {!countsValid
                                  ? <p className="mb-2 text-xs text-danger">Votes must be whole numbers (0 or more).</p>
                                  : check.error
                                    ? <p className="mb-2 text-xs text-danger">{check.error}</p>
                                    : <p className="mb-2 text-xs text-muted-foreground">Total {check.total} votes, submitted in a random order · {title(check.winner)} has the most ({Math.round(check.share * 100)}%).</p>}
                                {countsValid && !check.error && check.total < MIN_VALID_VOTES && <p className="mb-2 text-xs text-warn">Fewer than {MIN_VALID_VOTES} votes never confirms a stage (same rule as the camera).</p>}
                                {countsValid && !check.error && check.share < MIN_WINNING_SHARE && <p className="mb-2 text-xs text-warn">{title(check.winner)} has under {MIN_WINNING_SHARE * 100}% of the votes: the result is low confidence and never confirms a stage (same rule as the camera).</p>}
                                <label className="mb-3 block max-w-xs text-sm">Confidence % (optional, above 0 to 100)
                                  <input type="number" min="0.1" max="100" step="0.1" placeholder="none" className={inputClass + " mt-1"} value={confidenceText} onChange={(event) => setConfidenceText(event.target.value)} />
                                </label>
                                {!validConfidence(confidenceText) && <p className="mb-2 text-xs text-danger">Enter a number above 0 and at most 100, or leave it blank.</p>}
                                {validConfidence(confidenceText) && confidenceText.trim() !== "" && Number(confidenceText) < MIN_CONFIDENCE && <p className="mb-2 text-xs text-warn">Below {MIN_CONFIDENCE}% the result is low confidence and never confirms a stage (same rule as the camera).</p>}
                                <div className="mb-3 flex flex-wrap items-end gap-2">
                                  <label className="block text-sm">Preset name
                                    <input className={inputClass + " mt-1"} placeholder={check.winner ? `${title(check.winner)} ${check.total}` : "name"} maxLength={40} value={presetName} onChange={(event) => setPresetName(event.target.value)} />
                                  </label>
                                  <button className={btn} disabled={busy || !ready} onClick={() => {
                                    const name = presetName.trim() || `${title(check.winner)} ${check.total}${confidence != null ? ` @ ${confidence}%` : ""}`;
                                    storePresets([...saved, { id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, name, counts, confidence }]);
                                    setPresetName("");
                                    setMessage(`Saved preset "${name}". Press Use to set it.`);
                                  }}>Save as preset</button>
                                  <button className={btn} disabled={busy || !active || running || !ready} onClick={() => void savePreset({ counts, confidence })}>Use these votes now</button>
                                </div>
                              </>
                            );
                          })()}
                          {saved.length > 0 && (
                            <ul className="mb-3 space-y-2">
                              {saved.map((preset) => {
                                const inUse = !!status?.stagePreset && sameCounts(status.stagePreset.counts, preset.counts) && (status.stagePreset.confidence ?? null) === preset.confidence;
                                return (
                                  <li key={preset.id} className={`flex flex-wrap items-center gap-2 rounded-lg border p-2 text-sm ${inUse ? "border-primary" : ""}`}>
                                    <span className="font-semibold">{preset.name}</span>
                                    <span className="text-xs text-muted-foreground">{countsText(preset.counts)} · {pct(preset.confidence)}</span>
                                    {inUse && <Pill tone="ok">in use</Pill>}
                                    <span className="ml-auto flex gap-2">
                                      <button className={btn} disabled={busy || !active || running} onClick={() => void savePreset(preset)}>Use</button>
                                      <button className={btn} disabled={busy} onClick={() => {
                                        setCountText({ STARTER: String(preset.counts.STARTER), GROWER: String(preset.counts.GROWER), FINISHER: String(preset.counts.FINISHER) });
                                        setConfidenceText(preset.confidence == null ? "" : String(preset.confidence));
                                        setPresetName(preset.name);
                                      }}>Load</button>
                                      <button className={btn} disabled={busy} onClick={() => { if (window.confirm(`Delete preset "${preset.name}"?`)) storePresets(saved.filter((item) => item.id !== preset.id)); }}>Delete</button>
                                    </span>
                                  </li>
                                );
                              })}
                            </ul>
                          )}
                          <p className="mb-3 text-sm">
                            {status?.stagePreset
                              ? <>Stored preset: <span className="font-semibold">{title(status.stagePreset.stage)} most · {status.stagePreset.counts ? countsText(status.stagePreset.counts) : `${status.stagePreset.votes} votes`} · {pct(status.stagePreset.confidence)}</span> (used by the next Camera check in the app)</>
                              : "No preset stored: Camera checks in the app use the camera."}
                          </p>
                          {session && session.status !== "idle" && (
                            <p role="status" className="mb-3 text-sm">
                              <span className="font-semibold">{SESSION_TEXT[session.status] ?? session.status}</span>
                              {" · "}{title(session.stage)} · <span className="tabular-nums">{session.submitted}/{session.votes ?? "—"}</span> votes
                              {session.result && session.required ? ` · confirmation ${session.confirmations ?? 0}/${session.required}` : ""}
                              {session.error ? ` · ${session.error}` : ""}
                            </p>
                          )}
                          <div className="flex flex-wrap gap-2">
                            <button className={btn} disabled={busy || !status?.stagePreset} onClick={() => void savePreset(null)}>Clear preset</button>
                            <button className={btn} disabled={busy || running || !active} onClick={() => void perform("analyse-real")}>Analyse real stage (camera check)</button>
                          </div>
                        </>
                      );
                    })()}
                    {(() => {
                      // The real AI result, always (the main app shows a detection only when it agrees with the confirmed stage).
                      const ai = snapshot?.ai;
                      const votes = ai?.votes ?? {};
                      const last = schedule?.lastAttempt;
                      return (
                        <div className="mt-4 rounded-lg border p-3 text-sm">
                          <p className="font-semibold">{ai?.source === "bypass_simulation" ? "AI vote result (test votes from this site)" : "Real AI detection"}</p>
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
                          <li key={entry.at}>
                            {new Date(entry.at).toLocaleString()}: {entry.votes != null
                              ? `${entry.counts ? `${countsText(entry.counts)} test votes (${title(entry.stage)} most)` : `${entry.votes} test votes for ${title(entry.stage)}`}${entry.confidence != null ? ` at ${pct(entry.confidence)}` : ""} · ${SESSION_TEXT[entry.result ?? ""] ?? entry.result ?? "—"}${entry.required ? ` (${entry.confirmations ?? 0}/${entry.required})` : ""}${entry.result === "applied" ? ` (${title(entry.from)} → ${title(entry.to)})` : ""}${entry.error ? ` · ${entry.error}` : ""}`
                              : `${title(entry.from)} → ${title(entry.to)} (set here)`}
                          </li>
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
                const reasons: Record<string, string> = { too_few_samples: "not enough readings", stale: "readings stopped", unstable: "unstable (noise more than ±25 g)", negative: "below zero (zero it again)", not_commissioned: "not calibrated yet" };
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
                    {countdown > 0 && (
                      <p role="status" className="mt-3 text-sm font-semibold">
                        Measuring… keep the trough still: <span className="tabular-nums">{countdown}</span> s
                      </p>
                    )}
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

/** Live camera, shown automatically: smooth 15 fps H.264 video (same player
 *  as the main app), or the picture stream on browsers without MSE. */
function CameraCard({ token, cameraOnline }: { token: string; cameraOnline: boolean }) {
  return (
    <Card className="overflow-hidden p-0">
      <div className="relative aspect-video bg-black">
        <LiveVideoPlayer
          enabled={cameraOnline && !!token}
          alt="Live poultry house camera"
          className="h-full w-full object-contain"
          openStream={(signal) =>
            fetch("/api/pi/camera/live", {
              signal,
              cache: "no-store",
              headers: { "x-poultrix-maintenance": token },
            })
          }
          fallback={<PictureCamera token={token} cameraOnline={cameraOnline} />}
        />
      </div>
    </Card>
  );
}

/** Picture stream (MJPEG); reconnects every 5 s if the stream drops. */
function PictureCamera({ token, cameraOnline }: { token: string; cameraOnline: boolean }) {
  const url = useCameraUrl(token);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!failed) return;
    const timer = setTimeout(() => { setFailed(false); setAttempt((n) => n + 1); }, 5000);
    return () => clearTimeout(timer);
  }, [failed]);
  const show = cameraOnline && !!url && !failed;
  return show ? (
    <img key={attempt} src={url} alt="Live poultry house camera" className="h-full w-full object-contain" onError={() => setFailed(true)} />
  ) : (
    <div className="flex h-full items-center justify-center p-4 text-center text-sm text-white">
      {!cameraOnline ? "Camera offline" : failed ? "Stream interrupted, reconnecting…" : "Connecting…"}
    </div>
  );
}
