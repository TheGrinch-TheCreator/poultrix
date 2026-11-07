# Tasks: remote-access

Spec: `SPEC-remote-access.md` · Plan: `tasks/plan-remote-access.md`

## R1: Pi backend additions (backward compatible)
**Status (2026-11-07):** implemented. AST ✅, pyflakes no new warnings, off-Pi smoke test 13/13 ✅ (T5/T6 regression still passes). **Deployed to the Pi 2026-11-07 20:31** (sha `45919fab`, backup `app_backup_before_r1_20261107_203123.py`): snapshot OK (3.7 KB, no part errors), `/api/test/stage` → 404, rate limit 403×5 → 429. LAN callers can't spoof `X-Poultrix-User` (trusted only from localhost = tunnel).

**Description:** In `raspberry-pi/app.py`:
- Add `GET /api/snapshot` → `{status, ai, weight, health, feedingStatus}`, built from the same functions as the existing routes.
- Rate-limit `POST /api/bypass/login`: 5 failures per 10 min per `X-Poultrix-User` header (falling back to `request.remote_addr`) → 429.
- Log `X-Poultrix-User` on state-changing routes (feeding, inventory, config, classify, bypass).
- Remove `/api/test/*` routes.

**Acceptance:**
- [x] `/api/snapshot` returns all five parts; existing routes unchanged (off-Pi + on Pi)
- [x] 6th failed bypass login within 10 min → 429 (off-Pi + on Pi)
- [x] `grep -n "/api/test/" raspberry-pi/app.py` → nothing (off-Pi + on Pi)

**Verify:** `py_compile`; off-Pi smoke test (stubbed); deploy to the Pi with a backup; curl on the Pi.
**Files:** `raspberry-pi/app.py` · **Scope:** M

## R2: Worker allowlist route with auth
**Status (2026-11-07):** implemented as `src/lib/server/pi-gateway.ts`, dispatched from `src/server.ts` (like `/api/history`; keeps the camera stream out of the SSR handler) instead of a `routes/api/pi/$.ts` file. tsc no new errors, build ✅, local Node test 28/28 ✅ (real ES256 tokens; mocked Supabase + Pi). Pi JSON errors pass through unchanged so the UI keeps its messages.
**Deployed 2026-11-07** (Worker version `b0bf0e2f`, from `d0a5e05d`; previous `40d9deb0`). Secret `POULTRIX_ALLOWED_EMAILS` = owner's address. Live: no token → 401, fake token → 401 (JWKS reachable), unlisted/removed paths → 404, wrong method → 405, site + `/api/history` unaffected. **Still needed: an approved real session → 200 snapshot via the tunnel, and a non-approved account → 403.**

**Description:**
- `src/lib/server/pi-auth.ts`: ES256 JWKS verification (cached), claims check, confirmed email, `POULTRIX_ALLOWED_EMAILS` match.
- `src/routes/api/pi/$.ts`: an allowlist table (spec "Allowlist") mapping `/api/pi/<x>` → `http://127.0.0.1:5000/api/<x>` via `POULTRIX_HISTORY`. It handles method checks, a 4 KB body limit, forwards `X-Poultrix-Maintenance` only for bypass routes, sets `X-Poultrix-User`, streams the camera, takes `?access_token=` for the camera only, and uses timeouts (5 s reads, 15 s control).
- Set the `POULTRIX_ALLOWED_EMAILS` secret (**owner provides the emails**).

