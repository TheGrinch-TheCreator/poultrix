// One shared poller for live data: a single /api/pi/snapshot request every
// 5 s while the tab is visible, paused while hidden. Every live hook reads
// from it, which keeps a tab at ~17k Worker requests/day (free plan budget).
import { useEffect, useState } from "react";
import { PiError, piJson } from "@/lib/pi-client";
import type { AI, Hardware } from "@/lib/live-hardware";
import type { WeightPayload } from "@/lib/live-weights";

export const SNAPSHOT_POLL_MS = 5000;

export type PiSnapshot = {
  status: Hardware | null;
  ai: AI | null;
  weight: WeightPayload | null;
  health: Record<string, unknown> | null;
  feedingStatus: Record<string, unknown> | null;
  errors: Record<string, string>;
  generatedAt?: string;
};

type State = { snapshot: PiSnapshot | null; error: PiError | null; updatedAt: number | null };

let state: State = { snapshot: null, error: null, updatedAt: null };
const listeners = new Set<() => void>();
let subscribers = 0;
let timer: ReturnType<typeof setInterval> | undefined;
let inFlight: Promise<void> | null = null;

function emit() {
  listeners.forEach((listener) => listener());
}

function visible(): boolean {
  return typeof document === "undefined" || document.visibilityState === "visible";
}

/** Fetch now (deduplicated). Call after an action to show its result quickly. */
export function refreshSnapshot(): Promise<void> {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const snapshot = await piJson<PiSnapshot>("/snapshot");
      state = { snapshot, error: null, updatedAt: Date.now() };
    } catch (error) {
      // Keep no stale data: an unreachable Pi must not look live.
      state = {
        snapshot: null,
        error: error instanceof PiError ? error : new PiError("Request failed", 0, "NETWORK"),
        updatedAt: Date.now(),
      };
    } finally {
      inFlight = null;
      emit();
    }
  })();
  return inFlight;
}

function start() {
  if (timer || !visible()) return;
  void refreshSnapshot();
  timer = setInterval(() => void refreshSnapshot(), SNAPSHOT_POLL_MS);
}

function stop() {
  clearInterval(timer);
  timer = undefined;
}

function onVisibility() {
  if (visible()) start();
  else stop();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  subscribers++;
  if (subscribers === 1) {
    if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVisibility);
    start();
  }
  return () => {
    listeners.delete(listener);
    subscribers--;
    if (subscribers === 0) {
      stop();
      if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisibility);
    }
  };
}

/** Subscribe a component to the shared snapshot. */
export function usePiSnapshot(): State {
  const [, setRevision] = useState(0);
  useEffect(() => subscribe(() => setRevision((value) => value + 1)), []);
  return state;
}
