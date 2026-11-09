# POULTRIX: System Context for a New AI Session

> Read this first. It summarizes what Poultrix is, how it is built, the rules the owner has set, and where things stand (as of **2026-11-09**). For deeper detail see `CLAUDE.md`, `AGENTS.md`, the `SPEC-*.md` files, and the Obsidian vault (`C:/Users/johnk/Documents/Obsidian/Poultrix`).

---

## 1. What Poultrix is

Poultrix is an automated broiler (meat chicken) house controller for a small farm in the Philippines (timezone **Asia/Manila**). It:

- **Controls the climate.** Heater lamps, up to 3 fans and an LED grow light are switched automatically from temperature (DHT22) and light (LDR) readings, using stage-specific targets from `documents/POULTRIX_Philippine_Standards.txt` (PCARRD-DOST).
- **Feeds the birds.** It has two feed compartments with servo gates (PCA9685) above a trough. Load cells (HX711) weigh the **hopper** and the **trough**. Feeding runs on a schedule with fixed per-stage targets.
- **Classifies the growth stage with AI.** A Pi camera plus a YOLOv8 classifier (`best.pt`) recognizes STARTER, GROWER or FINISHER, at controlled times tied to the batch day.
- **Shows the farm remotely.** A web app (phone and PC) shows the dashboard, a live camera, feeding, alerts, history and settings, from anywhere (including mobile data).
- **Has a maintenance console** on a separate site: password-protected relay, gate and sensor tests, trough calibration, and manual stage confirmation.

Current flock: **7 birds**, Grower stage (the batch date makes 2026-11-08 day 18).

---

## 2. Architecture (four tiers)

```
browser ──HTTPS──▶ Cloudflare Worker /api/pi/* (Supabase JWT + approved email + route allowlist)
        ──VPC service binding / cloudflared tunnel──▶ Flask 127.0.0.1:5000 on Raspberry Pi
        ──USB serial 9600 baud──▶ Arduino Mega (sensors, relays, servos, load cells, LCD)
```

The browser **never** talks to the Pi directly.

### 2.1 Arduino Mega firmware: `arduino/firmware/poultrix_arduino.ino`
- **Hardware:** DHT22, LDR, relays (fans, heater, LED), PCA9685 servo gates (2 compartments × 5 holes), HX711 hopper and trough load cells, LCD.
- **Always automatic:** there are no modes. Climate control runs every 2 s from boot (`BOOT:AUTO`). The old `MODE:*`, `TEMP:`, `LUX:` and `SERVO:ANGLE:` commands reply `ERROR:MODE_REMOVED`.
- **Serial protocol (line-based):**
  - status and heartbeat: `STATUS`, `SYS:PING`/`SYS:READY`/`SYS:FAULT`;
  - stage and sensors: `STAGE:<STARTER|GROWER|FINISHER>`, `SENSOR:CHECK`;
  - feeding: `FEED:DISPENSE:...`, `FEED:STOP`, `FEED:ANGLE:`;
  - maintenance: `BYPASS:ON|OFF|PING`, `BYPASS:GROUP:`, `BYPASS:RELAY:`, `BYPASS:SIM:*`, `BYPASS:HOLE:<c>,<h>,<ms>`.
- **Pi offline:** with no `SYS:PING` for 10 s it reports `PI:OFFLINE`, stops feeding and closes the gates, but **keeps controlling the climate**.
- **Dead bands and rate limits:**
  - heater on below the stage minimum, off at minimum + 0.3 °C;
  - fan k on above maximum + (k−1) °C, off 0.3 °C below that;
  - at least 30 s between automatic changes of a relay (fault switch-offs are immediate).
- **LED (current firmware):** on below 50 lux; once on, it stays on until the light is above 250 lux for 5 minutes in a row. The LDR sees the LED's own light (about 70–86 lux). The LED stays off while the heater lamps are on.
- **Maintenance behavior:**
  - entering maintenance (`BYPASS:ON`) changes **no** output;
  - automatic control continues for every output not switched by hand;
  - a manually switched relay stays manual until `BYPASS:OFF` or a 10 s `BYPASS:PING` timeout;
  - maintenance never blocks feeding.
