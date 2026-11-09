# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project rules (from AGENTS.md)

- Preserve the existing minimalist, responsive UI.
- Keep hardware-specific communication behind a service/data-adapter layer (`src/lib/pi-client.ts`, `pi-snapshot.ts`, `live-*.ts`), not inline in pages.
- **Stage rule (SPEC-stage-schedule):** The AI confirms the growth stage; the batch day decides *when* the AI checks and *which* stage it may confirm (day 1 = batch start date; Grower from day 11, Finisher from day 25; once a day at 10:00 Asia/Manila, only until the next stage is confirmed; an observe-only pre-check on day 10 and day 24 raises a "looks ready" alert but never changes the stage; forward only). All schedule values are constants in `raspberry-pi/stage_schedule.py`. The day alone never changes the stage. The only other way to change it is the owner's manual "Confirm real stage" on the maintenance site (any direction). See `SPEC-stage-schedule.md`. The day gates live only on the Pi (`raspberry-pi/stage_schedule.py`); the frontend shows them from the API and never recomputes them.
- **The main app never shows maintenance:** no simulated readings, no "manual"/"maintenance" labels. An AI detection is shown there only when it agrees with the confirmed stage, otherwise "—" (owner choice). Never invent or alter AI results; the maintenance site shows the real detection.

## Commands

Frontend (repo root, npm):

- `npm run dev` — Vite dev server (TanStack Start)
- `npm run build` — production build to `dist/` (client + `dist/server/server.js` for the Cloudflare Worker)
- `npm run lint` — ESLint; `npm run format` — Prettier

There is no app test suite. Verify changes with `npm run build` and `npm run lint`. The Pi gateway has Node tests: `npm run test:gateway` (`tests/pi-gateway/`, real ES256 tokens, mocked Pi); run them after any change to `pi-gateway.ts`. Python unit tests (standard-library `unittest`): `npm run test:stage-schedule` (`tests/stage-schedule/`) and `npm run test:auto-feeding` (`tests/auto-feeding/`).

Deploy the app Worker: `npm run build && npx wrangler deploy`. Deploy the maintenance Worker: `npm run deploy:maintenance` (builds `maintenance-site/` with `npm run build:maintenance`, then `npx wrangler deploy -c maintenance-site/wrangler.jsonc`). Rollback either: `npx wrangler versions list [-c maintenance-site/wrangler.jsonc]`, then `npx wrangler rollback <version-id>`. `telemetry-worker/` is retired (see its `RETIRED.md`); don't redeploy it.

Raspberry Pi backend: `python3 raspberry-pi/app.py` runs on the Pi only (needs `picamera2`, a serial-attached Arduino, and `ultralytics`/YOLO with `best.pt`). It can't run on a dev machine. Flask listens on **127.0.0.1:5000 only**, so smoke-test on the Pi itself: `curl http://127.0.0.1:5000/api/snapshot` (or `/api/status`, `/api/system/health`, `/api/ai/status`). Service: `poultrix.service` (`/home/raspberry/poultrix-api`, logs `journalctl -u poultrix`, persistent across reboots). Deploy **every changed Pi module together**: `app.py`, `stage_schedule.py`, `feeding_schedule.py` (a missing module broke `/api/feeding/sessions` once). Back up `app.py` before replacing it. Pi-side state files:
- `feeding_config.json`: batch start date, bird count, the automatic-feeding switch;
- `stage_schedule.json`: today's daily AI check;
- `stage_manual.json`: manual stage history;
- `trough_calibration.json`: trough zero and counts/g;
- `feeding_sessions.json`: automatic sessions, last 7 days;
- `feed_inventory.json`: compartments and stock estimates.

Arduino firmware (`arduino/firmware/poultrix_arduino.ino`, Arduino Mega) is built with arduino-cli / the Arduino IDE (`--fqbn arduino:avr:mega`). It can be flashed from the Pi: stop `poultrix`, back up with `avrdude -p m2560 -c wiring -P /dev/ttyACM0 -b 115200 -D -U flash:r:<backup>.hex:i`, write with `-U flash:w:<new>.hex:i`, start `poultrix`.

## Environment

