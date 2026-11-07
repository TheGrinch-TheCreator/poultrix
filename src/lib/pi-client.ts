// Browser client for the Pi, through the authenticated Worker gateway
// (/api/pi/* -> tunnel -> Pi). Works the same on the farm Wi-Fi and on
// mobile data. Spec: SPEC-remote-access.md.
import { supabase } from "@/integrations/supabase/client";

export const PI_BASE = "/api/pi";

export type PiErrorCode =
  | "AUTH_REQUIRED"
  | "SESSION_INVALID"
  | "NOT_APPROVED"
  | "PI_UNREACHABLE"
  | "PI_BAD_RESPONSE"
  | "RATE_LIMITED"
  | "HTTP"
  | "NETWORK";

export class PiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: PiErrorCode,
  ) {
    super(message);
    this.name = "PiError";
  }
}

async function accessToken(forceRefresh: boolean): Promise<string | null> {
  if (forceRefresh) {
    const { data } = await supabase.auth.refreshSession();
    return data.session?.access_token ?? null;
  }
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}

/** Current access token, for the camera <img> URL (it can't send headers). */
export async function piAccessToken(): Promise<string | null> {
  return accessToken(false);
}

function errorCode(status: number, code: unknown): PiErrorCode {
  if (typeof code === "string" && ["AUTH_REQUIRED", "SESSION_INVALID", "NOT_APPROVED", "PI_UNREACHABLE", "PI_BAD_RESPONSE"].includes(code)) {
    return code as PiErrorCode;
  }
  if (status === 429) return "RATE_LIMITED";
  return "HTTP";
}

/** fetch() a Pi path such as "/feeding/config". Retries once on 401 after
 *  refreshing the session. Throws PiError for non-2xx responses. */
export async function piFetch(path: string, init: RequestInit & { maintenanceToken?: string } = {}): Promise<Response> {
  const { maintenanceToken, ...rest } = init;
  const send = async (token: string | null) => {
    const headers = new Headers(rest.headers);
    if (token) headers.set("authorization", `Bearer ${token}`);
    if (maintenanceToken) headers.set("x-poultrix-maintenance", maintenanceToken);
    if (rest.body !== undefined && !headers.has("content-type")) headers.set("content-type", "application/json");
    try {
      return await fetch(`${PI_BASE}${path}`, { ...rest, headers, cache: "no-store" });
    } catch {
      throw new PiError("No internet connection", 0, "NETWORK");
    }
  };
  let response = await send(await accessToken(false));
  if (response.status === 401) response = await send(await accessToken(true));
  if (!response.ok) {
    let body: { error?: unknown; code?: unknown } = {};
    try {
      body = (await response.clone().json()) as typeof body;
    } catch {
      /* non-JSON error body */
    }
    const message = typeof body.error === "string" && body.error ? body.error : `HTTP ${response.status}`;
    throw new PiError(message, response.status, errorCode(response.status, body.code));
  }
  return response;
}

/** JSON helper: GET by default; pass `body` to POST JSON. */
export async function piJson<T>(path: string, options: { method?: "GET" | "POST"; body?: unknown; maintenanceToken?: string; signal?: AbortSignal } = {}): Promise<T> {
  const method = options.method ?? (options.body === undefined ? "GET" : "POST");
  const response = await piFetch(path, {
    method,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    ...(options.maintenanceToken ? { maintenanceToken: options.maintenanceToken } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  });
  return (await response.json()) as T;
}

/** Short message for the UI. */
export function piErrorMessage(error: unknown): string {
  if (error instanceof PiError) {
    switch (error.code) {
      case "AUTH_REQUIRED":
      case "SESSION_INVALID":
        return "Sign in again to reach the Raspberry Pi";
      case "NOT_APPROVED":
        return "Account not approved for Poultrix";
      case "PI_UNREACHABLE":
        return "Raspberry Pi unreachable";
      case "NETWORK":
        return "No internet connection";
      default:
        return error.message;
    }
  }
  return error instanceof Error ? error.message : "Request failed";
}
