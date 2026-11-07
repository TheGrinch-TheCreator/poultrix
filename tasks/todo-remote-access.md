# Tasks: remote-access

Spec: `SPEC-remote-access.md` · Plan: `tasks/plan-remote-access.md`

## R1: Pi backend additions (backward compatible)
**Status (2026-11-07):** implemented. AST ✅, pyflakes no new warnings, off-Pi smoke test 13/13 ✅ (T5/T6 regression still passes). LAN callers can't spoof `X-Poultrix-User` (trusted only from localhost = tunnel).

**Description:** In `raspberry-pi/app.py`:
- Add `GET /api/snapshot` → `{status, ai, weight, health, feedingStatus}`, built from the same functions as the existing routes.
- Rate-limit `POST /api/bypass/login`: 5 failures per 10 min per `X-Poultrix-User` header (falling back to `request.remote_addr`) → 429.
- Log `X-Poultrix-User` on state-changing routes (feeding, inventory, config, classify, bypass).
- Remove `/api/test/*` routes.

**Acceptance:**
- [x] `/api/snapshot` returns all five parts; existing routes unchanged (off-Pi)
- [x] 6th failed bypass login within 10 min → 429 (off-Pi)
- [x] `grep -n "/api/test/" raspberry-pi/app.py` → nothing (off-Pi)

**Verify:** `py_compile`; off-Pi smoke test (stubbed); deploy to the Pi with a backup; curl on the Pi.
**Files:** `raspberry-pi/app.py` · **Scope:** M

## R2: Worker allowlist route with auth
**Description:**
- `src/lib/server/pi-auth.ts`: ES256 JWKS verification (cached), claims check, confirmed email, `POULTRIX_ALLOWED_EMAILS` match.
- `src/routes/api/pi/$.ts`: an allowlist table (spec "Allowlist") mapping `/api/pi/<x>` → `http://127.0.0.1:5000/api/<x>` via `POULTRIX_HISTORY`. It handles method checks, a 4 KB body limit, forwards `X-Poultrix-Maintenance` only for bypass routes, sets `X-Poultrix-User`, streams the camera, takes `?access_token=` for the camera only, and uses timeouts (5 s reads, 15 s control).
- Set the `POULTRIX_ALLOWED_EMAILS` secret (**owner provides the emails**).

**Acceptance:**
- [ ] no token → 401; unapproved or unconfirmed → 403; unlisted → 404; wrong method → 405; >4 KB → 413
- [ ] approved token → `/api/pi/snapshot` 200 with live data
- [ ] no request path or query value can change the upstream host or path

**Verify:** tsc (no new errors), lint, build, deploy, curl matrix with a real token.
**Files:** `src/lib/server/pi-auth.ts`, `src/routes/api/pi/$.ts`, `wrangler.jsonc` (if needed) · **Scope:** M
**Depends on:** R1 (snapshot)

### Checkpoint R-A
- [ ] Curl matrix passes against the deployed Worker; the current site still works on the LAN

## R3: Browser Pi client + shared snapshot store
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
**Description:** Move direct `API_URL` fetches into `src/lib/` functions using `piFetch`: `FeedingPlanner.tsx`, `feeding.tsx`, `ai-stage.tsx` (classify + camera `<img>` with the token, stopped when hidden/unmounted), `flock.tsx`, `profile.tsx`, `alerts.tsx`, `environment.tsx`, `hardware.tsx`, `index.tsx`. Hide the WebRTC preview unless on the Pi itself.

**Acceptance:**
- [ ] `grep -rn "API_URL\|192\.168" src --include=*.tsx` → nothing outside `src/lib/`
- [ ] Feeding plan load/save, manual preview/start, job stop, inventory refill/init, AI classify all work through `/api/pi`

**Files:** the pages above + `src/lib/live-feeding.ts` (new) · **Scope:** M (may split into R4a feeding / R4b the rest) · **Depends on:** R3

## R5: Bypass page through the Worker
**Description:** `bypass.tsx` calls `/api/pi/bypass/*` via `piFetch`, with the maintenance token header. Show 429 as "Too many attempts, wait 10 minutes".

**Acceptance:**
- [ ] Login, action, Return to automatic, Resume, exit all work through the Worker
- [ ] The 6th wrong password → message shown

**Files:** `src/routes/bypass.tsx`, `src/lib/pi-client.ts` · **Scope:** S · **Depends on:** R3

## R6: Remove the direct Pi URL; deploy
**Description:** Remove `API_URL` / `VITE_POULTRIX_API_URL` from `live-hardware.ts` and `.env.local`. Build, check the bundle has no `192.168.`, deploy.

**Acceptance:**
- [ ] `grep -r "192.168" dist/client` → nothing
- [ ] Deployed; the old version id is recorded for rollback

**Files:** `src/lib/live-hardware.ts`, `.env.local` (local only) · **Scope:** S · **Depends on:** R4, R5

### Checkpoint R-B (owner, phone on mobile data)
- [ ] Dashboard live within 10 s
- [ ] Supervised short manual feed works
- [ ] Bypass login + Resume work
- [ ] Camera visible on the AI page
- [ ] A non-allowlisted account sees "Account not approved"

## R7: Lock the Pi down
**Description:** `app.run(host="127.0.0.1")`; remove `CORS(app)` and the `flask_cors` import. Back up first. Restart.

**Acceptance:**
- [ ] From the PC: `curl http://192.168.1.48:5000/api/status` → connection refused
- [ ] The app still works on the farm Wi-Fi and on mobile data (through the Worker)
- [ ] `/api/history` still works

**Files:** `raspberry-pi/app.py` · **Scope:** S · **Depends on:** R-B

## R8: Retire the telemetry mirror
**Description:** `sudo systemctl disable --now poultrix-telemetry`; delete the `telemetry-worker` Worker (`npx wrangler delete --name telemetry-worker`). Keep `telemetry-worker/` and the uploader in git, marked retired in their READMEs, or remove them (owner's choice at that point).

**Acceptance:**
- [ ] `https://telemetry-worker.johnkarlduenas.workers.dev/api/status` no longer serves data
- [ ] The service is inactive on the Pi

**Scope:** S · **Depends on:** R7

## R9: Docs
**Description:** CLAUDE.md (architecture: browser → Worker → tunnel; no direct Pi calls; the env var removed; the allowlist rule), Obsidian (`SYSTEM_ARCHITECTURE`, `API_REFERENCE`, `FRONTEND`, `BACKEND`, `DEPLOYMENT`, `KNOWN_ISSUES` (CORS/unauth/mixed content resolved), `ARCHITECTURE_DECISIONS` (new AD for the Worker gateway + allowlist auth; AD-12 retired), `CURRENT_STATUS`, `CHANGELOG`, `TEST_RESULTS`). `graphify update .`

**Scope:** M (docs) · **Depends on:** R8

### Checkpoint R-C: Complete
- [ ] All 8 spec success criteria verified
- [ ] 24 h Worker requests under 100k
- [ ] `CAPABILITY_MAP.md`: `remote-access` marked done
