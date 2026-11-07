// Worker for the maintenance site. /api/pi/* goes to the maintenance gateway
// (bypass routes, camera and snapshot only; see SPEC-maintenance-site.md);
// everything else is the static console app.
import { handleMaintenanceGateway, PI_GATEWAY_PREFIX, type PiGatewayEnv } from "../src/lib/server/pi-gateway";

type Env = PiGatewayEnv & { ASSETS: { fetch: (request: Request) => Promise<Response> } };

const SECURITY_HEADERS: Record<string, string> = {
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname.startsWith(`${PI_GATEWAY_PREFIX}/`)) return handleMaintenanceGateway(request, env);
    if (pathname.startsWith("/api/")) {
      return new Response(JSON.stringify({ error: "Not found" }), {
        status: 404,
        headers: { "content-type": "application/json; charset=utf-8", ...SECURITY_HEADERS },
      });
    }
    const asset = await env.ASSETS.fetch(request);
    const response = new Response(asset.body, asset);
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) response.headers.set(name, value);
    // The console holds a live session token; never let it be cached.
    if ((response.headers.get("content-type") ?? "").includes("text/html")) response.headers.set("cache-control", "no-store");
    return response;
  },
};
