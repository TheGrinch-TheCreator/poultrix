# Plan + tasks: maintenance-site

Spec: `SPEC-maintenance-site.md` (approved 2026-11-07).

## Approach
Build the new site **next to** the existing `/bypass` page. Remove bypass from the main app only after the maintenance site is verified on a phone, so there's always one working way into maintenance.

```
M1 gateway refactor (two tables, two auth modes) ── M2 maintenance Worker + SPA ── deploy ── Checkpoint M-A (phone)
                                                                                            └─ M3 main app clean-up ── deploy ── M4 docs
```

## M1: Gateway refactor
**Status (2026-11-07): done.** `createPiGateway({routes, auth})`, `APP_ROUTES` (unchanged, still includes bypass until M3), `MAINTENANCE_ROUTES` (11 routes), exports `handlePiGateway` (main, Supabase) and `handleMaintenanceGateway` (bypass token; camera/snapshot token validated via the Pi's `/api/bypass/status`, cached 30 s, keyed by SHA-256 of the token). Tests are now in the repo: `npm run test:gateway` → app 28/28, maintenance 20/20. tsc no new errors; main build ✅. Main app behavior unchanged (not redeployed).

**Description:** `src/lib/server/pi-gateway.ts` → `createPiGateway({ routes, auth: "supabase" | "maintenance" })`.
- Split the table into `APP_ROUTES` (today's minus `bypass/*`, **kept until M3** so the old page keeps working) and `MAINTENANCE_ROUTES` (`bypass/*`, `camera/stream`, `snapshot`).
- **Maintenance auth:**
  - `bypass/login` passes through;
  - other bypass routes forward `X-Poultrix-Maintenance`;
  - camera (`?maintenance_token=`) and snapshot need a token validated through the Pi's `GET /api/bypass/status` (200 = valid; cached 30 s per token);
  - `X-Poultrix-User: ip:<CF-Connecting-IP>`.
- The main Worker's behavior is unchanged in M1.

**Acceptance:**
- [x] The Node test (extended) passes for both modes: main 401/403/404/405/413/200 as before; maintenance camera/snapshot 401 without a token and 200 with a valid one, `feeding/*` 404, `ip:` user header set
- [x] tsc no new errors; main build OK

**Files:** `src/lib/server/pi-gateway.ts`, `src/server.ts` · **Scope:** M

## M2: Maintenance Worker and console
**Status (2026-11-07):** built, **not deployed**.
- `maintenance-site/`:
  - `wrangler.jsonc` (Worker `maintenance`, same VPC service, assets with SPA fallback, `run_worker_first`);
  - `worker.ts` (gateway + security headers; `/api/*` other than `/api/pi/*` → 404);
  - `vite.config.ts` (`@` → `../src`), `index.html` (noindex), `src/styles.css` (shared theme), `src/pi.ts` (token client, visible-only polls, camera URL), `src/Console.tsx`, `tsconfig.json`, `public/favicon.png`.
- `Console.tsx`: unlock form; camera (auto, retry 5 s, stops while hidden); a status strip from `snapshot` (5 s); the session bar; servo, relay, sensor-test and stage-test sections from `bypass.tsx`; bypass status polled every 3 s while visible (was 2 s always).
- Scripts: `npm run build:maintenance`, `npm run deploy:maintenance`.
- Checks:
  - tsc on the site: 0 errors; lint clean;
  - build ✅ (262 KB JS, no Supabase code);
  - `wrangler deploy --dry-run` shows the `POULTRIX_HISTORY` VPC binding and assets;
  - gateway tests and the main build still pass.

**Description:**
- `maintenance-site/`: `wrangler.jsonc` (name `maintenance`, VPC binding `POULTRIX_HISTORY` → same service, `assets` = `dist`), `worker.ts` (`/api/pi/*` → maintenance gateway, everything else → assets with SPA fallback), `vite.config.ts` (alias `@` → `../src`, Tailwind), `index.html`, `src/main.tsx`.
- `src/Console.tsx`: unlock screen; then the camera (auto-start, stops while hidden), a status strip from `snapshot` (every 5 s while visible), and the sections moved from `bypass.tsx`, with the Return to automatic / Resume / Exit bar.
- A maintenance Pi client sends the maintenance token.
- Root `package.json`: `build:maintenance`, `deploy:maintenance`.

**Acceptance:**
- [x] `npm run build:maintenance` OK; deploy created `https://maintenance.poultrix.workers.dev` (Worker `a4f615f6`, 2026-11-07)
- [x] Live: camera/snapshot without or with a bad token → 401; `feeding/*`, `status`, other `/api/*` → 404; a bad token reaches the Pi → 403 (tunnel OK); headers `x-frame-options: DENY`, `no-referrer`, HTML `no-store`. (Wrong-password 429 not re-tested live; same Pi limit verified in remote-access R1)

**Files:** `maintenance-site/*` (new), `package.json` · **Scope:** M · **Depends on:** M1

### Checkpoint M-A (owner, phone on mobile data)
- [x] Unlock with the bypass password; the camera shows (owner, 2026-11-07)
- [x] Relay 1 on/off and gate group 1 for 1 s are seen on the camera (owner, 2026-11-07)
- [x] Return to automatic, Resume, Exit work (owner, 2026-11-07)
- [x] Leaving the tab stops the stream (no `camera/stream` in the Pi log afterwards) (owner, 2026-11-07)

## M3: Remove bypass from the main app
**Status (2026-11-07):** implemented. `bypass.tsx` deleted (the route tree regenerated with no `/bypass`), the Settings link removed, the sign-out bypass-exit call removed (it now only clears the old token key), `APP_ROUTES` excludes bypass (22 routes). Gateway tests 49/49 (the main app now returns 404 for `bypass/*`). tsc unchanged; build ✅.

**Description:**
- Delete `src/routes/bypass.tsx` (the route tree regenerates).
- Remove the hidden Settings link and the `/bypass/exit` call in `profile.tsx` sign-out.
- Drop `bypass/*` from `APP_ROUTES`.
- Deploy the main app.

**Acceptance:**
- [x] `https://app.poultrix.workers.dev/bypass` → 404; `POST /api/pi/bypass/login` on the main app → 404 (live, Worker `399953c1`, 2026-11-07)
- [x] No "bypass" link in the main UI (bundle has no `/bypass` link)

**Files:** `src/routes/bypass.tsx` (delete), `src/routes/settings.tsx`, `src/routes/profile.tsx`, `src/lib/server/pi-gateway.ts` · **Scope:** S · **Depends on:** M-A

## M4: Docs
**Status (2026-11-07): done.** CLAUDE.md (two gateway instances, maintenance Worker, deploy/rollback, `npm run test:gateway`); Obsidian `BYPASS_MODE`, `API_REFERENCE`, `SYSTEM_ARCHITECTURE`, `FRONTEND`, `DEPLOYMENT`, `COMMANDS`, `CURRENT_STATUS`, `KNOWN_ISSUES`, `TODO`, AD-13 updated; `CAPABILITY_MAP` → done. Old Worker `poultrix` deleted (`poultrix.poultrix.workers.dev` → 404).

CLAUDE.md (second Worker, two auth modes, deploy commands), Obsidian (`BYPASS_MODE`, `API_REFERENCE`, `SYSTEM_ARCHITECTURE`, `FRONTEND`, `DEPLOYMENT`, `COMMANDS`, `CURRENT_STATUS`, `CHANGELOG`, `TEST_RESULTS`), `CAPABILITY_MAP` → done. `graphify update .`

## Risks
| Risk | Mitigation |
|---|---|
| The accepted brute-force risk (AD-21) | Per-IP limit on the Pi; `[AUDIT]` log shows `ip:` for every bypass action; Arduino 10 s timeout if the Pi stops pinging |
| Token validation adds a Pi round-trip to the camera/snapshot | 30 s cache per token |
| Vite build for a second app from the same repo | Separate `vite.config.ts` and output dir; the main build untouched |
| Losing maintenance access during the switch | The old `/bypass` stays until M-A passes |
