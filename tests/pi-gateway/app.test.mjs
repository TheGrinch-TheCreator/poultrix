// Local test of src/lib/server/pi-gateway.ts with real ES256 tokens and mocked Supabase + Pi.
import { handlePiGateway } from "./gw.mjs";

const SUPA = "https://example.supabase.co";
const enc = (o) => Buffer.from(typeof o === "string" ? o : JSON.stringify(o)).toString("base64url");
const { privateKey, publicKey } = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const other = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const jwk = { ...(await crypto.subtle.exportKey("jwk", publicKey)), kid: "k1", alg: "ES256" };

async function sign(claims, { key = privateKey, kid = "k1", alg = "ES256" } = {}) {
  const h = enc({ alg, kid, typ: "JWT" }), p = enc(claims);
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(`${h}.${p}`)));
  return `${h}.${p}.${Buffer.from(sig).toString("base64url")}`;
}
const now = Math.floor(Date.now() / 1000);
const base = { iss: `${SUPA}/auth/v1`, aud: "authenticated", exp: now + 600 };
const users = {
  owner: { id: "u-owner", email: "JohnKarlDuenas@gmail.com", email_confirmed_at: "2026-01-01" },
  unconfirmed: { id: "u-unc", email: "johnkarlduenas2@gmail.com", email_confirmed_at: null },
  stranger: { id: "u-x", email: "stranger@example.com", email_confirmed_at: "2026-01-01" },
  helper: { id: "u-h", email: "helper@example.com", email_confirmed_at: "2026-01-01" },
};
const tokenFor = (u, extra = {}) => sign({ ...base, sub: u.id, email: u.email, ...extra });

let supaUserCalls = 0;
globalThis.fetch = async (url, init = {}) => {
  url = String(url);
  if (url === `${SUPA}/auth/v1/.well-known/jwks.json`) return Response.json({ keys: [jwk] });
  if (url === `${SUPA}/auth/v1/user`) {
    supaUserCalls++;
    const tok = init.headers.authorization.slice(7);
    const sub = JSON.parse(Buffer.from(tok.split(".")[1], "base64url")).sub;
    const u = Object.values(users).find((x) => x.id === sub);
    return u ? Response.json(u) : new Response("{}", { status: 401 });
  }
  throw new Error("unexpected fetch " + url);
};
const upstreamCalls = [];
const env = {
  SUPABASE_URL: SUPA, SUPABASE_PUBLISHABLE_KEY: "pk", POULTRIX_ALLOWED_EMAILS: " johnkarlduenas@gmail.com , johnkarlduenas2@gmail.com, helper@example.com",
  POULTRIX_OWNER_EMAILS: " JohnKarlDuenas@gmail.com ",
  POULTRIX_HISTORY: {
    fetch: async (url, init) => {
      upstreamCalls.push({ url, init });
      if (url.endsWith("/api/camera/stream")) return new Response("--frame", { headers: { "content-type": "multipart/x-mixed-replace; boundary=frame" } });
      if (url.endsWith("/api/feeding/manual/start")) return Response.json({ error: "Pulse must be 100-1500 ms" }, { status: 400 });
      return Response.json({ ok: true, path: url });
    },
  },
};
const req = (path, { method = "GET", token, headers = {}, body } = {}) =>
  new Request(`https://poultrix.example${path}`, { method, body, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers } });

let fails = 0;
const inline = (cond, label) => { console.log(`${cond ? "PASS" : "FAIL"}${label}`); if (!cond) fails++; };
async function check(name, request, wantStatus, extra) {
  const r = await handlePiGateway(request, env);
  const text = await r.text();
  const ok = r.status === wantStatus && (!extra || extra(r, text));
  console.log(`${ok ? "PASS" : "FAIL"} ${name} -> ${r.status} ${text.slice(0, 90)}`);
  if (!ok) fails++;
}

