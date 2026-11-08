// Maintenance-mode gateway tests (no Supabase; Pi bypass token).
import { handleMaintenanceGateway, MAINTENANCE_ROUTES, APP_ROUTES } from "./gw.mjs";

const calls = [];
let statusCalls = 0;
const env = {
  POULTRIX_HISTORY: {
    fetch: async (url, init) => {
      calls.push({ url, init });
      if (url.endsWith("/api/bypass/status")) {
        statusCalls++;
        return init.headers["x-poultrix-maintenance"] === "good-token"
          ? Response.json({ active: true })
          : Response.json({ error: "Unauthorized" }, { status: 403 });
      }
      if (url.endsWith("/api/bypass/login")) {
        return JSON.parse(init.body).password === "0987" ? Response.json({ token: "good-token" }) : Response.json({ error: "Unauthorized" }, { status: 403 });
      }
      if (url.endsWith("/api/camera/stream")) return new Response("--frame", { headers: { "content-type": "multipart/x-mixed-replace; boundary=frame" } });
      return Response.json({ ok: true, path: url });
    },
  },
};
const req = (path, { method = "GET", headers = {}, body } = {}) =>
  new Request(`https://maintenance.example${path}`, { method, body, headers: { "cf-connecting-ip": "203.0.113.7", ...headers } });
let fails = 0;
const ok = (name, cond, extra = "") => { console.log(`${cond ? "PASS" : "FAIL"} ${name}${extra ? "  " + extra : ""}`); if (!cond) fails++; };
const run = async (name, request, want, extra) => {
  const r = await handleMaintenanceGateway(request, env);
  const t = await r.text();
  ok(name, r.status === want && (!extra || extra(r, t)), `-> ${r.status} ${t.slice(0, 80)}`);
};

ok("maintenance table = bypass/* + camera + snapshot", MAINTENANCE_ROUTES.every((r) => r.maintenance || ["/camera/stream", "/snapshot"].includes(r.path)) && MAINTENANCE_ROUTES.length === 14, `(${MAINTENANCE_ROUTES.length} routes)`);
ok("maintenance table has no system power routes", !MAINTENANCE_ROUTES.some((r) => r.path.startsWith("/system/reboot") || r.path.startsWith("/system/power-off")));
ok("app table has no bypass routes (M3)", !APP_ROUTES.some((r) => r.path.startsWith("/bypass/")) && APP_ROUTES.length === 24, `(${APP_ROUTES.length} routes)`);
await run("feeding route not exposed", req("/api/pi/feeding/manual/start", { method: "POST", body: "{}" }), 404);
await run("ai/classify not exposed", req("/api/pi/ai/classify", { method: "POST" }), 404);
await run("status not exposed", req("/api/pi/status"), 404);
await run("snapshot without token", req("/api/pi/snapshot"), 401, (_, t) => t.includes("MAINTENANCE_REQUIRED"));
await run("snapshot with bad token", req("/api/pi/snapshot", { headers: { "x-poultrix-maintenance": "bad" } }), 401);
await run("camera without token", req("/api/pi/camera/stream"), 401);
await run("camera with ?access_token (Supabase style) refused", req("/api/pi/camera/stream?access_token=good-token"), 401);
calls.length = 0;
await run("login passes through (wrong pw -> Pi 403)", req("/api/pi/bypass/login", { method: "POST", body: JSON.stringify({ password: "x" }) }), 403);
ok("login forwarded with ip user header", calls[0]?.init.headers["x-poultrix-user"] === "ip:203.0.113.7", calls[0]?.init.headers["x-poultrix-user"]);
await run("login correct -> token", req("/api/pi/bypass/login", { method: "POST", body: JSON.stringify({ password: "0987" }) }), 200, (_, t) => t.includes("good-token"));
await run("snapshot with valid token", req("/api/pi/snapshot", { headers: { "x-poultrix-maintenance": "good-token" } }), 200);
await run("camera with ?maintenance_token", req("/api/pi/camera/stream?maintenance_token=good-token"), 200, (r) => r.headers.get("content-type").startsWith("multipart/"));
const before = statusCalls;
for (let i = 0; i < 5; i++) await handleMaintenanceGateway(req("/api/pi/snapshot", { headers: { "x-poultrix-maintenance": "good-token" } }), env);
ok("token validation cached (no extra Pi status calls)", statusCalls === before, `extra=${statusCalls - before}`);
calls.length = 0;
await run("bypass action forwards token, Pi decides", req("/api/pi/bypass/action", { method: "POST", headers: { "x-poultrix-maintenance": "good-token" }, body: JSON.stringify({ action: "stop" }) }), 200);
ok("maintenance header forwarded on bypass route", calls[0]?.init.headers["x-poultrix-maintenance"] === "good-token");
calls.length = 0;
await run("confirm-stage forwards token", req("/api/pi/bypass/confirm-stage", { method: "POST", headers: { "x-poultrix-maintenance": "good-token" }, body: JSON.stringify({ stage: "GROWER" }) }), 200);
calls.length = 0;
await run("trough-zero forwards token", req("/api/pi/bypass/trough-zero", { method: "POST", headers: { "x-poultrix-maintenance": "good-token" }, body: "{}" }), 200);
ok("trough-zero reaches fixed Pi path with token", calls[0]?.url === "http://127.0.0.1:5000/api/bypass/trough-zero" && calls[0]?.init.headers["x-poultrix-maintenance"] === "good-token", calls[0]?.url);
await run("trough-check via GET", req("/api/pi/bypass/trough-check", { headers: { "x-poultrix-maintenance": "good-token" } }), 405);
calls.length = 0;
await run("confirm-stage again", req("/api/pi/bypass/confirm-stage", { method: "POST", headers: { "x-poultrix-maintenance": "good-token" }, body: JSON.stringify({ stage: "GROWER" }) }), 200);
ok("confirm-stage reaches fixed Pi path with token", calls[0]?.url === "http://127.0.0.1:5000/api/bypass/confirm-stage" && calls[0]?.init.headers["x-poultrix-maintenance"] === "good-token", calls[0]?.url);
calls.length = 0;
await run("snapshot with valid token (again)", req("/api/pi/snapshot", { headers: { "x-poultrix-maintenance": "good-token" } }), 200);
ok("snapshot forwards token (maintenance values)", calls.some((c) => c.url.endsWith("/api/snapshot") && c.init.headers["x-poultrix-maintenance"] === "good-token"));
ok("no supabase needed (env has no SUPABASE_*)", !("SUPABASE_URL" in env));
await run("body > 4 KB", req("/api/pi/bypass/action", { method: "POST", headers: { "x-poultrix-maintenance": "good-token" }, body: "x".repeat(5000) }), 413);
await run("wrong method", req("/api/pi/bypass/login"), 405);
console.log(fails ? `\n${fails} FAILED` : "\nALL PASS");
process.exit(fails ? 1 : 0);