- `VITE_SUPABASE_URL` / `VITE_SUPABASE_PUBLISHABLE_KEY` (client, build time; **required** in `.env.local`, or the bundle has no Supabase config and login breaks). `SUPABASE_URL` (wrangler var) / `SUPABASE_PUBLISHABLE_KEY` (Worker secret) are the server side.
- `POULTRIX_ALLOWED_EMAILS` (Worker secret, comma-separated): accounts allowed through the Pi gateway. Set with `npx wrangler secret put POULTRIX_ALLOWED_EMAILS`. An empty list refuses everyone.
- `POULTRIX_FEED_AUTOMATION_COMMISSIONED=YES_VERIFIED` (Pi env, `/etc/systemd/system/poultrix.service.d/feeding-commissioned.conf`): unlocks automatic feeding (set after Checkpoint F-B, 2026-11-08). Without it the Feeding page shows Locked.
- `POULTRIX_OWNER_EMAILS`: the owner account(s) allowed to restart / power off the Pi (SPEC-system-power) and to switch automatic feeding. Set it **both** as a Worker secret (`npx wrangler secret put POULTRIX_OWNER_EMAILS`) and on the Pi (`/etc/systemd/system/poultrix.service.d/owner.conf`). An empty list refuses everyone.
- There is no Pi URL setting: the browser never calls the Pi directly (`VITE_POULTRIX_API_URL` was removed).
- `.env.local` holds local values and is gitignored.

## Architecture

Four tiers. The browser talks only to the Cloudflare Worker (same origin); the Worker reaches the Pi through the cloudflared tunnel:

```
browser ──HTTPS──▶ Worker /api/pi/* (Supabase JWT + approved email + allowlist) ──VPC binding/tunnel──▶ Flask 127.0.0.1:5000 ──serial──▶ Arduino
```