const owner = await tokenFor(users.owner);
await check("no token", req("/api/pi/snapshot"), 401);
await check("garbage token", req("/api/pi/snapshot", { token: "a.b.c" }), 401);
await check("expired", req("/api/pi/snapshot", { token: await tokenFor(users.owner, { exp: now - 120 }) }), 401);
await check("wrong issuer", req("/api/pi/snapshot", { token: await tokenFor(users.owner, { iss: "https://evil/auth/v1" }) }), 401);
await check("wrong audience", req("/api/pi/snapshot", { token: await tokenFor(users.owner, { aud: "anon" }) }), 401);
await check("signed by other key", req("/api/pi/snapshot", { token: await sign({ ...base, sub: "u-owner" }, { key: other.privateKey }) }), 401);
await check("alg none/HS256 rejected", req("/api/pi/snapshot", { token: await sign({ ...base, sub: "u-owner" }, { alg: "HS256" }) }), 401);
await check("unknown kid", req("/api/pi/snapshot", { token: await sign({ ...base, sub: "u-owner" }, { kid: "nope" }) }), 401);
await check("stranger (valid, not listed)", req("/api/pi/snapshot", { token: await tokenFor(users.stranger) }), 403);
await check("listed but email unconfirmed", req("/api/pi/snapshot", { token: await tokenFor(users.unconfirmed) }), 403);
await check("owner snapshot (case-insensitive email)", req("/api/pi/snapshot", { token: owner }), 200, (_, t) => t.includes("http://127.0.0.1:5000/api/snapshot"));
await check("unlisted path", req("/api/pi/mode/live", { method: "POST", token: owner }), 404);
await check("path traversal", req("/api/pi/../mode/live", { method: "POST", token: owner }), 404);
await check("encoded traversal", req("/api/pi/feeding%2F..%2F..%2Fmode%2Flive", { method: "POST", token: owner }), 404);
await check("test route not exposed", req("/api/pi/test/stage", { method: "POST", token: owner }), 404);
await check("wrong method", req("/api/pi/snapshot", { method: "POST", token: owner }), 405, (r) => r.headers.get("allow") === "GET");
await check("body > 4 KB", req("/api/pi/feeding/config", { method: "POST", token: owner, body: "x".repeat(5000) }), 413);
upstreamCalls.length = 0;
await check("Pi error passes through", req("/api/pi/feeding/manual/start", { method: "POST", token: owner, body: "{}" }), 400, (_, t) => t.includes("Pulse must be"));
const call = upstreamCalls[0];
inline(call.init.headers["x-poultrix-user"] === "johnkarlduenas@gmail.com" && !("x-poultrix-maintenance" in call.init.headers) && call.url === "http://127.0.0.1:5000/api/feeding/manual/start", " upstream gets user header, fixed URL, no maintenance header");
upstreamCalls.length = 0;
await check("query string not forwarded", req("/api/pi/status?x=1&host=evil", { token: owner }), 200);
inline(upstreamCalls[0].url === "http://127.0.0.1:5000/api/status", " upstream URL has no query");
upstreamCalls.length = 0;
// Maintenance moved to its own site (maintenance-site M3): no bypass on the main app.
await check("bypass/status not exposed on main app", req("/api/pi/bypass/status", { token: owner, headers: { "x-poultrix-maintenance": "mt" } }), 404);
// System power: owner only (SPEC-system-power).
const helper = await tokenFor(users.helper);
upstreamCalls.length = 0;
await check("reboot by owner", req("/api/pi/system/reboot", { method: "POST", token: owner, body: JSON.stringify({ confirm: "REBOOT" }) }), 200);
inline(upstreamCalls.length === 1 && upstreamCalls[0].url === "http://127.0.0.1:5000/api/system/reboot" && upstreamCalls[0].init.headers["x-poultrix-user"] === "johnkarlduenas@gmail.com", " reboot reaches fixed Pi path as the owner");
await check("power-off by owner", req("/api/pi/system/power-off", { method: "POST", token: owner, body: JSON.stringify({ confirm: "POWEROFF", minutes: 5 }) }), 200);
upstreamCalls.length = 0;
await check("reboot by approved non-owner", req("/api/pi/system/reboot", { method: "POST", token: helper, body: "{}" }), 403, (_, t) => t.includes("OWNER_ONLY"));
await check("power-off by approved non-owner", req("/api/pi/system/power-off", { method: "POST", token: helper, body: "{}" }), 403, (_, t) => t.includes("OWNER_ONLY"));
await check("helper can still read", req("/api/pi/snapshot", { token: helper }), 200);
upstreamCalls.length = 0;
await check("feeding sessions readable by helper", req("/api/pi/feeding/sessions", { token: helper }), 200);
await check("automatic switch by helper", req("/api/pi/feeding/automatic", { method: "POST", token: helper, body: JSON.stringify({ enabled: true }) }), 403, (_, t) => t.includes("OWNER_ONLY"));
upstreamCalls.length = 0;
await check("automatic switch by owner", req("/api/pi/feeding/automatic", { method: "POST", token: owner, body: JSON.stringify({ enabled: false }) }), 200);
inline(upstreamCalls[0]?.url === "http://127.0.0.1:5000/api/feeding/automatic", " automatic switch reaches fixed Pi path");
upstreamCalls.length = 0;
await check("reboot signed out", req("/api/pi/system/reboot", { method: "POST", body: "{}" }), 401);
await check("reboot via GET", req("/api/pi/system/reboot", { token: owner }), 405);
inline(upstreamCalls.length === 0, " no upstream call for refused power requests");
{
  const noOwner = { ...env, POULTRIX_OWNER_EMAILS: "" };
  const r = await handlePiGateway(req("/api/pi/system/reboot", { method: "POST", token: owner, body: "{}" }), noOwner);
  inline(r.status === 403, " empty owner list refuses everyone");
}
await check("trough-zero not exposed on main app", req("/api/pi/bypass/trough-zero", { method: "POST", token: owner, body: "{}" }), 404);
await check("confirm-stage not exposed on main app", req("/api/pi/bypass/confirm-stage", { method: "POST", token: owner, headers: { "x-poultrix-maintenance": "mt" }, body: "{}" }), 404);
upstreamCalls.length = 0;
await check("snapshot ignores a client maintenance header", req("/api/pi/snapshot", { token: owner, headers: { "x-poultrix-maintenance": "mt" } }), 200);
inline(upstreamCalls.length === 1 && !("x-poultrix-maintenance" in upstreamCalls[0].init.headers), " main app never forwards the maintenance token");
upstreamCalls.length = 0;
await check("bypass/login not exposed on main app", req("/api/pi/bypass/login", { method: "POST", token: owner, body: "{}" }), 404);
inline(upstreamCalls.length === 0, " no upstream call for bypass routes");
await check("camera with ?access_token", req(`/api/pi/camera/stream?access_token=${owner}`), 200, (r) => r.headers.get("content-type").startsWith("multipart/"));
await check("?access_token refused on non-camera route", req(`/api/pi/snapshot?access_token=${owner}`), 401);
const before = supaUserCalls;
for (let i = 0; i < 5; i++) await handlePiGateway(req("/api/pi/status", { token: owner }), env);
inline(supaUserCalls === before, ` confirmed-email lookup cached (extra calls: ${supaUserCalls - before})`);
await check("not configured (no allowlist)", req("/api/pi/snapshot", { token: owner }), 200); // sanity
const r = await handlePiGateway(req("/api/pi/snapshot", { token: owner }), { ...env, POULTRIX_ALLOWED_EMAILS: "" });
inline(r.status === 503, ` empty allowlist -> ${r.status} (fail closed)`);
console.log(fails ? `\n${fails} FAILED` : "\nALL PASS");
process.exit(fails ? 1 : 0);