- **Safety:** a DHT22 read failure switches the heater and fans off. `Wire.setWireTimeout` keeps a noisy I2C bus from hanging the controller.
- **Hopper:** the LCD shows the last raw value the hopper reported, and a status report waits up to 110 ms for the HX711.
- **Power:** the Arduino is powered by the Pi's USB, so it goes dark whenever the Pi is off.
- **Flash history (newest first):** `2288e72b` (current, LED daylight hold) ← `cedda118` ← `81a0306b` ← `fdbe0dad` ← `764f74c2`.

### 2.2 Raspberry Pi backend: `raspberry-pi/`
- **Modules:** `app.py` (one large Flask file), `stage_schedule.py` (pure stage-schedule logic), `feeding_schedule.py` (pure feeding math). **Always deploy all three together.**
- **Runtime:** systemd service `poultrix` in `/home/raspberry/poultrix-api` (venv), logs with `journalctl -u poultrix`. Flask binds **127.0.0.1:5000 only**, with **no CORS** and no auth of its own.
- **Background threads:** serial reader, heartbeat, camera, AI cycle, system health, simulation, bypass watchdog, feeding scheduler.
- **State files** (next to `app.py`):

  | File | Contents |
  |---|---|
  | `feeding_config.json` | batch start date, bird count, automatic-feeding switch |
  | `stage_schedule.json` | today's daily AI check attempt |
  | `stage_manual.json` | manual stage history |
  | `trough_calibration.json` | trough zero and counts per gram |
  | `feeding_sessions.json` | automatic feeding sessions (7 days) |
  | `feed_inventory.json` | compartments, feed types, stock estimates, refills |
  | `ai_last_agreeing.json` | last real confident AI reading that matched the confirmed stage |

- **Key endpoints:**
  - `/api/snapshot`: status, AI, weight, health and gates in one call, polled every 5 s by the app;
  - `/api/status`, `/api/ai/status`, `/api/system/health`;
  - `/api/feeding/*`: config, inventory, assign, sessions, automatic, `batch/start`;
  - `/api/bypass/*`: maintenance only, token-protected;
  - `/api/system/reboot` and `/api/system/power-off`: owner only.
- **Audit:** state-changing requests are logged as `[AUDIT]` with the user from the `X-Poultrix-User` header, which is trusted only from localhost (the tunnel).
- **Env (systemd drop-ins in `/etc/systemd/system/poultrix.service.d/`):**
  - `POULTRIX_FEED_AUTOMATION_COMMISSIONED=YES_VERIFIED` unlocks automatic feeding;
  - `POULTRIX_OWNER_EMAILS` lists the owner account(s);
  - `POULTRIX_BYPASS_SECRET` is the maintenance password.

### 2.3 Cloudflare Workers (free plan: 100k requests/day, so **no fast polls**)
- **Main app:** Worker `app`, https://app.poultrix.workers.dev, config `wrangler.jsonc`.
  - It serves the TanStack Start SSR build.
  - The Pi gateway is `src/lib/server/pi-gateway.ts`: `createPiGateway({routes, auth})` builds a handler from an explicit **route table**.
    - Unlisted paths → 404; wrong method → 405.
    - No query strings are forwarded; bodies are limited to 4 KB.
  - **Main app routes (27, no bypass routes):** auth is a Supabase ES256 JWT, verified locally against cached JWKS, plus a confirmed email in `POULTRIX_ALLOWED_EMAILS`.
    - A request without a valid session gets 401; an email not on the list gets 403 `NOT_APPROVED`.
    - **Owner-only routes:** `system/reboot`, `system/power-off`, `feeding/automatic`, `feeding/batch/start`. They need an email in `POULTRIX_OWNER_EMAILS`; anyone else gets 403 `OWNER_ONLY`.
    - The camera MJPEG route is the only one that accepts `?access_token=`.
- **Maintenance site:** Worker `maintenance`, https://maintenance.poultrix.workers.dev, folder `maintenance-site/`.
  - 14 routes and **no app login** (an accepted risk, AD-21).
  - The Pi checks the maintenance password (5 failures per 10 min) and the token.
  - The console is `maintenance-site/src/Console.tsx`. It covers:
    - unlock, live camera and status;
    - relays, gate groups and single holes;
    - sensor tests;
    - **Confirm real stage** (any direction, showing the real AI detection);
    - **Trough scale** (zero and a 500 g check);
    - Exit.
- **Retired:** `telemetry-worker/`. Don't redeploy it.

