// Safe restart / timed power-off of the Raspberry Pi (SPEC-system-power.md).
// Owner account only (the gateway answers 403 OWNER_ONLY for others).
// No extra polling: the shared snapshot shows when the Pi is back.
import { useEffect, useState } from "react";
import { Card, CardTitle } from "@/components/poultrix/ui";
import { piErrorMessage, piJson } from "@/lib/pi-client";
import { usePiSnapshot } from "@/lib/pi-snapshot";

const STORAGE_KEY = "poultrix_power_action";
const WAKE_MINUTES = [5, 15, 30] as const;
// The Pi needs well over this long to go down and come back, so a successful
// snapshot after it means the Pi is really back (not the last poll before shutdown).
const BACK_ONLINE_AFTER_MS = 45_000;

type PendingAction = {
  action: "reboot" | "power-off";
  at: number;
  wakeAt: string | null;
  stayOff: boolean;
};
type PowerResponse = { success: boolean; wakeAt: string | null; stayOff: boolean };

function readPending(): PendingAction | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as PendingAction) : null;
  } catch {
    return null;
  }
}

function savePending(value: PendingAction | null) {
  try {
    if (value) sessionStorage.setItem(STORAGE_KEY, JSON.stringify(value));
    else sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    /* storage unavailable */
  }
}

const timeText = (iso: string | null) =>
  iso ? new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }) : "";

export function SystemPowerCard() {
  const { snapshot, error, updatedAt } = usePiSnapshot();
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [choice, setChoice] = useState<string>("5");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => setPending(readPending()), []);

  // Clear the banner once the Pi answers again after going down.
  useEffect(() => {
    if (
      pending &&
      snapshot &&
      !error &&
      updatedAt &&
      updatedAt > pending.at + BACK_ONLINE_AFTER_MS
    ) {
      savePending(null);
      setPending(null);
      setMessage(
        pending.action === "reboot"
          ? "The system restarted and is back online."
          : "The system is back online.",
      );
    }
  }, [pending, snapshot, error, updatedAt]);

  const gates =
    (snapshot?.feedingStatus as { gates?: Record<string, { status?: string }> } | null)?.gates ??
    {};
  const dispensing = Object.values(gates).some((gate) => gate?.status === "DISPENSING");

  async function run(action: PendingAction["action"]) {
    const stayOff = action === "power-off" && choice === "stay";
    const minutes = action === "power-off" && !stayOff ? Number(choice) : null;
    const prompt =
      action === "reboot"
        ? "Restart the system now?\n\nThe site goes offline for about 2 minutes. Feeding is stopped first, and climate control pauses briefly while the Arduino restarts."
        : stayOff
          ? "Power off and STAY OFF?\n\nNothing can turn it back on remotely. Someone must press the Raspberry Pi's power button or unplug and replug it.\n\nThe Arduino is powered by the Pi: the heater and fans may stay OFF until then. Chicks may get cold or hot."
          : `Power off for ${minutes} minutes?\n\nIt turns itself back on automatically after about ${minutes} minutes.\n\nThe Arduino is powered by the Pi: the heater and fans may stay OFF until then.`;
    if (!window.confirm(prompt)) return;
    setBusy(true);
    setMessage(null);
    try {
      const body =
        action === "reboot"
          ? { confirm: "REBOOT" }
          : { confirm: "POWEROFF", minutes, ...(stayOff ? { stayOff: true } : {}) };
      const result = await piJson<PowerResponse>(
        action === "reboot" ? "/system/reboot" : "/system/power-off",
        { body },
      );
      const next: PendingAction = {
        action,
        at: Date.now(),
        wakeAt: result.wakeAt ?? null,
        stayOff: Boolean(result.stayOff),
      };
      savePending(next);
      setPending(next);
    } catch (cause) {
      setMessage(piErrorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  const banner = pending
    ? pending.action === "reboot"
      ? "Restarting… The site comes back by itself in about 2 minutes."
      : pending.stayOff
        ? "Powered off. Turn it on at the farm (Pi power button, or unplug and replug)."
        : `Powered off until about ${timeText(pending.wakeAt)}. It turns itself back on.`
    : null;

  return (
    <Card className="lg:col-span-2">
      <CardTitle>System power</CardTitle>
      <p className="text-sm text-muted-foreground">
        Restart or power off the Raspberry Pi safely. Feeding is stopped first. Only the farm
        owner's account can do this.
      </p>
      {banner && (
        <p
          role="status"
          className="mt-3 rounded-lg border border-warn/40 bg-warn/10 p-3 text-sm text-warn"
        >
          {banner}
        </p>
      )}
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button
          className="rounded-lg border px-4 py-2 text-sm font-medium disabled:opacity-40 hover:bg-muted"
          disabled={busy || dispensing || !!pending}
          onClick={() => void run("reboot")}
        >
          Restart system
        </button>
        <label className="flex items-center gap-2 text-sm">
          <span className="text-muted-foreground">Power off</span>
          <select
            className="rounded-lg border bg-background px-2 py-2 text-sm"
            value={choice}
            onChange={(event) => setChoice(event.target.value)}
            disabled={busy || !!pending}
          >
            {WAKE_MINUTES.map((value) => (
              <option key={value} value={String(value)}>
                for {value} minutes
              </option>
            ))}
            <option value="stay">and stay off</option>
          </select>
        </label>
        <button
          className="rounded-lg border border-danger/50 px-4 py-2 text-sm font-medium text-danger disabled:opacity-40 hover:bg-danger/10"
          disabled={busy || dispensing || !!pending}
          onClick={() => void run("power-off")}
        >
          Power off
        </button>
      </div>
      {dispensing && (
        <p className="mt-2 text-xs text-muted-foreground">
          Unavailable while feed is being dispensed.
        </p>
      )}
      <p className="mt-3 text-xs text-muted-foreground">
        The Arduino is powered by the Raspberry Pi, so the heater and fans may stop while the Pi is
        off. Keep power-offs short.
      </p>
      {message && <p className="mt-2 text-sm">{message}</p>}
    </Card>
  );
}
