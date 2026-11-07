# Spec: maintenance-site

Status: **APPROVED 2026-11-07** (owner answered Q1–Q5, P1 → d, P2 → `maintenance.poultrix.workers.dev`). Module `maintenance-site` in `CAPABILITY_MAP.md` (depends on `always-live` ✅, `remote-access` ✅ except R-C).

## Objective
A **separate website, only for maintenance (bypass)**, so manual hardware control is no longer part of the everyday app. It should:
- be reached at its own address, **`https://maintenance.poultrix.workers.dev`** (main app: `https://app.poultrix.workers.dev`);
- need only the bypass password (owner decision Q1-b, no app login);
- show a **live camera view** next to the controls, so the maintainer can watch gates, lamps and fans move;
- work from mobile data like the main app.

The everyday app loses all bypass access: the hidden Settings link, the `/bypass` page and the bypass routes in its Pi gateway.

The original owner request also covered the "goes to SAFE and doesn't return after bypass" bug. That's already fixed by `always-live` (verified on the Pi 2026-11-07), so it's out of scope here.

### User stories
1. As the maintainer, I open the maintenance site on my phone, enter the bypass password, and see the camera plus the relay, servo, sensor-test and stage-test controls.
2. While I switch a fan relay or open a gate group, I see it happen on the camera.
3. Ending maintenance (Return to automatic / Exit / 10 s timeout) puts the house back under automatic control, as today.
4. Farm helpers using the main app never see a bypass entry point, and can't call bypass routes through the main app.

## Facts (verified 2026-11-07)
- `src/routes/bypass.tsx` (107 lines) has these sections: unlock, servo groups 1–2, relays 1–6, sensor test readings, stage test target, Return to automatic, Resume, Exit. It already calls `/api/pi/bypass/*` via `piFetch` with the maintenance token.
- The only entry point is a near-invisible link in `src/routes/settings.tsx:121` (`href="/bypass"`). `profile.tsx` sign-out calls `/bypass/exit`.
- The Pi side is done:
  - `/api/bypass/*` with an 8 h token;
  - login limited to 5 failures / 10 min per user;
  - serial-loss pause and Resume;
  - Arduino 10 s maintenance timeout → automatic.
- The camera is `GET /api/camera/stream` (MJPEG), reachable through the gateway with `?access_token=`.
- The current bypass secret on the Pi is **4 characters**, and the service file defines `POULTRIX_BYPASS_SECRET` twice.
- Only the main Worker (now `app`) has the VPC binding `POULTRIX_HISTORY` to the Pi. A second Worker can bind the same VPC service.

