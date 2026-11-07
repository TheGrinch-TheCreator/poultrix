// Maintenance-site Pi client. No app login here: requests carry the Pi's
// bypass (maintenance) token; the Worker gateway allows only bypass/*,
// camera/stream and snapshot. Spec: SPEC-maintenance-site.md.
import { useEffect, useRef, useState } from "react";

export const SESSION_KEY = "poultrix_maintenance_token";

export class MaintenanceError extends Error {
  constructor(message: string, readonly status: number, readonly code: string | null) {
    super(message);
    this.name = "MaintenanceError";
  }
}

/** True when the Pi or gateway says the token is no longer valid. */
export function sessionExpired(error: unknown): boolean {
  return error instanceof MaintenanceError && (error.code === "MAINTENANCE_REQUIRED" || (error.status === 403 && error.message === "Unauthorized"));
}

export async function piRequest<T>(path: string, options: { token?: string; body?: unknown; method?: "GET" | "POST" } = {}): Promise<T> {
  const method = options.method ?? (options.body === undefined ? "GET" : "POST");
  const headers: Record<string, string> = {};
  if (options.token) headers["x-poultrix-maintenance"] = options.token;
  if (method === "POST") headers["content-type"] = "application/json";
  let response: Response;
  try {
    response = await fetch(`/api/pi${path}`, {
      method,
      headers,
      cache: "no-store",
      ...(method === "POST" ? { body: JSON.stringify(options.body ?? {}) } : {}),
    });
  } catch {
    throw new MaintenanceError("No internet connection", 0, "NETWORK");
  }
  const data = (await response.json().catch(() => ({}))) as { error?: unknown; code?: unknown };
  if (!response.ok) {
    const code = typeof data.code === "string" ? data.code : null;
    const message =
      response.status === 429 ? "Too many attempts. Wait 10 minutes, then try again."
      : code === "PI_UNREACHABLE" ? "Raspberry Pi unreachable"
      : typeof data.error === "string" && data.error ? data.error
      : `HTTP ${response.status}`;
    throw new MaintenanceError(message, response.status, code);
  }
  return data as T;
}

function useVisible(): boolean {
  const [visible, setVisible] = useState(() => typeof document === "undefined" || document.visibilityState === "visible");
  useEffect(() => {
    const update = () => setVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);
  return visible;
}

/** Poll a maintenance path while the tab is visible and a token exists. */
export function usePoll<T>(path: string, token: string, intervalMs: number, onError?: (error: unknown) => void) {
  const visible = useVisible();
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  useEffect(() => {
    if (!token || !visible) return;
    let active = true;
    let busy = false;
    const load = async () => {
      if (busy) return;
      busy = true;
      try {
        const value = await piRequest<T>(path, { token });
        if (active) { setData(value); setError(null); }
      } catch (cause) {
        if (active) {
          setData(null);
          setError(cause instanceof Error ? cause.message : "Unavailable");
          onErrorRef.current?.(cause);
        }
      } finally { busy = false; }
    };
    void load();
    const timer = setInterval(() => void load(), intervalMs);
    return () => { active = false; clearInterval(timer); };
  }, [path, token, intervalMs, visible]);
  return { data, error };
}

/** Camera MJPEG URL for the current token; null while the tab is hidden so
 *  the stream (and the farm's upload bandwidth) stops. */
export function useCameraUrl(token: string): string | null {
  const visible = useVisible();
  return token && visible ? `/api/pi/camera/stream?maintenance_token=${encodeURIComponent(token)}` : null;
}
