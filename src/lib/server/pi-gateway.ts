// Authenticated gateway from the public Worker to the Pi's private Flask API.
//
// This is NOT a generic proxy: every reachable Pi path is listed in ROUTES,
// the upstream URL is built from the matched table entry (never from the
// request), no query strings are forwarded, and bodies are size-limited.
// Spec: SPEC-remote-access.md.

type Fetcher = { fetch: (input: Request | string, init?: RequestInit) => Promise<Response> };

export type PiGatewayEnv = {
  POULTRIX_HISTORY?: Fetcher;
  SUPABASE_URL?: string;
  SUPABASE_PUBLISHABLE_KEY?: string;
  POULTRIX_ALLOWED_EMAILS?: string;
};

type Method = "GET" | "POST";
type PiRoute = {
  /** Path after /api/pi, e.g. "/status". */
  path: string;
  /** Path on the Pi. */
  upstream: string;
  methods: readonly Method[];
  /** Forward X-Poultrix-Maintenance (bypass routes only). */
  maintenance?: boolean;
  /** Stream the response body (camera). */
  stream?: boolean;
  /** Upstream timeout; defaults depend on method. */
  timeoutMs?: number;
};

const GET: readonly Method[] = ["GET"];
const POST: readonly Method[] = ["POST"];
const BOTH: readonly Method[] = ["GET", "POST"];
const SLOW_MS = 90_000; // 30-frame AI cycles

const ROUTES: readonly PiRoute[] = [
  // Reads
  { path: "/snapshot", upstream: "/api/snapshot", methods: GET },
  { path: "/status", upstream: "/api/status", methods: GET },
  { path: "/ai/status", upstream: "/api/ai/status", methods: GET },
  { path: "/feeding/weight", upstream: "/api/feeding/weight", methods: GET },
  { path: "/feeding/status", upstream: "/api/feeding/status", methods: GET },
  { path: "/feeding/job", upstream: "/api/feeding/job", methods: GET },
  { path: "/feeding/inventory", upstream: "/api/feeding/inventory", methods: GET },
  { path: "/system/health", upstream: "/api/system/health", methods: GET },
  { path: "/sensors/check/status", upstream: "/api/sensors/check/status", methods: GET },
  { path: "/environment/standards", upstream: "/api/environment/standards", methods: GET },
  // Controls
  { path: "/feeding/config", upstream: "/api/feeding/config", methods: BOTH },
  { path: "/feeding/manual/preview", upstream: "/api/feeding/manual/preview", methods: POST },
  { path: "/feeding/manual/start", upstream: "/api/feeding/manual/start", methods: POST },
  { path: "/feeding/job/stop", upstream: "/api/feeding/job/stop", methods: POST },
  { path: "/feeding/stop", upstream: "/api/feeding/stop", methods: POST },
  { path: "/feeding/inventory/feed", upstream: "/api/feeding/inventory/feed", methods: POST },
  { path: "/feeding/inventory/assign", upstream: "/api/feeding/inventory/assign", methods: POST },
  { path: "/feeding/inventory/refill", upstream: "/api/feeding/inventory/refill", methods: POST },
  { path: "/feeding/inventory/initialize", upstream: "/api/feeding/inventory/initialize", methods: POST },
  { path: "/ai/classify", upstream: "/api/ai/classify", methods: POST, timeoutMs: SLOW_MS },
  { path: "/sensors/check", upstream: "/api/sensors/check", methods: POST },
  // Maintenance (also needs the Pi's maintenance token)
  { path: "/bypass/login", upstream: "/api/bypass/login", methods: POST, maintenance: true },
  { path: "/bypass/status", upstream: "/api/bypass/status", methods: GET, maintenance: true },
  { path: "/bypass/action", upstream: "/api/bypass/action", methods: POST, maintenance: true },
  { path: "/bypass/analyse-real", upstream: "/api/bypass/analyse-real", methods: POST, maintenance: true, timeoutMs: SLOW_MS },
  { path: "/bypass/return-live", upstream: "/api/bypass/return-live", methods: POST, maintenance: true },
  { path: "/bypass/resume", upstream: "/api/bypass/resume", methods: POST, maintenance: true },
  { path: "/bypass/exit", upstream: "/api/bypass/exit", methods: POST, maintenance: true },
  { path: "/bypass/schedule-test", upstream: "/api/bypass/schedule-test", methods: POST, maintenance: true },
  { path: "/bypass/schedule-test/cancel", upstream: "/api/bypass/schedule-test/cancel", methods: POST, maintenance: true },
  // Camera (MJPEG); the only route that accepts ?access_token=
  { path: "/camera/stream", upstream: "/api/camera/stream", methods: GET, stream: true },
];

