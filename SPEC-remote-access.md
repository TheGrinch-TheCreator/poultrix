# Spec: remote-access

Status: **APPROVED 2026-11-07** by the owner (Q1 → b, Q2–Q4 → yes, Q5 → free plan). Module `remote-access` in `CAPABILITY_MAP.md`.

## Objective
Signed-in, approved users can use the whole Poultrix app from anywhere, including a phone on mobile data, at `https://poultrix.johnkarlduenas.workers.dev`. That covers live data, feeding, AI stage and bypass. The Pi's control API stops being reachable without a login.

Today:
- The browser calls the Pi directly at `http://192.168.1.48:5000`. That only works on the farm Wi-Fi, and is blocked from the HTTPS site (mixed content).
- The Flask API has no auth and `CORS(*)`, so anyone on the LAN, or any web page open on a LAN device, can feed, change stage, etc.
- Anyone can create an account on `/login`.

**Users:** the owner plus a few helpers (more than one). Every approved signed-in user may control hardware (owner decision 2026-11-06).

### User stories
1. On mobile data, I open the site, sign in, and see live temperature, stage, weights and alerts within 10 s.
2. On mobile data, I start a manual feed or stop a feed job, and the result shows in the UI.
3. Someone who isn't on the approved list can't see data or control anything, even if they create an account.
4. A device on the farm Wi-Fi without a login can't control hardware.

## Facts this design builds on (verified 2026-11-07)
- `cloudflared.service` runs on the Pi (dashboard token tunnel, v2026.10.5). The main Worker already reaches the Pi through the **VPC service binding `POULTRIX_HISTORY`** (`http://127.0.0.1:5000/...`), used by `/api/history` with a Supabase bearer check.
- No custom domain (`*.workers.dev` only), so there's no public tunnel hostname. Keep it that way.
- The frontend calls ~25 Pi paths. They're listed in "Allowlist" below. Most go through `src/lib/live-*.ts`. `FeedingPlanner.tsx`, `feeding.tsx`, `bypass.tsx`, `profile.tsx`, `ai-stage.tsx` and others still build URLs from `API_URL` themselves.
- The telemetry Worker (`telemetry-worker.johnkarlduenas.workers.dev`) serves `/api/status` **publicly, with no auth** (HTTP 200). The uploader on the Pi delivers every 3 s.
- `/login` has a "Create account" mode (`supabase.auth.signUp`).
- Cloudflare Workers free plan: 100,000 requests/day.
- Supabase signs access tokens with **ES256** (JWKS at `/auth/v1/.well-known/jwks.json`), so the Worker can verify tokens locally.
- The VPC service `poultrix-history-api` targets **`127.0.0.1:5000`** through tunnel `72d7b6b7…`, so binding Flask to localhost keeps the tunnel working.

## Design
```
Phone / PC browser ──HTTPS──▶ poultrix Worker  ── /api/pi/<allowlisted path>
                               │ 1. verify Supabase JWT + approved user
                               │ 2. match (method, path) against the allowlist
                               │ 3. validate query/body size
                               ▼
                      VPC binding POULTRIX_HISTORY ──tunnel──▶ Pi Flask 127.0.0.1:5000
```
1. **One Worker route, `src/routes/api/pi/$.ts`, with an explicit allowlist table** (method + exact path or a fixed pattern such as `/api/feeding/inventory/(refill|initialize)`). Anything not in the table → 404. This is *not* a generic proxy: paths, methods, query keys and body size are fixed in code, and the upstream URL is built from the table, never from user input. (Interpretation of the CLAUDE.md rule; please confirm.)
2. **Auth on every route, reads included.** Each request verifies the Supabase access token locally against the project's ES256 JWKS (cached), and checks `exp`, `aud=authenticated` and `iss`. The user is approved only if their **email is confirmed** and in the **`POULTRIX_ALLOWED_EMAILS`** Worker secret (comma-separated, case-insensitive). The confirmed-email check stops someone from signing up first with a helper's address. It forwards no user identity to Flask except an `X-Poultrix-User` header for logging.
3. **The frontend uses same-origin `/api/pi/...` everywhere**, through `src/lib/live-*.ts` adapters that attach the Supabase token. `API_URL` / `VITE_POULTRIX_API_URL` is removed from pages. This fixes the AGENTS.md adapter violations as a side effect.
4. **Polling budget.** Replace the separate 1 s / 3 s polls with one `/api/pi/snapshot` (status + AI status + weights + health in one Pi call). Poll every **5 s while the tab is visible**, pause when hidden. Budget: about 17k requests/day per tab open all day, so 4–5 always-open tabs fit the free plan.
5. **Lock the Pi down** after the remote path works: Flask binds `127.0.0.1` only (cloudflared and the uploader both connect locally), and `CORS(app)` is removed. Then nothing on the LAN can reach Flask directly (see Q2).
6. **Bypass through the Worker:** `/api/pi/bypass/*` requires a Supabase login **and** the existing maintenance token (`X-Poultrix-Maintenance` forwarded). Bypass login is rate-limited **on the Pi** (5 tries / 10 min per `X-Poultrix-User`; a single Flask process, so in-memory is reliable, unlike stateless Worker isolates). The separate maintenance site later reuses these routes (`maintenance-site` module).
7. **Pi clean-up (from the deleted hardening spec):** remove `/api/test/stage`, `/api/test/temperature`, `/api/test/lux`, and other test routes that the firmware rejects or that skip safety checks.

