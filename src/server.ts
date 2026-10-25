import "./lib/error-capture";

import { consumeLastCapturedError } from "./lib/error-capture";
import { renderErrorPage } from "./lib/error-page";

type ServerEntry = {
  fetch: (request: Request, env: unknown, ctx: unknown) => Promise<Response> | Response;
};

let serverEntryPromise: Promise<ServerEntry> | undefined;

async function getServerEntry(): Promise<ServerEntry> {
  if (!serverEntryPromise) {
    serverEntryPromise = import("@tanstack/react-start/server-entry").then(
      (m) => (m.default ?? m) as ServerEntry,
    );
  }
  return serverEntryPromise;
}

// h3 swallows in-handler throws into a normal 500 Response with body
// {"unhandled":true,"message":"HTTPError"} — try/catch alone never fires for those.
async function normalizeCatastrophicSsrResponse(response: Response): Promise<Response> {
  if (response.status < 500) return response;
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) return response;

  const body = await response.clone().text();
  if (!isH3SwallowedErrorBody(body)) return response;

  console.error(consumeLastCapturedError() ?? new Error(`h3 swallowed SSR error: ${body}`));
  return new Response(renderErrorPage(), {
    status: 500,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

function isH3SwallowedErrorBody(body: string): boolean {
  try {
    const payload = JSON.parse(body) as { unhandled?: unknown; message?: unknown };
    return payload.unhandled === true && payload.message === "HTTPError";
  } catch {
    return false;
  }
}


// Read-only, authenticated history endpoint. Never proxy arbitrary Flask paths.
type HistoryEnv = {
  POULTRIX_HISTORY?: { fetch: (request: Request | string, init?: RequestInit) => Promise<Response> };
  SUPABASE_URL?: string;
  SUPABASE_PUBLISHABLE_KEY?: string;
};

async function handlePoultrixHistory(request: Request, env: HistoryEnv): Promise<Response> {
  const json = (body: unknown, status: number) => new Response(JSON.stringify(body), {
    status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
  if (request.method !== "GET") return json({ error: "Method not allowed" }, 405);
  const token = /^Bearer (.+)$/i.exec(request.headers.get("authorization") ?? "")?.[1];
  if (!token) return json({ error: "Authentication required" }, 401);
  const supabaseUrl = env.SUPABASE_URL ?? process.env.SUPABASE_URL;
  const supabaseKey = env.SUPABASE_PUBLISHABLE_KEY ?? process.env.SUPABASE_PUBLISHABLE_KEY;
  if (!supabaseUrl || !supabaseKey || !env.POULTRIX_HISTORY) {
    return json({ error: "History integration is not configured" }, 503);
  }
  try {
    const auth = await fetch(`${supabaseUrl.replace(/\/$/, "")}/auth/v1/user`, {
      headers: { authorization: `Bearer ${token}`, apikey: supabaseKey },
      signal: AbortSignal.timeout(8000),
    });
    if (!auth.ok) return json({ error: "Invalid or expired session" }, 401);
    const user = await auth.json() as { id?: string };
    if (!user.id) return json({ error: "Invalid session" }, 401);
    const url = new URL(request.url);
    const days = Number(url.searchParams.get("days") ?? "1");
    if (![1, 7, 30].includes(days)) return json({ error: "days must be 1, 7, or 30" }, 400);
    // The VPC service has only a private 127.0.0.1:5000 destination.
    const upstream = await env.POULTRIX_HISTORY.fetch(`http://127.0.0.1:5000/api/history?days=${days}`, {
      method: "GET", headers: { accept: "application/json" }, signal: AbortSignal.timeout(12000),
    });
    if (!upstream.ok) return json({ error: "History backend unavailable" }, 502);
    const data = await upstream.json();
    return json(data, 200);
  } catch (error) {
    console.error("Private history request failed", error);
    return json({ error: "Unable to retrieve history" }, 502);
  }
}

export default {
  async fetch(request: Request, env: unknown, ctx: unknown) {
    try {
      if (new URL(request.url).pathname === "/api/history") {
        return await handlePoultrixHistory(request, env as HistoryEnv);
      }
      const handler = await getServerEntry();
      const response = await handler.fetch(request, env, ctx);
      return await normalizeCatastrophicSsrResponse(response);
    } catch (error) {
      console.error(error);
      return new Response(renderErrorPage(), {
        status: 500,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
  },
};