### 2.4 Frontend: `src/`
- **Stack:** TanStack Start, React 19, Tailwind v4 and shadcn/ui.
  - Routes live in `src/routes/`; `routeTree.gen.ts` is generated, so don't edit it.
  - App components live in `src/components/poultrix/`.
- **Pi access:** only through `src/lib/pi-client.ts` (`piFetch`).
  - **Live data:** one shared poller, `src/lib/pi-snapshot.ts`, fetches `/api/pi/snapshot` every 5 s while the tab is visible.
  - **Hooks:** `useHardware`, `useAI` and `useLiveAlerts` (in `live-hardware.ts` and `live-alerts.ts`); `live-endpoints.ts` serves page data.
  - Slow resources poll every 30–60 s at most.
- **Pages:**
  - **Dashboard (`/`):** sensors, the Confirmed growth stage card (AI confidence, Last analyzed, live countdown to the next AI check), and Next scheduled feeding (compartment 1 green `#8acb32`, compartment 2 orange `#f59a30`).
  - **Feeding:** inventory, feed-type assignment and `AutoFeedingCard`.
  - **Flock:** `BatchTimeline`.
  - **Settings:** `SystemPowerCard`.
  - **Login:** the montage video on PC, logo only on phones, email/password and **Continue with Google**.
- **Auth and data:** Supabase (project `sutmrdrkhnxouyhdzoxv`) handles auth (email and Google OAuth) and the `farm` table.
- **Legacy:** `src/lib/demo-data.ts` is old mock data. Never present it as real readings.

---

## 3. Core domain rules

### 3.1 Growth stage (SPEC-stage-schedule)
- **The AI confirms the stage; the batch day only decides when the AI checks and which stage it may confirm.**
  - Day 1 is the batch start date.
  - Grower is allowed from **day 11**, Finisher from **day 25**.
  - Stages only move forward.
- **Thesis-panel schedule (§10, 2026-11-09):**
  - no scheduled checks on Days 1–9, or between Grower confirmed and Day 23;
  - an **observe-only pre-check on Day 10 and Day 24**. It never changes the stage; after 3 confident next-stage cycles it raises a "Flock looks ready" alert (no confidence shown);
  - daily checks from Day 11 / Day 25 until the stage is confirmed;
  - none after Finisher.
  - All values are constants in `stage_schedule.py`; `PRE_CHECK_DAYS_BEFORE = 0` turns pre-checks off.
- **Daily check window:** opens at **10:00 Asia/Manila**. It may *start* only before 11:00 (`DAILY_START_LATEST`) and runs up to 6 cycles, 5 min apart.
- **Confirmation:** the stage changes after **3 consecutive confident scheduled cycles** agree. It never changes during maintenance or dispensing. If no change is confirmed, the check retries the next day, and the overdue days are reported (there is an alert for it).
- **Not a stage change:** "Analyze now" and maintenance analyses are camera checks only.
- **Manual stage:** the owner's "Confirm real stage" on the maintenance site (`POST /api/bypass/confirm-stage`) can set any stage, in either direction.
- **Batch date:**
  - **"Start new batch"** (owner only) sets Starter and runs an AI check immediately.
  - **"Save"** only corrects the date and never resets the stage.
- **Where the gates live:** the day gates exist only on the Pi (`stage_schedule.py`). The frontend displays them from the API and never recomputes them.

### 3.2 AI display honesty (firm owner and project rule)
- **Agreeing readings only:** the main app shows an AI detection only when it **agrees** with the confirmed stage (`agreeingDetection()`); otherwise it shows "—".
- **Fallback confidence:** when the latest reading disagrees, the confidence shown is the last real matching reading (`lastAgreeingDetection`, from memory or the history DB).
- **"Last analyzed"** is the last *scheduled* daily check.
- **Never fabricate or alter AI readings.** The owner asked twice for invented confidence values and was declined; honest alternatives were built instead.
- **No trace of maintenance in the main app:** no simulated readings and no "manual" or "maintenance" labels. Maintenance data is returned only to requests with a valid maintenance token. The maintenance site shows the real detection.