### Allowlist (initial)
| Method | Path | Notes |
|---|---|---|
| GET | `/api/pi/snapshot` | new Pi route: status + ai + weight + health |
| GET | `/api/status`, `/api/ai/status`, `/api/feeding/weight`, `/api/feeding/status`, `/api/system/health`, `/api/feeding/config`, `/api/feeding/inventory`, `/api/feeding/job`, `/api/feeding/manual/preview`, `/api/sensors/check/status`, `/api/environment/standards` | read |
| POST | `/api/feeding/manual/start`, `/api/feeding/job/stop`, `/api/feeding/stop`, `/api/feeding/config`, `/api/feeding/inventory/refill`, `/api/feeding/inventory/initialize`, `/api/ai/classify`, `/api/sensors/check` | control; JSON body ≤ 4 KB |
| GET/POST | `/api/bypass/{login,status,action,analyse-real,return-live,resume,exit,schedule-test,schedule-test/cancel}` | + maintenance token; login rate-limited |
| GET | `/api/camera/stream` | streamed passthrough. `<img>` can't send headers, so this route alone also accepts `?access_token=` (short-lived JWT; the URL isn't logged by the app) |

`/api/feeding/dispense` (single raw pulse) and `/api/history` (existing route) are left as they are. `/api/mode/*`, `/api/test/*` and `/api/recovery/status` are excluded.

## Tech stack
Existing: TanStack Start server routes on Cloudflare Workers (`cloudflare:workers` env), Supabase Auth (`sb_publishable_` key), cloudflared VPC service binding, Flask on the Pi. **No new runtime dependencies** planned. JWT verification uses WebCrypto + the JWKS endpoint. If a library is needed (`jose`), that's an ask-first.

## Commands
```
Build:   npm run build            (needs .env.local: VITE_SUPABASE_URL, VITE_SUPABASE_PUBLISHABLE_KEY)
Lint:    npm run lint
Types:   npx tsc --noEmit         (no new errors vs. baseline)
Deploy:  npx wrangler deploy      (rollback: npx wrangler rollback <version-id>)
Pi:      sudo systemctl restart poultrix ; journalctl -u poultrix -f
Pi syntax: venv/bin/python -m py_compile app.py
```

## Project structure
```
src/routes/api/pi/$.ts      → Worker allowlist route (new)
src/lib/pi-client.ts        → fetch helper: same-origin + Supabase token (new)
src/lib/live-*.ts           → adapters switch to pi-client
src/routes/*.tsx, src/components/poultrix/*.tsx → stop using API_URL directly
raspberry-pi/app.py         → /api/pi/snapshot, bind 127.0.0.1, drop CORS + test routes
SPEC-remote-access.md, tasks/plan.md, tasks/todo.md
```

## Code style
Follow `src/routes/api/history.ts`: typed bindings from `cloudflare:workers`, `json()` helper with `no-store` and `nosniff`, `AbortSignal.timeout`, fixed upstream URLs, generic error messages (no upstream details to the client).
```ts
const ROUTES: readonly PiRoute[] = [
  { method: 'GET',  path: '/api/status' },
  { method: 'POST', path: '/api/feeding/manual/start', maxBody: 4096 },
]
```

## Testing strategy
There's no test suite. Verify with:
- **Static:** `tsc` (no new errors), lint (no new non-format issues), `npm run build`, Python `py_compile`.
- **Worker:** curl against the deployed Worker:
  - no token → 401;
  - token of an unapproved user → 403;
  - unlisted path / wrong method → 404 / 405;
  - oversize body → 413;
  - approved token → 200 with live data.