const ROUTE_BY_PATH = new Map(ROUTES.map((route) => [route.path, route]));
const PI_ORIGIN = "http://127.0.0.1:5000"; // VPC service target (fixed)
const MAX_BODY_BYTES = 4096;
export const PI_GATEWAY_PREFIX = "/api/pi";

function json(body: unknown, status: number, extra?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...extra,
    },
  });
}

// ---------------------------------------------------------------- auth

type Jwk = JsonWebKey & { kid?: string };
type Claims = { sub?: string; email?: string; exp?: number; iss?: string; aud?: string | string[] };

const JWKS_TTL_MS = 10 * 60_000;
const USER_TTL_MS = 5 * 60_000;
let jwksCache: { at: number; keys: Map<string, CryptoKey> } | null = null;
const confirmedCache = new Map<string, { at: number; email: string; confirmed: boolean }>();

function b64urlBytes(text: string): Uint8Array<ArrayBuffer> {
  const base64 = text.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(text.length / 4) * 4, "=");
  const raw = atob(base64);
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

function b64urlJson<T>(text: string): T {
  return JSON.parse(new TextDecoder().decode(b64urlBytes(text))) as T;
}

async function signingKeys(supabaseUrl: string, refresh: boolean): Promise<Map<string, CryptoKey>> {
  if (!refresh && jwksCache && Date.now() - jwksCache.at < JWKS_TTL_MS) return jwksCache.keys;
  const response = await fetch(`${supabaseUrl}/auth/v1/.well-known/jwks.json`, {
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) throw new Error(`JWKS HTTP ${response.status}`);
  const { keys = [] } = (await response.json()) as { keys?: Jwk[] };
  const imported = new Map<string, CryptoKey>();
  for (const jwk of keys) {
    if (jwk.kty !== "EC" || jwk.crv !== "P-256" || !jwk.kid) continue;
    imported.set(
      jwk.kid,
      await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]),
    );
  }
  jwksCache = { at: Date.now(), keys: imported };
  return imported;
}

/** Verify a Supabase ES256 access token locally. Returns claims or null. */
async function verifyAccessToken(token: string, supabaseUrl: string): Promise<Claims | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [headerText, payloadText, signatureText] = parts as [string, string, string];
  let header: { alg?: string; kid?: string };
  let claims: Claims;
  try {
    header = b64urlJson(headerText);
    claims = b64urlJson(payloadText);
  } catch {
    return null;
  }
  if (header.alg !== "ES256" || !header.kid) return null;
  let key = (await signingKeys(supabaseUrl, false)).get(header.kid);
  if (!key) key = (await signingKeys(supabaseUrl, true)).get(header.kid); // key rotation
  if (!key) return null;
  const valid = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    b64urlBytes(signatureText),
    new TextEncoder().encode(`${headerText}.${payloadText}`),
  );
  if (!valid) return null;
  const now = Math.floor(Date.now() / 1000);
  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (typeof claims.exp !== "number" || claims.exp < now - 30) return null;
  if (claims.iss !== `${supabaseUrl}/auth/v1`) return null;
  if (!audience.includes("authenticated") || !claims.sub) return null;
  return claims;
}

/** Confirmed email from Supabase (cached per user), so a helper's address
 *  can't be claimed by someone who signs up first with it. */
async function confirmedEmail(token: string, sub: string, supabaseUrl: string, apiKey: string): Promise<string | null> {
  const cached = confirmedCache.get(sub);
  if (cached && Date.now() - cached.at < USER_TTL_MS) return cached.confirmed ? cached.email : null;
  const response = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: { authorization: `Bearer ${token}`, apikey: apiKey },
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) return null;
  const user = (await response.json()) as { id?: string; email?: string; email_confirmed_at?: string | null };
  if (user.id !== sub || !user.email) return null;
  const entry = { at: Date.now(), email: user.email.toLowerCase(), confirmed: Boolean(user.email_confirmed_at) };
  if (confirmedCache.size > 200) confirmedCache.clear();
  confirmedCache.set(sub, entry);
  return entry.confirmed ? entry.email : null;
}

