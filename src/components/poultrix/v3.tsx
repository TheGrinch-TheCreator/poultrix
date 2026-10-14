import { useEffect, useState, useSyncExternalStore } from "react";
import { AlertTriangle, Clock, Moon, PackageCheck, ScanEye } from "lucide-react";
import { FEED_TYPES, farm, feed, stageInfo, type FeedType, type Stage } from "@/lib/demo-data";
import { Card, CardTitle, Meter, Pill, type Tone } from "./ui";

// Demo client-side state shared between pages (replace with Pi feed later).
type Comp = { type: FeedType; kg: number; filled: number };
type State = {
  comps: [Comp, Comp];
  counter: number; // transition counter 0-3
  candidate: Stage;
  hold: boolean;
  nightPause: boolean;
  discrepancyG: number;
  acked: string[]; // acknowledged (dismissed) alert ids
};
let state: State = {
  comps: [
    { type: "Grower Pellet", kg: 1.9, filled: 5 },
    { type: "Grower Pellet", kg: 2.3, filled: 5 },
  ],
  counter: 1,
  candidate: "Finisher",
  hold: false,
  nightPause: false,
  discrepancyG: 140,
  acked: [],
};
const subs = new Set<() => void>();
function set(p: Partial<State>) {
  state = { ...state, ...p };
  subs.forEach((f) => f());
}
export function usePx() {
  return useSyncExternalStore(
    (f) => (subs.add(f), () => subs.delete(f)),
    () => state,
    () => state,
  );
}
export const pxActions = {
  setCounter(n: number) {
    set({ counter: n, hold: n >= 3 && state.candidate === "Finisher" });
  },
  toggleNight() {
    set({ nightPause: !state.nightPause });
  },
  declare(comps: [Comp, Comp]) {
    set({ comps, hold: false, discrepancyG: 0, counter: state.counter >= 3 ? 0 : state.counter });
  },
  acknowledge(id: string) {
    if (!state.acked.includes(id)) set({ acked: [...state.acked, id] });
  },
  restoreAlert(id: string) {
    set({ acked: state.acked.filter((x) => x !== id) });
  },
};

function openDeclare() {
  if (!document.getElementById("declare-stock")) { window.location.href = "/feeding#declare-stock"; return; }
  document.getElementById("declare-stock")?.scrollIntoView({ behavior: "smooth", block: "center" });
  window.dispatchEvent(new Event("px-open-declare"));
}

/* ---------- Feeding schedule with countdown ---------- */
function nextSession(times: string[], now: Date) {
  const mins = now.getHours() * 60 + now.getMinutes();
  for (const t of times) {
    const [h = 0, m = 0] = t.split(":").map(Number);
    if (h * 60 + m > mins) return { t, diff: h * 60 + m - mins };
  }
  const [h = 0, m = 0] = (times[0] ?? "0:0").split(":").map(Number);
  return { t: times[0] ?? "", diff: 24 * 60 - mins + h * 60 + m };
}
function fmt12(t: string) {
  const [h = 0, m = 0] = t.split(":").map(Number);
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}
export function FeedSchedulePanel() {
  const s = usePx();
  const st = stageInfo(farm.stage);
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    setNow(new Date());
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  const n = now ? nextSession(st.sessions, now) : null;
  const secs = n && now ? n.diff * 60 - now.getSeconds() : 0;
  const hh = Math.floor(secs / 3600), mm = Math.floor((secs % 3600) / 60), ss = secs % 60;
  return (
    <Card>
      <CardTitle icon={<Clock className="h-4 w-4" />} right={s.hold ? <Pill tone="danger">ON HOLD</Pill> : <Pill tone="ok">Scheduled</Pill>}>Next feeding</CardTitle>
      <div className="num text-4xl font-extrabold">{n ? fmt12(n.t) : "—"}</div>
      <p className="text-sm text-muted-foreground">
        in <span className="num font-semibold text-foreground">{now ? `${hh}h ${String(mm).padStart(2, "0")}m ${String(ss).padStart(2, "0")}s` : "…"}</span> · target {feed.targetPerFeeding}g
      </p>
      <div className="mt-4 text-xs font-semibold uppercase tracking-wider text-muted-foreground">{farm.stage} · {st.sessions.length} sessions a day</div>
      <div className="mt-2 flex flex-wrap gap-2">
        {st.sessions.map((t) => (
          <span key={t} className={`rounded-full border px-3 py-1 text-sm font-semibold ${n?.t === t ? "border-primary bg-primary text-primary-foreground" : "bg-surface"}`}>{fmt12(t)}</span>
        ))}
      </div>
      <p className="mt-3 text-xs text-muted-foreground">No feeding 12 PM–3 PM peak heat (BAI guideline) · {st.perSession} per session</p>
    </Card>
  );
}

export function LeftoverNotice() {
  if (!feed.leftover.detected) return null;
  return (
    <div className="flex items-start gap-3 rounded-xl border border-info/40 bg-info-soft p-4 text-sm">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-info" />
      <span><b>Leftover feed detected</b> — session amount adjusted from {feed.leftover.from}g to {feed.leftover.to}g.</span>
    </div>
  );
}