- **Pi:** after the lock-down, `curl http://192.168.1.48:5000/api/status` from the PC fails (connection refused), while `curl 127.0.0.1:5000` on the Pi still works and telemetry still delivers.
- **Phone on mobile data** (owner): sign in, see live data, run a supervised short manual feed, run bypass Resume.
- **Request budget:** Cloudflare dashboard requests/day after 24 h with normal use.

## Boundaries
- **Always:**
  - auth on every `/api/pi/*` request;
  - allowlist matching on method + exact path;
  - fixed upstream URLs;
  - keep hardware calls inside `src/lib/`;
  - back up `app.py` before deploying;
  - deploy the Worker + frontend first, and lock Flask to localhost only after the remote path is verified.
- **Ask first:**
  - adding npm dependencies;
  - Supabase dashboard changes (disable signups, invite users);
  - changing cloudflared/tunnel config;
  - a paid Workers plan;
  - retiring the telemetry Worker.
- **Never:**
  - a public tunnel hostname or port-forward to Flask;
  - forwarding arbitrary paths/methods;
  - `CORS(*)` on anything reachable from outside;
  - committing secrets (`.env.local`, bypass secret, ingest token);
  - putting the bypass secret or Supabase service key in the client bundle.

## Success criteria
1. On mobile data, a signed-in approved user sees live status (temperature, stage, weights, alerts) within 10 s of opening the dashboard.
2. Manual feed start/stop, feeding config, inventory refill, AI classify and bypass (login, action, Resume, exit) all work from mobile data.
3. Every `/api/pi/*` request without a valid session → 401; valid session but not approved → 403; not allowlisted → 404.
4. After the lock-down, the Pi's port 5000 isn't reachable from the LAN; the app still works on the farm Wi-Fi (through the Worker), and telemetry still delivers.
5. No page or component outside `src/lib/` references `API_URL` or a Pi IP; the client bundle has no `192.168.` address.
6. A typical day (1–3 users) stays under 100k Worker requests.
7. `/api/test/*` routes are gone from `app.py`.
8. Bypass login: the 6th wrong password within 10 min → 429.

## Out of scope
- The separate maintenance site and its camera page (`maintenance-site`).
- Push notifications.
- Offline mode when the farm internet is down (the Arduino keeps running; the app shows "Pi offline").
- Forward-only AI (`stage-schedule`).

## Decisions (2026-11-07)
- **Q1 → (b):** keep public sign-up; an approved-email allowlist (`POULTRIX_ALLOWED_EMAILS` secret) plus confirmed email gates every `/api/pi/*` request. A signed-up user who isn't approved sees "Account not approved".
- **Q2 → yes:** Flask binds `127.0.0.1`; the app needs the internet even at the farm.
- **Q3 → yes:** camera stream through the Worker, only while the AI-stage page is open.
- **Q4 → yes:** stop the telemetry uploader and delete the telemetry Worker once `/api/pi/snapshot` works.
- **Q5 → free plan:** 5 s snapshot poll, paused while hidden.

## Open questions (original, resolved above)
- **Q1. Who counts as "approved"?** Anyone can sign up today. Options:
  - **(a) Recommended:** disable public signups in Supabase and invite each user by email; remove "Create account" from `/login`.
  - (b) Keep signups, plus an email allowlist (`POULTRIX_ALLOWED_EMAILS` secret) checked in the Worker.
  - (c) Both.
- **Q2. LAN access after the lock-down.** Binding Flask to `127.0.0.1` means the app needs the internet even at the farm: if the internet is down, there's no app (the Arduino still controls). **Recommended:** accept that. Alternative: keep LAN access but require a token on Flask too, which is more work and a second auth path.
- **Q3. Camera stream through the Worker** (`/api/camera/stream`, MJPEG). It costs one long request per viewer and tunnel bandwidth. **Recommended:** include a passthrough here, only while the AI-stage page is open. The WebRTC preview (`127.0.0.1:8088`) stays LAN/Pi-only and is hidden off-LAN.
- **Q4. Telemetry Worker.** It exposes status publicly. **Recommended:** stop the uploader and delete that Worker once `/api/pi/snapshot` works, so there's one path. Alternative: keep it as a backup and add auth.
- **Q5.** Is staying on the **free Workers plan** a requirement? It's what sets the 5 s poll.
