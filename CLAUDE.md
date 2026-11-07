# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project rules (from AGENTS.md)

- Preserve the existing minimalist, responsive UI.
- Keep hardware-specific communication behind a service/data-adapter layer (`src/lib/live-*.ts`), not inline in pages.
- **The AI-classified growth stage is the active stage source.** Age/day information (batch start date, `referenceDays` in `src/lib/stage-requirements.ts`) is reference-only and must never drive stage selection.

## Commands

Frontend (repo root, npm):

- `npm run dev` — Vite dev server (TanStack Start)
- `npm run build` — production build to `dist/` (client + `dist/server/server.js` for the Cloudflare Worker)
- `npm run lint` — ESLint; `npm run format` — Prettier

There is no test suite. Verify changes with `npm run build` and `npm run lint`.

Telemetry worker: `cd telemetry-worker && npm run deploy` (wrangler).

Raspberry Pi backend: `python3 raspberry-pi/app.py` runs on the Pi only (needs `picamera2`, a serial-attached Arduino, and `ultralytics`/YOLO with `best.pt`). It can't run on a dev machine. Smoke-test on the Pi with `curl http://127.0.0.1:5000/api/status`, `/api/system/health`, `/api/feeding/weight`, `/api/feeding/status`, `/api/ai/status`.

Arduino firmware (`arduino/firmware/poultrix_arduino.ino`, Arduino Mega) is built and flashed with the Arduino IDE.

## Environment

- `VITE_POULTRIX_API_URL`: base URL of the Pi Flask API, read at build time. It defaults to `http://192.168.1.48:5000`, which only works on the LAN. An HTTPS deployment can't fetch a private HTTP IP.
- `VITE_SUPABASE_URL` / `VITE_SUPABASE_PUBLISHABLE_KEY` (client), `SUPABASE_URL` / `SUPABASE_PUBLISHABLE_KEY` (server/Worker env). These are used for auth and the farm profile.
- `.env.local` holds local values and is gitignored.

## Architecture

Four tiers. The browser talks to most of them directly:

1. **Arduino Mega firmware**: an environmental and feeding controller (DHT22, LDR, relays for fans/heater/LED, PCA9685 servo gates for feed compartments, HX711 hopper/trough load cells, LCD). It speaks a line-based serial protocol at 9600 baud: `STATUS`, `SYS:PING`/`SYS:READY`/`SYS:FAULT`, `STAGE:<STARTER|GROWER|FINISHER>`, `SENSOR:CHECK`, `FEED:DISPENSE:`/`FEED:STOP`/`FEED:ANGLE:`, `BYPASS:ON|OFF|PING`, `BYPASS:GROUP:`/`BYPASS:RELAY:`/`BYPASS:SIM:*`. **It is always automatic (no modes):** temperature and lighting control run every 2 s from boot (`BOOT:AUTO`). `MODE:*`, `TEMP:`, `LUX:` and `SERVO:ANGLE:` reply `ERROR:MODE_REMOVED`. The status block still prints `MODE_STATUS:LIVE` as a compatibility constant, plus `PI_STATUS:ONLINE|OFFLINE`. After 10 s without `SYS:PING` it reports `PI:OFFLINE`, stops feeding and closes the gates, but **keeps controlling fans, heater and LED**. `FEED:DISPENSE` is refused (`FEED_ERROR:PI_OFFLINE`) while the Pi is offline. A DHT22 read failure turns heater and fans off. Maintenance (bypass) times out after 10 s without `BYPASS:PING` and returns to automatic control.
2. **Raspberry Pi Flask API** (`raspberry-pi/app.py`, one large file). It owns the serial link and runs background threads: serial reader, heartbeat, camera, AI cycle, system health, simulation, and bypass watchdog. There is no SAFE/LIVE recovery system: `/api/mode/*` return 410, and `/api/recovery/status` is a short compatibility alias. `/api/status` reports `operatingStatus` (LIVE = connected, fresh telemetry, healthy), `arduinoOnline` and `piSeenByArduino`. Feeding and AI stage-apply require the controller to be online, healthy and seeing the Pi. YOLOv8 classification runs as vote-based AI cycles. A stage change (between any pair of stages) is sent to the Arduino after `AI_TRANSITION_CONFIRMATIONS_REQUIRED` (3) consecutive confident cycles. `/api/ai/acknowledge-finisher` is obsolete and returns 409. Feeding plans come from per-stage constants (`FEED_FIXED_DAILY_GRAMS`, `FEED_SESSIONS`, `FEED_RATES`) and are saved to `feeding_config.json` / `feed_inventory.json`. The `/api/bypass/*` routes are a secret-protected maintenance/test console (`POULTRIX_BYPASS_SECRET`) with an 8 h session. A serial loss pauses the session (keeps the token, sets `manualControlsPaused` and `connectionLostAt`); `/api/bypass/resume` re-sends `BYPASS:ON`.
3. **Cloudflare Workers**
   - The main app (`wrangler.jsonc`) serves the SSR build. Server-only routes `src/routes/api/history.ts` and `src/routes/api/alerts/acknowledgements.ts` check the Supabase bearer token and then call the Pi over the private `POULTRIX_HISTORY` VPC service binding (fixed `http://127.0.0.1:5000/...` paths). Never turn these into a generic proxy for Flask paths. `src/server.ts` wraps the TanStack server entry with error-page normalization and a duplicate `/api/history` handler.
   - `telemetry-worker/` is a read-only Durable Object mirror. `raspberry-pi/poultrix_telemetry_uploader.py` POSTs `/api/status` to `/ingest` every 3 s using `POULTRIX_INGEST_TOKEN`. The worker whitelists fields and serves `/api/status`, `/api/ai/status`, and `/api/feeding/weight`, and marks data stale after 15 s. It exposes no control routes.
4. **Frontend**: TanStack Start + React 19, file-based routes in `src/routes/` (see `src/routes/README.md` for routing conventions; `routeTree.gen.ts` is generated, so don't edit it). Tailwind v4 and shadcn/ui primitives are in `src/components/ui/`. App-specific components are in `src/components/poultrix/`, and `AppShell.tsx` is the layout/nav plus a read-only system status pill (Online / Connecting / Arduino offline / Pi offline). There is no mode toggle.
   - Live data comes from polling the Pi directly from the browser through `API_URL` in `src/lib/live-hardware.ts`. `useHardware` polls `/api/status` every 3 s and `useAI` polls `/api/ai/status` every 1 s. `live-weights.ts` and `live-alerts.ts` cover weights and a shared 3 s alert snapshot (acknowledgements are synced through the Worker route with the Supabase session). New backend calls should go through these adapters.
   - `src/lib/demo-data.ts` is legacy mock data that some pages (cycle, flock, profile, settings, parts of AppShell/ui) still import. Don't present demo values as real sensor readings. Bypass simulation readings must never be shown as live.
   - Supabase (`src/integrations/supabase/`, mostly generated) handles auth and the `farm` table (`src/lib/farm-store.ts`). `src/start.ts` registers the auth-attacher function middleware plus CSRF protection for server functions. Migrations are in `supabase/migrations/`.

## Domain constraints

- There are three stages: STARTER, GROWER, FINISHER. The backend and firmware use uppercase, and the UI uses capitalized names (`stageName()` maps between them).
- Hopper/trough weights arrive in grams from the Arduino and are shown in kg for display only. Calibration is provisional, so don't add calibration constants in the frontend.
- Actuator endpoints (feeding dispense, feeding stop, sensor check) are unauthenticated on the Pi; bypass needs the maintenance token. Don't expose them publicly or widen CORS for public deployments.
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