export function MaeCard() {
  return (
    <Card>
      <CardTitle>Average feed accuracy</CardTitle>
      <div className="num text-4xl font-extrabold">±{feed.maeG}g</div>
      <p className="text-sm text-muted-foreground">MAE across {feed.sessionsCount} sessions this batch</p>
    </Card>
  );
}

/* ---------- Feed stock ---------- */
export function FeedStockPanel() {
  const s = usePx();
  const [c1, c2] = s.comps;
  const combined = c1.type === c2.type;
  const daily = 0.9; // kg/day demo
  const bar = (c: Comp) => {
    const pct = (c.kg / Math.max(c.filled, 0.1)) * 100;
    const low = c.kg * 1000 < stageOfFeed(c.type).lowStockG;
    const tone: Tone = low ? "danger" : pct < 40 ? "warn" : "ok";
    return { pct, low, tone };
  };
  return (
    <Card>
      <CardTitle icon={<PackageCheck className="h-4 w-4" />} right={<button onClick={openDeclare} className="text-xs font-semibold text-primary">Declare refill →</button>}>
        {combined ? "Feed stock" : "Feed stock — transition mode"}
      </CardTitle>
      {combined ? (
        (() => {
          const tot = { type: c1.type, kg: +(c1.kg + c2.kg).toFixed(1), filled: c1.filled + c2.filled };
          const b = bar(tot);
          return (
            <>
              <div className="font-display text-xl font-bold">{tot.type}</div>
              <div className="text-sm text-muted-foreground">Both compartments active</div>
              <div className="num mt-3 text-3xl font-bold">{tot.kg} kg <span className="text-sm text-muted-foreground">{Math.round(b.pct)}%</span></div>
              <div className="mt-2"><Meter value={b.pct} tone={b.tone} /></div>
              <p className="mt-2 text-sm text-muted-foreground">Est. days remaining: ~{Math.max(0, Math.round(tot.kg / daily))} days</p>
            </>
          );
        })()
      ) : (
        <div className="space-y-4">
          {s.comps.map((c, i) => {
            const b = bar(c);
            return (
              <div key={i}>
                <div className="flex justify-between text-sm"><span className="font-semibold">Compartment {i + 1}: {c.type}</span><span className="num">{c.kg} kg · {Math.round(b.pct)}%</span></div>
                <div className="mt-1"><Meter value={b.pct} tone={b.tone} /></div>
              </div>
            );
          })}
          <div className="rounded-lg bg-surface p-3 text-sm">Transition day 2 of 4 · Mix ratio 50% {c1.type.split(" ")[0]} : 50% {c2.type.split(" ")[0]}</div>
        </div>
      )}
      <LowStockWarnings />
      {s.discrepancyG > 100 && (
        <div className="mt-3 rounded-lg border border-warn/40 bg-warn-soft p-3 text-sm">
          <b>Stock discrepancy detected</b> ({s.discrepancyG}g difference from the load cell). Please verify compartment weights and re-declare fill amounts.
          <button onClick={openDeclare} className="mt-2 block rounded-lg bg-primary px-3 py-2 text-xs font-semibold text-primary-foreground">Re-declare Stock</button>
        </div>
      )}
      <p className="mt-3 text-[11px] text-muted-foreground">Per-compartment levels are calculated by software; one shared load cell checks the total.</p>
    </Card>
  );
}
function stageOfFeed(t: FeedType) {
  return stageInfo(t.startsWith("Starter") ? "Starter" : t.startsWith("Grower") ? "Grower" : "Finisher");
}
function LowStockWarnings() {
  const s = usePx();
  const low = s.comps.map((c, i) => ({ c, i })).filter(({ c }) => c.kg * 1000 < stageOfFeed(c.type).lowStockG);
  return (
    <>
      {low.map(({ c, i }) => (
        <div key={i} className="mt-3 rounded-lg border border-danger/40 bg-danger-soft p-3 text-sm">
          Compartment {i + 1} ({c.type}) is running low — approx. {Math.round(c.kg * 1000)}g remaining. Please refill.
        </div>
      ))}
    </>
  );
}

