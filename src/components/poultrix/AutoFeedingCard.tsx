// Automatic feeding (SPEC-auto-feeding A4): owner switch, next session and
// today's sessions with reasons. Data from /api/pi/feeding/sessions (30 s).
import { useState } from "react";
import { Card, CardTitle, Pill } from "@/components/poultrix/ui";
import { piErrorMessage, piJson } from "@/lib/pi-client";
import { usePiResource } from "@/lib/live-endpoints";
import { reasonText, type FeedingSessionRecord } from "@/lib/feeding-reasons";

type AutomaticStatus = {
  enabled: boolean;
  commissioned: boolean;
  active: boolean;
  lockedReason: string | null;
  disabledReason: string | null;
  targetGrams: number | null;
  times: string[];
  next: string | null;
  today: FeedingSessionRecord[];
  faultStreak: number;
  fullMarginGrams: number;
};

const RESULT_LABEL: Record<FeedingSessionRecord["result"], string> = {
  dispensed: "Fed",
  partial: "Fed (partial)",
  skipped: "Skipped",
  missed: "Missed",
  fault: "Fault",
};

const grams = (value: number | null | undefined) =>
  typeof value === "number" ? `${Math.round(value)} g` : "—";

export function AutoFeedingCard() {
  const { data, error, reload } = usePiResource<AutomaticStatus>("/feeding/sessions", 30_000);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function setEnabled(enabled: boolean) {
    const prompt = enabled
      ? "Turn automatic feeding ON?\n\nAt each session time the Pi dispenses the full session amount for the confirmed stage, unless the trough is clearly full."
      : "Turn automatic feeding OFF?";
    if (!window.confirm(prompt)) return;
    setBusy(true);
    setMessage(null);
    try {
      await piJson("/feeding/automatic", { body: { enabled } });
      reload();
    } catch (cause) {
      setMessage(piErrorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  const state = !data
    ? null
    : data.lockedReason
      ? { tone: "neutral" as const, text: "Locked" }
      : data.active
        ? { tone: "ok" as const, text: "On" }
        : { tone: "warn" as const, text: "Off" };

  return (
    <Card>
      <CardTitle {...(state ? { right: <Pill tone={state.tone}>{state.text}</Pill> } : {})}>
        Automatic feeding
      </CardTitle>
      {error && <p className="text-sm text-danger">{error}</p>}
      {data && (
        <>
          <p className="text-sm text-muted-foreground">
            {data.lockedReason
              ? "Locked until the supervised feeding test is passed on the farm."
              : data.active
                ? `Each session dispenses the full amount (${grams(data.targetGrams)}) unless the trough already holds more than ${grams((data.targetGrams ?? 0) + data.fullMarginGrams)}.`
                : data.disabledReason
                  ? `Off: ${reasonText(data.disabledReason)}.`
                  : "Off."}
          </p>
          <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
            <div className="rounded-lg bg-surface p-3">
              <p className="text-xs text-muted-foreground">Session amount</p>
              <p className="mt-1 font-semibold">{grams(data.targetGrams)}</p>
            </div>
            <div className="rounded-lg bg-surface p-3">
              <p className="text-xs text-muted-foreground">Times</p>
              <p className="mt-1 font-semibold">{data.times.join(" · ") || "—"}</p>
            </div>
            <div className="rounded-lg bg-surface p-3">
              <p className="text-xs text-muted-foreground">Next session</p>
              <p className="mt-1 font-semibold">
                {data.active && data.next
                  ? new Date(data.next).toLocaleString(undefined, {
                      weekday: "short",
                      hour: "2-digit",
                      minute: "2-digit",
                    })
                  : "—"}
              </p>
            </div>
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            {data.enabled ? (
              <button
                className="rounded-lg border px-4 py-2 text-sm font-medium disabled:opacity-40 hover:bg-muted"
                disabled={busy}
                onClick={() => void setEnabled(false)}
              >
                Turn off
              </button>
            ) : (
              <button
                className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-40"
                disabled={busy || !!data.lockedReason}
                onClick={() => void setEnabled(true)}
              >
                Turn on
              </button>
            )}
          </div>
          {message && <p className="mt-2 text-sm">{message}</p>}
          <h3 className="mt-5 text-sm font-semibold">Today</h3>
          {data.today.length === 0 ? (
            <p className="mt-1 text-sm text-muted-foreground">No sessions yet today.</p>
          ) : (
            <ul className="mt-2 divide-y text-sm">
              {data.today.map((session) => (
                <li
                  key={`${session.date}-${session.time}`}
                  className="flex flex-wrap items-baseline justify-between gap-2 py-2"
                >
                  <span className="font-medium tabular-nums">{session.time}</span>
                  <span
                    className={
                      session.result === "fault"
                        ? "text-danger"
                        : session.result === "skipped" || session.result === "missed"
                          ? "text-muted-foreground"
                          : ""
                    }
                  >
                    {RESULT_LABEL[session.result]}
                    {session.dispensedGrams ? ` ${grams(session.dispensedGrams)}` : ""}
                  </span>
                  <span className="w-full text-xs text-muted-foreground sm:w-auto">
                    {[
                      reasonText(session.reason),
                      session.check === "low_rise"
                        ? "trough barely rose: check the hopper and gate"
                        : "",
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </Card>
  );
}