**Acceptance:**
- [x] no token → 401; unapproved or unconfirmed → 403; unlisted → 404; wrong method → 405; >4 KB → 413 (local 28/28; live 401/404/405)
- [x] approved token → `/api/pi/snapshot` 200 with live data (owner's browser 2026-11-07 20:44:47 and 20:45:15; Pi log shows `GET /api/snapshot` 200 via the tunnel)
- [x] no request path or query value can change the upstream host or path (local 28/28; live 401/404/405)

**Verify:** tsc (no new errors), lint, build, deploy, curl matrix with a real token.
**Files:** `src/lib/server/pi-auth.ts`, `src/routes/api/pi/$.ts`, `wrangler.jsonc` (if needed) · **Scope:** M
**Depends on:** R1 (snapshot)

### Checkpoint R-A
- [x] Curl matrix passes against the deployed Worker; the current site still works on the LAN (2026-11-07; live 403 for a non-approved account not yet tried, covered by the local test)

## R3: Browser Pi client + shared snapshot store
**Status (2026-11-07):** **deployed** (Worker `a8c6e9f3`). `src/lib/pi-client.ts` (`piFetch`/`piJson`, 401 → refresh + retry, `PiError` codes), `src/lib/pi-snapshot.ts` (shared 5 s poller, paused when hidden). `useHardware`/`useAI`/`useLiveAlerts` read from it. Alert acknowledgements sync every 60 s instead of every 3 s. The header pill shows Not approved / Signed out, with a banner for unapproved accounts. tsc one error fewer; build ✅. Note: AI-cycle progress now refreshes every 5 s (was 1 s).

**Description:**
- `src/lib/pi-client.ts`: `piFetch(path, init)` → same-origin `/api/pi/...` with the Supabase bearer; one refresh-and-retry on 401; typed errors for 401/403/429/5xx.
- A shared snapshot store polls every 5 s while visible.
- `useHardware`, `useAI`, `live-weights`, `live-alerts` read from the store.

**Acceptance:**
- [ ] One `/api/pi/snapshot` request per 5 s per tab (DevTools); none while hidden
- [ ] Header pill, dashboard, alerts work from the snapshot
- [ ] 403 → "Account not approved" banner

**Files:** `src/lib/pi-client.ts`, `src/lib/live-hardware.ts`, `src/lib/live-weights.ts`, `src/lib/live-alerts.ts` · **Scope:** M · **Depends on:** R-A

## R4: Pages and components use the adapters
**Status (2026-11-07):** deployed (`14410c5b`). New `src/lib/live-endpoints.ts`:
- `usePiEndpoint`: snapshot parts, otherwise a slow poll.
- `usePiResource`: visible-only poll.
- `useCameraStreamUrl`: tokenized MJPEG URL, cleared while hidden, renewed every 45 min.

Changes:
- `authorizedFetch` was added to `pi-client.ts` for `/api/history`.
- Moved to the gateway: FeedingPlanner (7 calls), feeding (3), alerts (1), flock (1), environment history (via the Worker `/api/history`), AI-stage camera, profile sign-out bypass exit.
- The dashboard and hardware pages read weights, feeding status and health from the snapshot (they were 3 requests every 3 s each).

New poll rates:
| What | Before | Now |
|---|---|---|
| Feeding plan | 3–5 s | 30–60 s |
| Inventory | 2–5 s | 10–30 s |
| Feed job (manual panel only) | 1.5 s | 3 s |

Checks: tsc 2 errors fewer; lint unchanged; build ✅. The WebRTC preview (`127.0.0.1:8088`) is left as is: it only works in a browser on the Pi.

**Description:** Move direct `API_URL` fetches into `src/lib/` functions using `piFetch`: `FeedingPlanner.tsx`, `feeding.tsx`, `ai-stage.tsx` (classify + camera `<img>` with the token, stopped when hidden/unmounted), `flock.tsx`, `profile.tsx`, `alerts.tsx`, `environment.tsx`, `hardware.tsx`, `index.tsx`. Hide the WebRTC preview unless on the Pi itself.

**Acceptance:**
- [x] `grep -rn "API_URL\|192\.168" src --include=*.tsx` → nothing outside `src/lib/` (except `bypass.tsx`, R5)
- [ ] Feeding plan load/save, manual preview/start, job stop, inventory refill/init, AI classify all work through `/api/pi`

**Files:** the pages above + `src/lib/live-feeding.ts` (new) · **Scope:** M (may split into R4a feeding / R4b the rest) · **Depends on:** R3

## R5: Bypass page through the Worker
**Status (2026-11-07):** implemented and deployed with R6.

**Description:** `bypass.tsx` calls `/api/pi/bypass/*` via `piFetch`, with the maintenance token header. Show 429 as "Too many attempts, wait 10 minutes".

**Acceptance:**
- [ ] Login, action, Return to automatic, Resume, exit all work through the Worker
- [ ] The 6th wrong password → message shown

**Files:** `src/routes/bypass.tsx`, `src/lib/pi-client.ts` · **Scope:** S · **Depends on:** R3

## R6: Remove the direct Pi URL; deploy
**Status (2026-11-07):** `API_URL` removed from `live-hardware.ts`; `VITE_POULTRIX_API_URL` removed from `.env.local`. Clean build: no `192.168` in `dist/`. tsc 18 → 15 errors (none new).
**Deployed 2026-11-07** with R4 and R5: Worker `14410c5b` (rollback: `npx wrangler rollback a8c6e9f3-8a72-45db-b6da-9fa20611a785`). Live bundle: no `192.168`, Supabase config present; pages 200; gateway without a token → 401.

**Description:** Remove `API_URL` / `VITE_POULTRIX_API_URL` from `live-hardware.ts` and `.env.local`. Build, check the bundle has no `192.168.`, deploy.

**Acceptance:**
- [x] `grep -r "192.168" dist/client` → nothing
- [x] Deployed; the old version id is recorded for rollback

**Files:** `src/lib/live-hardware.ts`, `.env.local` (local only) · **Scope:** S · **Depends on:** R4, R5

### Checkpoint R-B (owner, phone on mobile data)
- [x] Dashboard live within 10 s (owner, mobile data, 2026-11-07)
- [x] Supervised short manual feed works (owner, mobile data, 2026-11-07)
- [x] Bypass login + Resume work (owner, mobile data, 2026-11-07)
- [x] Camera visible on the AI page (owner, mobile data, 2026-11-07)
- [ ] A non-allowlisted account sees "Account not approved" (not reported; covered by the local gateway test)

## R7: Lock the Pi down
**Status (2026-11-07):** implemented. `host="127.0.0.1"`, `CORS(app)` + `flask_cors` import removed, `flask-cors` dropped from `requirements-rpi.txt`. Before the change, the Pi journal showed no non-local clients of :5000 in 30 min (only the tunnel and the uploader, both on 127.0.0.1). Off-Pi smoke tests still pass; no CORS header returned.
**Deployed to the Pi 2026-11-07 21:32** (sha `6a5368d9`, backup `app_backup_before_r7_20261107_213230.py`): listening `127.0.0.1:5000` only; PC → `192.168.1.48:5000` refused; localhost 200; LIVE; no tracebacks. Tunnel traffic continued right after the restart (snapshot, camera stream, feeding config, alert acks from the owner's open tab); the uploader delivered 10× (1 transient error during the restart).

**Description:** `app.run(host="127.0.0.1")`; remove `CORS(app)` and the `flask_cors` import. Back up first. Restart.

**Acceptance:**
- [x] From the PC: `curl http://192.168.1.48:5000/api/status` → connection refused (2026-11-07)
- [x] The app still works on the farm Wi-Fi and on mobile data (through the Worker) (live tunnel traffic after the restart)
- [ ] `/api/history` still works (not separately checked; same VPC binding)

**Files:** `raspberry-pi/app.py` · **Scope:** S · **Depends on:** R-B

## R8: Retire the telemetry mirror
**Status (2026-11-07): done.** `poultrix-telemetry.service` stopped and disabled (poultrix + cloudflared unaffected). Worker `telemetry-worker` deleted (the repo config named it `poultrix-telemetry`, which never existed); its `/api/status` now returns 404. The code is kept and marked retired (`telemetry-worker/RETIRED.md`, uploader header).

**Description:** `sudo systemctl disable --now poultrix-telemetry`; delete the `telemetry-worker` Worker (`npx wrangler delete --name telemetry-worker`). Keep `telemetry-worker/` and the uploader in git, marked retired in their READMEs, or remove them (owner's choice at that point).

**Acceptance:**
- [x] `https://telemetry-worker.johnkarlduenas.workers.dev/api/status` no longer serves data
- [x] The service is inactive on the Pi

**Scope:** S · **Depends on:** R7

## R9: Docs
**Description:** CLAUDE.md (architecture: browser → Worker → tunnel; no direct Pi calls; the env var removed; the allowlist rule), Obsidian (`SYSTEM_ARCHITECTURE`, `API_REFERENCE`, `FRONTEND`, `BACKEND`, `DEPLOYMENT`, `KNOWN_ISSUES` (CORS/unauth/mixed content resolved), `ARCHITECTURE_DECISIONS` (new AD for the Worker gateway + allowlist auth; AD-12 retired), `CURRENT_STATUS`, `CHANGELOG`, `TEST_RESULTS`). `graphify update .`

**Scope:** M (docs) · **Depends on:** R8

### Checkpoint R-C: Complete
- [ ] All 8 spec success criteria verified
- [ ] 24 h Worker requests under 100k
- [ ] `CAPABILITY_MAP.md`: `remote-access` marked done