export function DeclarationForm() {
  const s = usePx();
  const [form, setForm] = useState(s.comps.map((c) => ({ type: c.type, kg: "" })));
  const [done, setDone] = useState(false);
  const [flash, setFlash] = useState(false);
  useEffect(() => {
    const f = () => { setFlash(true); setTimeout(() => setFlash(false), 1500); };
    window.addEventListener("px-open-declare", f);
    return () => window.removeEventListener("px-open-declare", f);
  }, []);
  const valid = form.every((f) => Number(f.kg) > 0 && Number(f.kg) <= 10);
  return (
    <Card className={flash ? "ring-4 ring-primary/40" : ""}>
      <div id="declare-stock" />
      <CardTitle>Declare refill</CardTitle>
      <p className="mb-4 text-sm text-muted-foreground">Fill this in every time you refill the feed box.</p>
      <div className="grid gap-4 sm:grid-cols-2">
        {form.map((f, i) => (
          <div key={i} className="rounded-xl border bg-surface p-4">
            <div className="font-semibold">Compartment {i + 1}</div>
            <label className="mt-3 block text-xs text-muted-foreground">Feed type</label>
            <select value={f.type} onChange={(e) => setForm(form.map((x, j) => (j === i ? { ...x, type: e.target.value as FeedType } : x)))} className="mt-1 h-12 w-full rounded-lg border bg-card px-3 text-base">
              {FEED_TYPES.map((t) => <option key={t}>{t}</option>)}
            </select>
            <label className="mt-3 block text-xs text-muted-foreground">Weight filled (kg)</label>
            <input inputMode="decimal" type="number" step="0.1" min="0" max="10" value={f.kg} onChange={(e) => setForm(form.map((x, j) => (j === i ? { ...x, kg: e.target.value } : x)))} placeholder="e.g. 5" className="mt-1 h-12 w-full rounded-lg border bg-card px-3 text-base" />
          </div>
        ))}
      </div>
      <button
        disabled={!valid}
        onClick={() => {
          pxActions.declare(form.map((f) => ({ type: f.type, kg: Number(f.kg), filled: Number(f.kg) })) as [Comp, Comp]);
          setForm(form.map((f) => ({ ...f, kg: "" })));
          setDone(true);
        }}
        className="mt-4 h-12 w-full rounded-xl bg-primary font-semibold text-primary-foreground disabled:opacity-50"
      >
        Confirm Refill
      </button>
      {done && <p className="mt-2 text-sm font-medium text-ok">Saved. Stock levels updated{!s.hold && " — feeding can continue"}.</p>}
    </Card>
  );
}

/* ---------- Classification ---------- */
export function FeedHoldAlert() {
  const s = usePx();
  if (!s.hold) return null;
  return (
    <div role="alert" className="rounded-xl border-2 border-danger bg-danger-soft p-5">
      <div className="text-xs font-bold uppercase tracking-wider text-danger">Action required</div>
      <div className="mt-1 font-display text-xl font-bold">Stage transition detected: Grower → Finisher</div>
      <p className="mt-1 text-sm">Next feeding session is <b>ON HOLD</b>. Please refill one compartment with Finisher Pellet and update the feed type declaration.</p>
      <button onClick={openDeclare} className="mt-3 h-11 rounded-xl bg-danger px-5 font-semibold text-primary-foreground">Update Feed Types</button>
    </div>
  );
}

export function TransitionIndicator() {
  const s = usePx();
  if (s.counter === 0) return null;
  const from = farm.stage;
  const msg =
    s.counter === 1 ? `Possible stage change detected (1/3)` : s.counter === 2 ? `Stage change likely (2/3 confirmed)` : `Stage transition confirmed: ${from} → ${s.candidate}`;
  const cls = s.counter === 1 ? "border-info/40 bg-info-soft" : s.counter === 2 ? "border-warn/50 bg-warn-soft" : "border-danger/50 bg-danger-soft";
  return (
    <div className={`rounded-xl border p-4 ${cls}`}>
      <div className="flex flex-wrap items-center gap-3">
        <ScanEye className="h-5 w-5" />
        <span className="font-semibold">{msg}</span>
        <span className="ml-auto flex gap-1">{[1, 2, 3].map((i) => <span key={i} className={`h-2.5 w-6 rounded-full ${i <= s.counter ? "bg-foreground/70" : "bg-foreground/15"}`} />)}</span>
      </div>
      {s.counter < 3 && <p className="mt-1 text-xs text-muted-foreground">Seeing {s.candidate}. Needs 3 checks in a row (about 15 minutes) before switching.</p>}
      {s.counter >= 3 && (
        <>
          <p className="mt-1 text-sm">
            {s.candidate === "Grower" ? "Please update compartment feed types in the app." : "Please refill one compartment with Finisher Pellet and update the app."}
          </p>
          <button onClick={openDeclare} className="mt-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground">Update Feed Types</button>
        </>
      )}
    </div>
  );
}

export function ClassificationStatus() {
  const s = usePx();
  return s.nightPause ? (
    <div className="flex items-center gap-2 rounded-lg bg-surface px-3 py-2 text-sm font-medium"><Moon className="h-4 w-4" /> Classification paused — dark period</div>
  ) : (
    <div className="text-sm text-muted-foreground">Checks every 5 minutes, plus 30 s before each feeding · Last classified: {farm.lastClassified} · Confidence: {Math.round(farm.confidence * 100)}%</div>
  );
}

export function DemoControls() {
  const s = usePx();
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-xl border border-dashed p-3 text-xs">
      <span className="font-semibold text-muted-foreground">Demo: transition counter</span>
      {[0, 1, 2, 3].map((n) => (
        <button key={n} onClick={() => pxActions.setCounter(n)} className={`rounded-full border px-3 py-1 font-semibold ${s.counter === n ? "bg-primary text-primary-foreground" : "bg-card"}`}>{n}/3</button>
      ))}
      <button onClick={pxActions.toggleNight} className="rounded-full border bg-card px-3 py-1 font-semibold">{s.nightPause ? "End" : "Start"} dark period</button>
    </div>
  );
}