## Design
```
maintenance browser ──HTTPS──▶ Worker `maintenance` (new) at maintenance.poultrix.workers.dev
                                 ├─ static SPA (maintenance UI)
                                 └─ /api/pi/* → same gateway code, MAINTENANCE route table only:
                                      bypass/*, camera/stream, snapshot
                                      auth = Pi maintenance token (no Supabase)
                                 │ VPC binding (same service, 127.0.0.1:5000 via tunnel)
                                 ▼
                               Pi Flask (unchanged)
main browser ──▶ Worker `app` ── /api/pi/* → APP route table (bypass/* removed), Supabase auth
```
1. **Shared gateway, two route tables, two auth modes.** Refactor `src/lib/server/pi-gateway.ts` into `createPiGateway({ routes, auth })`.
   - **Main Worker:** `APP_ROUTES` (today's table minus `bypass/*`) with `auth: "supabase"` (unchanged: ES256 JWT, confirmed email, allowlist).
   - **Maintenance Worker:** `MAINTENANCE_ROUTES` (`bypass/*`, `camera/stream`, `snapshot`) with `auth: "maintenance"`:
     - `bypass/login` is open (the Pi checks the password and rate-limits it);
     - other `bypass/*` routes forward `X-Poultrix-Maintenance` (the Pi checks it);
     - `camera/stream` (token in `?maintenance_token=`, since `<img>` can't send headers) and `snapshot` are served **only after the Worker validates the token** with the Pi's `GET /api/bypass/status` (cached 30 s per token);
     - every upstream request carries `X-Poultrix-User: ip:<CF-Connecting-IP>`, so the Pi's login limit and `[AUDIT]` log work per client IP.
2. **New folder `maintenance-site/`:** its own `wrangler.jsonc` (name `maintenance`, same VPC service id, assets) and a small `worker.ts` that serves the SPA and the gateway. The UI is a Vite + React app (`maintenance-site/index.html`, `src/main.tsx`) that imports the existing code via the `@/` alias (`components/poultrix/ui`, styles, and a maintenance variant of the Pi client that sends the maintenance token instead of a Supabase bearer). It looks like the main app. No Supabase client on this site.
3. **Pages:**
   - **Unlock:** bypass password (the token is kept in `localStorage` for its 8 h life, as today).
   - **Maintenance console:** the camera on top (auto-start, the same `useCameraStreamUrl`), status strip (temperature, stage, fans/heater/LED, Pi/Arduino link from the snapshot), then today's sections moved from `bypass.tsx` unchanged in behavior. A "Return to automatic control" / Exit bar stays visible.
4. **Main app clean-up:**
   - Delete `src/routes/bypass.tsx`.
   - Remove the Settings link.
   - Remove the `/bypass/exit` call from sign-out (the maintenance site's Exit button calls exit).
   - Drop `bypass/*` from `APP_ROUTES`.
5. **Bypass secret (Pi):** unchanged value (Q3). Optional hygiene: remove the unused first `POULTRIX_BYPASS_SECRET` line from the service file (the value in effect stays the same).

## Commands
```
Main app:        npm run build && npx wrangler deploy
Maintenance:     npm run build:maintenance && npx wrangler deploy -c maintenance-site/wrangler.jsonc   (no secrets needed)
Types / lint:    npx tsc --noEmit ; npm run lint
Pi:              sudo systemctl edit/restart poultrix ; journalctl -u poultrix -f
```

## Project structure
```
maintenance-site/wrangler.jsonc   → Worker maintenance (VPC binding, assets)
maintenance-site/worker.ts        → serves SPA + maintenance gateway
maintenance-site/index.html, vite.config.ts, src/main.tsx, src/App.tsx, src/Console.tsx
src/lib/server/pi-gateway.ts      → createPiGateway + APP_ROUTES / MAINTENANCE_ROUTES
src/routes/bypass.tsx             → deleted (its sections move to maintenance-site/src/Console.tsx)
src/routes/settings.tsx, profile.tsx → remove bypass entry / exit call
package.json                      → build:maintenance script
```

## Code style
Same as the main app: TanStack-free plain React for the small SPA, Tailwind classes from `src/styles.css`, `poultrix/ui` components, adapters in `src/lib`. Gateway changes keep the explicit-table rule.

## Testing strategy
- **Static:** tsc (no new errors), lint, both builds.
- **Gateway:** extend the Node test (real ES256 tokens) for both tables:
  - the main table returns 404 for `bypass/*`;
  - the maintenance table returns 404 for `feeding/*`, `ai/classify`, etc.;
  - main: the camera works with `?access_token=`;
  - maintenance: camera/snapshot → 401 without a valid maintenance token, 200 with one (Pi status mocked); login passes through; `X-Poultrix-User: ip:…` is set.
- **Live:**
  - the maintenance site: camera/snapshot without a token → 401, unlisted paths → 404;
  - the main site `POST /api/pi/bypass/login` → 404;
  - the bypass login rate limit still 429s through the new Worker.
- **Owner on a phone (mobile data):** unlock, camera visible, relay 1 on/off seen on camera, gate group 1 for 1 s seen on camera, Return to automatic, Exit. Main app: no bypass link anywhere; `/bypass` → 404.

## Boundaries
- **Always:**
  - gateway changes stay table-based;
  - the main Worker verifies the Supabase session; the maintenance Worker never serves camera/snapshot without a validated maintenance token;
  - back up the systemd unit and `app.py` before editing;
  - keep the Arduino timeout as the final safety net.
- **Ask first:**
  - editing the Pi systemd unit;
  - adding npm dependencies;
  - deleting `/bypass` from the main app before the maintenance site is verified.
- **Never:**
  - put the bypass secret in a repo file, a Worker var or the client bundle;
  - add sign-up to the maintenance site;
  - expose feeding/AI control routes on the maintenance Worker;
  - give the maintenance Worker a public tunnel hostname.

## Success criteria
1. `https://maintenance.poultrix.workers.dev` works from mobile data: unlock → console with a live camera.
2. Every bypass action from today's page works there (relays 1–6 with ACK, groups 1–2, stop, sensor test values, stage test, analyse real, Return to automatic, Resume, Exit).
3. The main app has no bypass link or page (`/bypass` → 404), and its gateway returns 404 for `bypass/*`.
4. The maintenance gateway serves only `bypass/*`, `camera/stream`, `snapshot` (anything else → 404).
5. Without a valid maintenance token: camera/snapshot → 401 from the Worker, bypass actions → 403 from the Pi. Wrong passwords: the 6th within 10 min from one IP → 429.
6. The camera stream stops when the console tab is hidden or the site is closed.

## Owner decisions (2026-11-07)
- **Q1 → (b) bypass password only.** No Supabase login on the maintenance site. Design change:
  - The maintenance gateway skips JWT/allowlist checks.
  - It forwards `X-Poultrix-User: ip:<CF-Connecting-IP>` so the Pi's existing login limit (5 failures / 10 min) works per client IP.
  - `camera/stream` and `snapshot` need a **valid maintenance token**: the Worker checks it against the Pi's `/api/bypass/status` (cached 30 s) before streaming. They're never open.
- **Q2 → same list as the main app.** Moot under Q1-b (no app login on this site, so there's no email to check).
- **Q3 → keep the current password** (4 characters). No 12-character minimum.
- **Q4 → yes**, the owner prefers a shorter address without the account name. `poultrix.workers.dev` isn't possible (workers.dev is always `<worker>.<account-subdomain>.workers.dev`). See pending P2.
- **Q5 → leave the schedule test out.**

## Resolved (2026-11-07)
- **P1 → (d) accept as is. Accepted risk:** a 4-character bypass password, only rate-limited per IP (5 / 10 min), protects manual control, including the heater relay (up to 8 h, no temperature cutoff), on a public URL. A distributed guesser could find it. Recorded as AD-21.
- **P2 → subdomain renamed to `poultrix`** (owner, dashboard). Main app moved to Worker `app` at `https://app.poultrix.workers.dev`; maintenance site at `https://maintenance.poultrix.workers.dev`.

### Original P1/P2 text
- **P1. Brute-force risk.** With Q1-b + Q3, a 4-character password on a public URL guards manual heater control (up to 8 h, no temperature cutoff). Options:
  - (a) a site-wide lockout after 10 failures/hour from any IP, for 1 h;
  - (b) a longer password;
  - (c) revert to Q1-a;
  - (d) accept as is.
- **P2. Address.** Options:
  - keep `poultrix-maintenance.johnkarlduenas.workers.dev`;
  - rename the account subdomain to `poultrix` (dashboard; changes the main app URL too, e.g. `app.poultrix.workers.dev` + `maintenance.poultrix.workers.dev`; update Supabase site URL);
  - a custom domain.

## Open questions (original)
- **Q1. Login on the maintenance site:**
  - **(a) Recommended:** app login (approved email) **and** the bypass password. Two factors, rate limit per user, same audit trail.
  - (b) Bypass password only. The gateway would then expose bypass routes to anyone who knows the password, rate-limited only per IP.
- **Q2. Who may use it:** **recommended:** a separate, shorter list, `POULTRIX_MAINTENANCE_EMAILS` (just you to start). Or the same list as the main app.
- **Q3. New bypass password:** OK to require ≥ 12 characters and replace the current 4-character one? You'd set it on the Pi yourself (I'll give the exact `systemctl edit` steps), so it never passes through this chat.
- **Q4. Address:** `poultrix-maintenance.johnkarlduenas.workers.dev`, or another name?
- **Q5. Extra controls:** the Pi has a "schedule test" (countdown, then one timed dispense) with no UI today. Add it to the console, or leave it out?
