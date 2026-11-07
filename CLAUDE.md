# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project rules (from AGENTS.md)

- Preserve the existing minimalist, responsive UI.
- Keep hardware-specific communication behind a service/data-adapter layer (`src/lib/pi-client.ts`, `pi-snapshot.ts`, `live-*.ts`), not inline in pages.
- **The AI-classified growth stage is the active stage source.** Age/day information (batch start date, `referenceDays` in `src/lib/stage-requirements.ts`) is reference-only and must never drive stage selection.

## Commands

Frontend (repo root, npm):

- `npm run dev` — Vite dev server (TanStack Start)
- `npm run build` — production build to `dist/` (client + `dist/server/server.js` for the Cloudflare Worker)
- `npm run lint` — ESLint; `npm run format` — Prettier

There is no test suite. Verify changes with `npm run build` and `npm run lint`.

Deploy the app Worker: `npm run build && npx wrangler deploy` (rollback: `npx wrangler versions list`, then `npx wrangler rollback <version-id>`). `telemetry-worker/` is retired (see its `RETIRED.md`); don't redeploy it.

Raspberry Pi backend: `python3 raspberry-pi/app.py` runs on the Pi only (needs `picamera2`, a serial-attached Arduino, and `ultralytics`/YOLO with `best.pt`). It can't run on a dev machine. Flask listens on **127.0.0.1:5000 only**, so smoke-test on the Pi itself: `curl http://127.0.0.1:5000/api/snapshot` (or `/api/status`, `/api/system/health`, `/api/ai/status`). Service: `poultrix.service` (`/home/raspberry/poultrix-api`, logs `journalctl -u poultrix`). Back up `app.py` before replacing it.

Arduino firmware (`arduino/firmware/poultrix_arduino.ino`, Arduino Mega) is built and flashed with the Arduino IDE.

## Environment

- `VITE_SUPABASE_URL` / `VITE_SUPABASE_PUBLISHABLE_KEY` (client, build time; **required** in `.env.local`, or the bundle has no Supabase config and login breaks). `SUPABASE_URL` (wrangler var) / `SUPABASE_PUBLISHABLE_KEY` (Worker secret) are the server side.
- `POULTRIX_ALLOWED_EMAILS` (Worker secret, comma-separated): accounts allowed through the Pi gateway. Set with `npx wrangler secret put POULTRIX_ALLOWED_EMAILS`. An empty list refuses everyone.
- There is no Pi URL setting: the browser never calls the Pi directly (`VITE_POULTRIX_API_URL` was removed).
- `.env.local` holds local values and is gitignored.

## Architecture

Four tiers. The browser talks only to the Cloudflare Worker (same origin); the Worker reaches the Pi through the cloudflared tunnel:

```
browser ──HTTPS──▶ Worker /api/pi/* (Supabase JWT + approved email + allowlist) ──VPC binding/tunnel──▶ Flask 127.0.0.1:5000 ──serial──▶ Arduino
```

1. **Arduino Mega firmware**: an environmental and feeding controller (DHT22, LDR, relays for fans/heater/LED, PCA9685 servo gates for feed compartments, HX711 hopper/trough load cells, LCD). It speaks a line-based serial protocol at 9600 baud: `STATUS`, `SYS:PING`/`SYS:READY`/`SYS:FAULT`, `STAGE:<STARTER|GROWER|FINISHER>`, `SENSOR:CHECK`, `FEED:DISPENSE:`/`FEED:STOP`/`FEED:ANGLE:`, `BYPASS:ON|OFF|PING`, `BYPASS:GROUP:`/`BYPASS:RELAY:`/`BYPASS:SIM:*`. **It is always automatic (no modes):** temperature and lighting control run every 2 s from boot (`BOOT:AUTO`). `MODE:*`, `TEMP:`, `LUX:` and `SERVO:ANGLE:` reply `ERROR:MODE_REMOVED`. The status block still prints `MODE_STATUS:LIVE` as a compatibility constant, plus `PI_STATUS:ONLINE|OFFLINE`. After 10 s without `SYS:PING` it reports `PI:OFFLINE`, stops feeding and closes the gates, but **keeps controlling fans, heater and LED**. `FEED:DISPENSE` is refused (`FEED_ERROR:PI_OFFLINE`) while the Pi is offline. A DHT22 read failure turns heater and fans off. Maintenance (bypass) times out after 10 s without `BYPASS:PING` and returns to automatic control.
2. **Raspberry Pi Flask API** (`raspberry-pi/app.py`, one large file). It owns the serial link and runs background threads: serial reader, heartbeat, camera, AI cycle, system health, simulation, and bypass watchdog. There is no SAFE/LIVE recovery system: `/api/mode/*` return 410, and `/api/recovery/status` is a short compatibility alias. `/api/status` reports `operatingStatus` (LIVE = connected, fresh telemetry, healthy), `arduinoOnline` and `piSeenByArduino`. Feeding and AI stage-apply require the controller to be online, healthy and seeing the Pi. YOLOv8 classification runs as vote-based AI cycles. A stage change (between any pair of stages) is sent to the Arduino after `AI_TRANSITION_CONFIRMATIONS_REQUIRED` (3) consecutive confident cycles. `/api/ai/acknowledge-finisher` is obsolete and returns 409. `/api/snapshot` returns status, AI, weight, health and feeding gates in one call (for the 5 s remote poll). Bypass login is limited to 5 failures / 10 min per user (429). State-changing requests are logged as `[AUDIT]` with the user from `X-Poultrix-User`, trusted only from localhost (the tunnel). Flask has **no CORS** and binds `127.0.0.1`. The `/api/test/*` routes were removed. Feeding plans come from per-stage constants (`FEED_FIXED_DAILY_GRAMS`, `FEED_SESSIONS`, `FEED_RATES`) and are saved to `feeding_config.json` / `feed_inventory.json`. The `/api/bypass/*` routes are a secret-protected maintenance/test console (`POULTRIX_BYPASS_SECRET`) with an 8 h session. A serial loss pauses the session (keeps the token, sets `manualControlsPaused` and `connectionLostAt`); `/api/bypass/resume` re-sends `BYPASS:ON`.
3. **Cloudflare Workers**
   - The main app (`wrangler.jsonc`, Worker `poultrix` at `poultrix.johnkarlduenas.workers.dev`) serves the SSR build. All Pi access uses the private `POULTRIX_HISTORY` VPC service binding (target `127.0.0.1:5000` via the tunnel).
   - **Pi gateway** `src/lib/server/pi-gateway.ts`, dispatched from `src/server.ts` for `/api/pi/*`:
     - **Auth:** verifies the Supabase ES256 access token locally (JWKS cached), then checks a confirmed email against `POULTRIX_ALLOWED_EMAILS`. 401 = signed out, 403 `NOT_APPROVED`.
     - **Allowlist:** an explicit `ROUTES` table maps each `/api/pi/<x>` to a fixed Pi path. Unlisted → 404, wrong method → 405. No query strings are forwarded, and bodies are limited to 4 KB (413).
     - **Bypass routes:** also forward `X-Poultrix-Maintenance`.
     - **Camera:** `/api/pi/camera/stream` streams MJPEG and is the only route that accepts `?access_token=`.
     - **Errors:** the Pi's JSON errors are passed through.
   - **Rule:** add a Pi route by adding a table entry; never forward arbitrary paths or methods, and never build the upstream URL from the request.
   - Other server routes: `src/server.ts` also handles `/api/history` itself (Supabase check, fixed upstream path), and `src/routes/api/alerts/acknowledgements.ts` syncs alert acknowledgements.
   - The telemetry mirror (`telemetry-worker/`, `poultrix_telemetry_uploader.py`) is **retired**: the Worker was deleted and the uploader disabled.