function allowedEmails(env: PiGatewayEnv): Set<string> {
  return new Set(
    (env.POULTRIX_ALLOWED_EMAILS ?? "")
      .split(",")
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean),
  );
}

// ---------------------------------------------------------------- handler

async function readBody(request: Request): Promise<string | Response> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY_BYTES) return json({ error: "Request body too large" }, 413);
  const text = await request.text();
  if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) return json({ error: "Request body too large" }, 413);
  return text;
}

export async function handlePiGateway(request: Request, env: PiGatewayEnv): Promise<Response> {
  const url = new URL(request.url);
  const route = ROUTE_BY_PATH.get(url.pathname.slice(PI_GATEWAY_PREFIX.length));
  if (!route) return json({ error: "Not found" }, 404);
  const method = request.method.toUpperCase();
  if (!route.methods.includes(method as Method)) {
    return json({ error: "Method not allowed" }, 405, { allow: route.methods.join(", ") });
  }

  const supabaseUrl = (env.SUPABASE_URL ?? process.env["SUPABASE_URL"] ?? "").replace(/\/$/, "");
  const apiKey = env.SUPABASE_PUBLISHABLE_KEY ?? process.env["SUPABASE_PUBLISHABLE_KEY"] ?? "";
  const allowed = allowedEmails(env);
  if (!supabaseUrl || !apiKey || !env.POULTRIX_HISTORY || allowed.size === 0) {
    return json({ error: "Remote access is not configured" }, 503);
  }

  const bearer = /^Bearer\s+(.+)$/i.exec(request.headers.get("authorization") ?? "")?.[1];
  const token = bearer ?? (route.stream ? url.searchParams.get("access_token") : null);
  if (!token) return json({ error: "Sign in required", code: "AUTH_REQUIRED" }, 401);

  let email: string | null;
  try {
    const claims = await verifyAccessToken(token, supabaseUrl);
    if (!claims?.sub) return json({ error: "Session expired. Sign in again.", code: "SESSION_INVALID" }, 401);
    email = await confirmedEmail(token, claims.sub, supabaseUrl, apiKey);
  } catch (error) {
    console.error("Pi gateway auth failed:", error);
    return json({ error: "Unable to verify session" }, 503);
  }
  if (!email || !allowed.has(email)) {
    return json({ error: "Account not approved for Poultrix", code: "NOT_APPROVED" }, 403);
  }

  const headers: Record<string, string> = { accept: route.stream ? "*/*" : "application/json", "x-poultrix-user": email };
  let body: string | undefined;
  if (method === "POST") {
    const read = await readBody(request);
    if (read instanceof Response) return read;
    body = read;
    headers["content-type"] = "application/json";
  }
  if (route.maintenance) {
    const maintenance = request.headers.get("x-poultrix-maintenance");
    if (maintenance && maintenance.length <= 200) headers["x-poultrix-maintenance"] = maintenance;
  }

  const timeoutMs = route.timeoutMs ?? (method === "GET" ? 10_000 : 20_000);
  let upstream: Response;
  try {
    upstream = await env.POULTRIX_HISTORY.fetch(`${PI_ORIGIN}${route.upstream}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body }),
      signal: route.stream ? request.signal : AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    console.error(`Pi gateway ${method} ${route.path} failed:`, error);
    const timedOut = error instanceof Error && error.name === "TimeoutError";
    return json({ error: timedOut ? "Raspberry Pi did not respond in time" : "Raspberry Pi unreachable", code: "PI_UNREACHABLE" }, timedOut ? 504 : 502);
  }

  if (route.stream) {
    return new Response(upstream.body, {
      status: upstream.status,
      headers: {
        "content-type": upstream.headers.get("content-type") ?? "application/octet-stream",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    });
  }
  // Pass the Pi's own JSON status and message through (the UI shows them).
  const contentType = upstream.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    return json({ error: "Raspberry Pi returned an unexpected response", code: "PI_BAD_RESPONSE" }, 502);
  }
  return new Response(await upstream.text(), {
    status: upstream.status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" },
  });
}