1. **Arduino Mega firmware**: an environmental and feeding controller (DHT22, LDR, relays for fans/heater/LED, PCA9685 servo gates for feed compartments, HX711 hopper/trough load cells, LCD). It speaks a line-based serial protocol at 9600 baud: `STATUS`, `SYS:PING`/`SYS:READY`/`SYS:FAULT`, `STAGE:<STARTER|GROWER|FINISHER>`, `SENSOR:CHECK`, `FEED:DISPENSE:`/`FEED:STOP`/`FEED:ANGLE:`, `BYPASS:ON|OFF|PING`, `BYPASS:GROUP:`/`BYPASS:RELAY:`/`BYPASS:SIM:*`. **It is always automatic (no modes):** temperature and lighting control run every 2 s from boot (`BOOT:AUTO`). `MODE:*`, `TEMP:`, `LUX:` and `SERVO:ANGLE:` reply `ERROR:MODE_REMOVED`. The status block still prints `MODE_STATUS:LIVE` as a compatibility constant, plus `PI_STATUS:ONLINE|OFFLINE`. After 10 s without `SYS:PING` it reports `PI:OFFLINE`, stops feeding and closes the gates, but **keeps controlling fans, heater and LED**. Control has dead bands so a wobbling reading can't chatter a relay: heater on below the stage minimum, off at minimum + 0.3 °C; fan k on above max + (k-1) °C, off 0.3 °C below; LED on below 50 lux, off above 65 lux. Each relay also waits ≥ 30 s between automatic changes (fault switch-offs are immediate). `Wire.setWireTimeout` stops a noisy I2C transfer from freezing the controller. `FEED:DISPENSE` is refused (`FEED_ERROR:PI_OFFLINE`) while the Pi is offline, and while a maintenance gate/hole test is running. **Maintenance itself never blocks feeding**, and leaving maintenance never cuts a running feed. Maintenance can open one servo with `BYPASS:HOLE:<c>,<h>,<ms>` (catch and weigh a single hole). A DHT22 read failure turns heater and fans off. **Entering maintenance (`BYPASS:ON`) changes no output.** Automatic control keeps running during maintenance for every output not switched by hand; a `BYPASS:RELAY` output stays manual until `BYPASS:OFF` or the 10 s `BYPASS:PING` timeout. The Arduino is powered by the Pi's USB, so it's dark whenever the Pi is off.
2. **Raspberry Pi Flask API** (`raspberry-pi/app.py`, one large file). It owns the serial link and runs background threads: serial reader, heartbeat, camera, AI cycle, system health, simulation, and bypass watchdog. There is no SAFE/LIVE recovery system: `/api/mode/*` return 410, and `/api/recovery/status` is a short compatibility alias. `/api/status` reports `operatingStatus` (LIVE = connected, fresh telemetry, healthy), `arduinoOnline` and `piSeenByArduino`. Feeding and AI stage-apply require the controller to be online, healthy and seeing the Pi (AI stage-apply also waits for maintenance to end; feeding doesn't). YOLOv8 classification runs as vote-based 30-frame AI cycles.
   - **Stage schedule:** automatic cycles run only in the **daily window** (10:00 Asia/Manila, up to 6 cycles 5 min apart) on days with an allowed target. The logic is in `stage_schedule.py`; the attempt is persisted in `stage_schedule.json`.
   - **Transitions:** a detection counts only if it's an allowed, forward target for the batch day. The stage is sent to the Arduino after `AI_TRANSITION_CONFIRMATIONS_REQUIRED` (3) consecutive confident scheduled cycles, never during maintenance or dispensing. If it's not confirmed, the window retries the next day; the overdue days are reported.
   - **Analyze now / maintenance analysis:** a camera check only, never a stage change. `/api/ai/status` (and the snapshot) include `schedule` (day, phase, next check, overdue).
   - **New batch:** saving a different batch start date on days 1–10 sets STARTER.
   - **Manual stage:** `POST /api/bypass/confirm-stage` (maintenance token) sets any stage by hand and touches no AI field.
   - **Maintenance data:** simulated readings, `maintenanceActive` and `simulation` are returned **only** for requests with a valid maintenance token.
   - `/api/ai/acknowledge-finisher` is obsolete and returns 409.
   - **System power:** `POST /api/system/reboot` and `/api/system/power-off` (owner only, from `X-Poultrix-User`) stop feeding and maintenance first. Timed power-off (RTC wake) is **disabled** after it failed Checkpoint P-A; power-off always stays off. `/api/snapshot` returns status, AI, weight, health and feeding gates in one call (for the 5 s remote poll). Bypass login is limited to 5 failures / 10 min per user (429). State-changing requests are logged as `[AUDIT]` with the user from `X-Poultrix-User`, trusted only from localhost (the tunnel). Flask has **no CORS** and binds `127.0.0.1`. The `/api/test/*` routes were removed. **Feeding** (SPEC-auto-feeding):
   - **Session target:** per-stage constants (`FEED_FIXED_DAILY_GRAMS`, `FEED_SESSIONS`; 157.5 g for 7 Grower birds).
   - **Gate time:** the gate model `grams = FEED_OFFSETS + FEED_RATES × seconds`. Compartment 2: **52.2 g + 124.1 g/s**, measured 2026-11-08. Compartment 1: still the unmeasured 101.39 g/s. Use `feeding_schedule.gate_seconds/gate_grams`; never divide by the rate directly.
   - **Automatic feeding:** `feed_schedule_tick` / `run_feeding_session`, rough-check mode. The **full target** each session, **skipped only if a valid trough reading > target + 100 g**; an unreadable trough still feeds. A session is persisted before dispensing so it never repeats; up to 15 min late, otherwise missed; 3 faults switch it off.
   - **Trough:** the Pi computes trough grams itself from raw readings (calibration set on the maintenance site). Its zero drifts 50–80 g, so precise `target − trough` (`session_need`) is not used.
   - Saved to `feeding_config.json` / `feed_inventory.json`. The `/api/bypass/*` routes are a secret-protected maintenance/test console (`POULTRIX_BYPASS_SECRET`) with an 8 h session. A serial loss pauses the session (keeps the token, sets `manualControlsPaused` and `connectionLostAt`); `/api/bypass/resume` re-sends `BYPASS:ON`.
3. **Cloudflare Workers**
   - The main app (`wrangler.jsonc`, Worker `app` at `https://app.poultrix.workers.dev`; account subdomain `poultrix`) serves the SSR build. All Pi access uses the private `POULTRIX_HISTORY` VPC service binding (target `127.0.0.1:5000` via the tunnel).
   - **Pi gateway** `src/lib/server/pi-gateway.ts`: `createPiGateway({ routes, auth })` builds one handler per Worker from the explicit `ROUTES` table. Unlisted → 404, wrong method → 405. No query strings are forwarded, bodies are limited to 4 KB (413), and the Pi's JSON errors are passed through.
     - **Main app** (`handlePiGateway`, dispatched from `src/server.ts` for `/api/pi/*`): `APP_ROUTES` (26, **no bypass routes**), `auth: "supabase"`. Routes flagged `owner` (`system/reboot`, `system/power-off`, `feeding/automatic`) also need an email in `POULTRIX_OWNER_EMAILS` (403 `OWNER_ONLY`). The main gateway never forwards `X-Poultrix-Maintenance`. It verifies the Supabase ES256 access token locally (JWKS cached), then a confirmed email in `POULTRIX_ALLOWED_EMAILS`. 401 = signed out, 403 `NOT_APPROVED`. The camera (`/api/pi/camera/stream`, MJPEG) is the only route that accepts `?access_token=`.
     - **Maintenance site** (`handleMaintenanceGateway`): `MAINTENANCE_ROUTES` (14: `bypass/*` incl. `bypass/confirm-stage`, `bypass/trough-zero`, `bypass/trough-check`, `camera/stream`, `snapshot`), `auth: "maintenance"`, **no app login** (owner decision, accepted risk AD-21). It forwards the maintenance token on all its routes.
       - The Pi checks the bypass password (5 failures / 10 min per client IP) and the `X-Poultrix-Maintenance` token.
       - The Worker serves camera (`?maintenance_token=`) and snapshot only after validating the token with the Pi's `/api/bypass/status` (cached 30 s).
       - Every request carries `X-Poultrix-User: ip:<CF-Connecting-IP>`.
   - **Maintenance Worker** `maintenance` (`maintenance-site/`, https://maintenance.poultrix.workers.dev):
     - `worker.ts` sends `/api/pi/*` to the maintenance gateway and serves the console from assets with security headers.
     - The console (`maintenance-site/src/Console.tsx`, Vite + React, `@/` aliased to `src/`) is the only bypass UI: unlock, live camera, status strip, relays, gate groups and **single holes**, sensor tests, **Confirm real stage** (any stage, with the real AI detection panel), **Trough scale** (Zero trough + 500 g check), Return to automatic, Resume, Exit.
     - Same VPC service binding as the main app. The main app has **no** bypass page or link.
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
   - **Stage schedule UI:** `src/components/poultrix/StageSchedule.tsx` (`BatchDaySummary`, `BatchTimeline` on the Flock page). The overdue stage check is also an alert (`stage-overdue-<STAGE>-<date>`). `agreeingDetection()` in `live-hardware.ts` gates every AI detection display.
   - **System power:** `SystemPowerCard.tsx` on Settings (Restart, Power off = stays off), owner only.
   - **Automatic feeding:** `AutoFeedingCard.tsx` on the Feeding page (owner switch, next session, today's sessions with reasons). Reason texts live in `src/lib/feeding-reasons.ts`; feeding alerts are in `live-alerts.ts`.
   - `src/lib/demo-data.ts` is legacy mock data that some pages (cycle, flock, profile, settings, parts of AppShell/ui) still import. Don't present demo values as real sensor readings. Bypass simulation readings must never be shown as live.
   - Supabase (`src/integrations/supabase/`, mostly generated) handles auth and the `farm` table (`src/lib/farm-store.ts`). `src/start.ts` registers the auth-attacher function middleware plus CSRF protection for server functions. Migrations are in `supabase/migrations/`.

## Domain constraints

- There are three stages: STARTER, GROWER, FINISHER. The backend and firmware use uppercase, and the UI uses capitalized names (`stageName()` maps between them).
- Hopper/trough weights arrive in grams from the Arduino and are shown in kg for display only. The trough is calibrated on the Pi (maintenance site); the hopper's calibration is still the firmware's. Don't add calibration constants or feed rates in the frontend.
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