4. **Frontend**: TanStack Start + React 19, file-based routes in `src/routes/` (see `src/routes/README.md` for routing conventions; `routeTree.gen.ts` is generated, so don't edit it). Tailwind v4 and shadcn/ui primitives are in `src/components/ui/`. App-specific components are in `src/components/poultrix/`, and `AppShell.tsx` is the layout/nav plus a read-only system status pill (Online / Connecting / Arduino offline / Pi offline). There is no mode toggle.
   - **Pi access only through `src/lib/pi-client.ts`:**
     - `piFetch("/feeding/config")` → `/api/pi/...` with the Supabase bearer. A 401 triggers one refresh + retry, and failures throw a typed `PiError`.
     - `authorizedFetch` is for other same-origin Worker routes.
   - **Live data comes from one shared poller,** `src/lib/pi-snapshot.ts`: `/api/pi/snapshot` every 5 s while the tab is visible, paused while hidden.
     - `useHardware`, `useAI` and `useLiveAlerts` read from it, and `live-endpoints.ts` (`usePiEndpoint`, `usePiResource`, `useCameraStreamUrl`) serves page data.
     - **Request budget:** the Workers free plan allows 100k requests/day, so don't add fast polls. Prefer snapshot fields; poll slow-changing resources every 30–60 s.
     - Alert acknowledgements sync every 60 s.
   - `src/lib/demo-data.ts` is legacy mock data that some pages (cycle, flock, profile, settings, parts of AppShell/ui) still import. Don't present demo values as real sensor readings. Bypass simulation readings must never be shown as live.
   - Supabase (`src/integrations/supabase/`, mostly generated) handles auth and the `farm` table (`src/lib/farm-store.ts`). `src/start.ts` registers the auth-attacher function middleware plus CSRF protection for server functions. Migrations are in `supabase/migrations/`.

## Domain constraints

- There are three stages: STARTER, GROWER, FINISHER. The backend and firmware use uppercase, and the UI uses capitalized names (`stageName()` maps between them).
- Hopper/trough weights arrive in grams from the Arduino and are shown in kg for display only. Calibration is provisional, so don't add calibration constants in the frontend.
- Flask itself has no auth (bypass needs the maintenance token). It is safe only because it binds `127.0.0.1` and is reached through the authenticated gateway. Never bind it to `0.0.0.0`, add CORS, add a public tunnel hostname or port-forward to it, or expose a Pi path without adding it to the gateway allowlist.
- `documents/POULTRIX_Philippine_Standards.txt` (PCARRD-DOST) is the reference for stage temperature and lighting targets.

## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

Rules:
- When graphify-out/graph.json exists, run `graphify query "<question>"` before your first grep, search or source-file read for a codebase question, and put this rule in every subagent prompt that explores code. Read raw files only for lines the graph or an earlier read already located. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).
- A committed graphify-out/graph.json is rewritten whole on every build, so a large diff to it in a pull request is expected. Do not flag it as churn or suggest skipping the graph rebuild or its hooks.

## Project Knowledge Base

Obsidian vault:
C:/Users/johnk/Documents/Obsidian/Poultrix

Before major development:
1. Read 00-Index/HOME.md.
2. Read 00-Index/CURRENT_STATUS.md.
3. Read the relevant feature and architecture notes.

After significant changes:
1. Update relevant documentation.
2. Record important technical decisions.
3. Update CURRENT_STATUS.md.
4. Record testing results and unresolved issues.

