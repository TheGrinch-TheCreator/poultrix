// Page-level Pi data through the authenticated gateway. Live parts come from
// the shared snapshot (no extra requests); slow-changing resources (feeding
// plan, inventory) are polled rarely, and only while the tab is visible.
import { useEffect, useState } from "react";
import { piErrorMessage, piAccessToken, piJson, PI_BASE } from "@/lib/pi-client";
import { usePiSnapshot, type PiSnapshot } from "@/lib/pi-snapshot";

const SNAPSHOT_PARTS: Record<string, keyof PiSnapshot> = {
  "/feeding/weight": "weight",
  "/feeding/status": "feedingStatus",
  "/system/health": "health",
  "/status": "status",
  "/ai/status": "ai",
};

/** Poll a gateway path every `intervalMs` while the tab is visible. */
export function usePiResource<T>(path: string | null, intervalMs = 60_000) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!path) return;
    let active = true;
    let busy = false;
    const load = async () => {
      if (busy || (typeof document !== "undefined" && document.visibilityState !== "visible")) return;
      busy = true;
      try {
        const value = await piJson<T>(path);
        if (active) { setData(value); setError(null); }
      } catch (cause) {
        if (active) { setData(null); setError(piErrorMessage(cause)); }
      } finally { busy = false; }
    };
    void load();
    const timer = setInterval(() => void load(), intervalMs);
    const onVisible = () => { if (document.visibilityState === "visible") void load(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => { active = false; clearInterval(timer); document.removeEventListener("visibilitychange", onVisible); };
  }, [path, intervalMs, revision]);
  return { data, error, reload: () => setRevision((value) => value + 1) };
}

/** `/api/...` path as used by older pages → snapshot part or a slow poll. */
export function usePiEndpoint<T>(apiPath: string, intervalMs = 60_000): { data: T | null; error: string | null } {
  const path = apiPath.replace(/^\/api/, "");
  const part = SNAPSHOT_PARTS[path];
  const { snapshot, error } = usePiSnapshot();
  const polled = usePiResource<T>(part ? null : path, intervalMs);
  if (!part) return { data: polled.data, error: polled.error };
  return { data: (snapshot?.[part] as T | undefined) ?? null, error: error ? piErrorMessage(error) : null };
}

/** Camera MJPEG URL with the access token (an <img> can't send headers).
 *  Null while the tab is hidden, so the stream stops. */
export function useCameraStreamUrl(enabled: boolean): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!enabled) { setUrl(null); return; }
    let active = true;
    const update = async () => {
      if (document.visibilityState !== "visible") { setUrl(null); return; }
      const token = await piAccessToken();
      if (active) setUrl(token ? `${PI_BASE}/camera/stream?access_token=${encodeURIComponent(token)}` : null);
    };
    void update();
    document.addEventListener("visibilitychange", update);
    // Tokens last about an hour; renew the stream URL before expiry.
    const renew = setInterval(() => void update(), 45 * 60_000);
    return () => { active = false; setUrl(null); clearInterval(renew); document.removeEventListener("visibilitychange", update); };
  }, [enabled]);
  return url;
}