### 3.3 Feeding (SPEC-auto-feeding, "rough-check mode")
- **Session target:** fixed per stage (`FEED_FIXED_DAILY_GRAMS`, `FEED_SESSIONS`). For 7 Grower birds that is 157.5 g per session.
- **Gate model:** grams = offset + rate × seconds.
  - Compartment 2: **52.2 g + 124.1 g/s** (measured 2026-11-08).
  - Compartment 1: **unmeasured** (101.39 g/s, offset 0).
  - Always use `feeding_schedule.gate_seconds/gate_grams`; never divide by the rate directly.
- **Session rules:**
  - Each session dispenses the **full target**.
  - It is skipped **only if** a valid trough reading is above target + 100 g. An unreadable trough still feeds.
  - The trough zero drifts 50–80 g, so the precise `target − trough` is not used.
- **Compartment choice:**
  - only stage-compatible compartments above their low level;
  - a **measured gate first** (`FEED_GATE_MEASURED = {1: False, 2: True}`), then the one with more stock.
- **Feed type change:** a compartment can change feed type only after "emptied + kg now" is confirmed; otherwise the request gets 409 `NOT_EMPTY`.
- **Safeguards:**
  - each session is saved **before** dispensing, so it never repeats;
  - a session can run up to 15 min late; after that it is marked missed;
  - 3 faults switch automatic feeding off.
- **Enabling:** automatic feeding needs the commissioning env **and** the owner's switch.

### 3.4 System power (SPEC-system-power)
- **Who and how:** Restart and Power off are owner only, on the Settings page. They stop feeding and maintenance first.
- **Power off stays off:** timed power-off (RTC wake) is **disabled** because it failed Checkpoint P-A.

---

## 4. Working rules for the AI assistant (owner-set, must follow)

1. **Spec-driven development.** Write a spec, get the owner's approval, plan, then implement, for any non-trivial feature. Specs are `SPEC-*.md`; the module index is `CAPABILITY_MAP.md`; tasks are in `tasks/`.
2. **Commit or push only when the owner says so** (usually "commit and push"). Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never commit secrets (`.env.local`, the bypass secret).
3. **Production actions need an explicit "deploy" each time.** This covers wrangler deploys, Pi deploys and firmware flashes.
4. **Pi access:** SSH with a password (ask the owner) through a temporary askpass script that is deleted afterwards. **Do not install SSH keys on the Pi.**
5. **Never** bind Flask to `0.0.0.0`, add CORS, expose a public tunnel hostname or forward arbitrary paths. **Add Pi routes only via the gateway route table.**
6. **The frontend has no calibration constants or feed rates.** Weights arrive in grams; kg is only for display.
7. **Never fabricate AI readings or show simulated data as live.**
8. **Request budget:** no fast polling (Workers free plan).
9. **Verify before claiming done:**
   - Frontend: `npm run build` and `npm run lint`. TypeScript has about 13 pre-existing errors; don't add new ones.
   - Gateway: `npm run test:gateway` after any change to `pi-gateway.ts`.
   - Python: `npm run test:stage-schedule` and `npm run test:auto-feeding`.
10. **After code changes**, run `graphify update .`. The knowledge graph is in `graphify-out/`, and `graphify query "<question>"` should come before broad greps.
11. **After significant changes**, update the Obsidian vault (`00-Index/CURRENT_STATUS.md`, feature notes, `05-Decisions/ARCHITECTURE_DECISIONS.md` (AD-xx), `07-Development/CHANGELOG.md`, `TEST_RESULTS.md`, `TODO.md`, `06-Troubleshooting/KNOWN_ISSUES.md`). Edit it with Python scripts that assert exact matches, dry-run on a copy first.

---

## 5. Commands and deploy procedures

| Task | Command |
|---|---|
| Dev server | `npm run dev` |
| Build / lint | `npm run build`, `npm run lint` |
| Deploy main app | `npm run build && npx wrangler deploy` |
| Deploy maintenance site | `npm run deploy:maintenance` |
| Roll back a Worker | `npx wrangler versions list [-c maintenance-site/wrangler.jsonc]` → `npx wrangler rollback <id>` |
| Set a Worker secret | `npx wrangler secret put POULTRIX_ALLOWED_EMAILS` (or `POULTRIX_OWNER_EMAILS`) |

**Pi deploy:**
1. Strip CRs (`tr -d '\r'`) and scp `app.py`, `stage_schedule.py` and `feeding_schedule.py` to `/tmp`.
2. Run `py_compile` in the venv.
3. Back up each file as `*_backup_before_<change>`.
4. Copy the files into `/home/raspberry/poultrix-api`.
5. Run `sudo -n systemctl restart poultrix`.
6. Smoke-test on the Pi: `curl http://127.0.0.1:5000/api/snapshot`.

**Firmware flash (from the Pi):**
1. Compile on the PC: `arduino-cli compile --fqbn arduino:avr:mega`.
2. Copy the hex to the Pi and keep the previous hex for rollback.
3. `sudo systemctl stop poultrix`.
4. `timeout 120 avrdude -p m2560 -c wiring -P /dev/ttyACMx -b 115200 -D -U flash:w:<new>.hex:i` (write only). USB interference has hung avrdude before; if it hangs, kill avrdude carefully (`pkill -f` can match your own SSH command) and retry.
5. `sudo systemctl start poultrix`.

**Environment:**
- `.env.local` (gitignored) must hold `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY`; without them, login breaks.
- On the server side: `SUPABASE_URL` is a wrangler var and `SUPABASE_PUBLISHABLE_KEY` is a Worker secret.

---

## 6. Repository map

```
arduino/firmware/poultrix_arduino.ino   Arduino Mega firmware
raspberry-pi/app.py                     Flask API + threads (Pi only)
raspberry-pi/stage_schedule.py          stage day gates / daily window logic
raspberry-pi/feeding_schedule.py        gate model, session plan, trough validity
src/routes/                             app pages (index, feeding, flock, settings, login, ...)
src/components/poultrix/                AppShell, StageSchedule, FeedingPlanner, AutoFeedingCard, SystemPowerCard
src/lib/pi-client.ts, pi-snapshot.ts    Pi access + shared 5 s poller
src/lib/live-hardware.ts, live-alerts.ts, live-endpoints.ts, feeding-reasons.ts
src/lib/server/pi-gateway.ts            Worker → Pi gateway (route tables, auth)
src/server.ts                           Worker entry (/api/pi/*, /api/history)
maintenance-site/                       maintenance Worker + console
tests/                                  pi-gateway (Node), stage-schedule & auto-feeding (Python unittest)
SPEC-*.md, CAPABILITY_MAP.md, tasks/    specs, module map, plans/todos
CLAUDE.md, AGENTS.md                    detailed assistant guidance
documents/POULTRIX_Philippine_Standards.txt   climate targets reference
```

Work happens on branch **`feat/always-live-firmware`**; `main` is the PR target, and that branch is not merged yet.

---

## 7. Current status (2026-11-09)

- **Live components:**
  - **Climate:** always-live firmware `2288e72b`.
  - **Remote access:** works over mobile data.
  - **Maintenance site:** working.
  - **Stage schedule:** working; the next check is the Finisher check on 2026-11-15 at 10:00.
  - **Automatic feeding:** commissioned and switched on. The first scheduled feed ran at 18:00 on 2026-11-08 and dispensed 157.5 g from compartment 2.
  - **System power:** restart and stay-off power-off.
  - **Login:** new design, with Google sign-in working.
- **Every capability-map module is done** except remote-access **R-C** (a 24 h request count).

### Open items and known issues
- **Hopper:** it misses about 10% of HX711 reads. Check the wiring; the Pi holds the last good value for 6 s.
- **Feed amount:** the 18:00 feed showed only about 92 g of hopper drop against the 157.5 g target. Compare the next sessions and refit the short-gate part of the model if it repeats.
- **Compartment 1 gate:** not measured. Fill it with Integra 2, do 2–3 manual dispenses, fit the model, then set `FEED_GATE_MEASURED[1] = True`.
- **Trough:** the zero drifts.
- **LDR:** shield it from the LED.
- **USB interference:** add a ferrite to the Pi–Arduino USB cable.
- **Timed power-off:** retest it (`POWER_OFF_ON_HALT=1`).
- **Remaining checkpoint:** Checkpoint S-B.
- **Optional:**
  - a smaller login video (it is 9.1 MB now);
  - a PR merging the branch into `main`.

---

## 8. The owner

- **Who:** the farm owner and developer, and the only real user of the maintenance site. They sometimes test at the farm and report what they see physically.
- **Writing style:** short instructions, such as "deploy", "commit and push", "start A3". Act on them directly.
- **Questions:** ask only when a decision is genuinely theirs.
