# Capability Map: Poultrix v2

Status: map approved 2026-11-06 (module boundaries and order). `remote-access` and `maintenance-site` still have open design questions.
Each module gets its own `SPEC-<module-id>.md` at the repo root. This map is the index.

| Module id | Responsibility | Depends on | Spec |
|---|---|---|---|
| `always-live` | Remove SAFE/TEST modes and the LIVE/SAFE switch. Arduino boots into and stays in automatic control, including when the Pi is offline. Fix "bypass leaves system stuck in SAFE". | — | `SPEC-always-live.md` (approved) |
| `remote-access` | Use the app and live data from outside the LAN (mobile data), for multiple users, with login required for every control action. Absorbs the auth parts of `SPEC-pi-control-hardening.md`. | — | spec approved 2026-11-07; plan `tasks/plan-remote-access.md`, tasks `tasks/todo-remote-access.md` (R1–R9) |
| `maintenance-site` | Separate bypass-only site, entered with the bypass password, with live camera view. Bypass button removed from Settings. | `always-live`, `remote-access` | not written |
| `stage-schedule` | Day-gated AI analysis: Starter at batch start, Grower from day 11 (retry daily), Finisher from day 25 (retry daily). Batch start date set on the Flock page. | — | not written |
| `auto-feeding` | Unattended scheduled feeding for the confirmed stage: dispense = target − trough weight (min 0); skip the session if trough ≥ target. 10 s / ~1 kg cap kept. | `always-live` | not written |

Build order: `always-live` → `remote-access` → `maintenance-site`; `stage-schedule` → `auto-feeding` (may run in parallel with the first track; `auto-feeding` ships only after `remote-access` login protects controls).

## Decisions recorded (from the owner, 2026-11-06)
- **No SAFE mode anywhere.** On Pi/serial loss, the Arduino keeps its current stage settings and keeps running automatic temperature/lighting control. It must not switch fans/heater off because the Pi is gone; it just indicates "Pi offline".
- **The bypass "serial hiccup" must be removed** (entering bypass must not drop the system into SAFE or a stuck state).
- **Stage rule change:** the batch day decides *when* the AI analyses and *which* stage it may confirm. The AI still confirms the stage. AGENTS.md and CLAUDE.md will be updated in `stage-schedule`.
- **Day 1** = batch start date, entered on the **Flock** page.
- **Missed Grower/Finisher detection:** retry once a day until confirmed. No automatic fallback by day.
- **Trough rule:** dispense = target − trough weight, never below 0. Skip the session if trough ≥ target.
- **Users:** more than one person needs remote access. **No custom domain** is owned.

- **Remote access:** every signed-in (Supabase) user may control hardware; no roles. Hosting stays on Cloudflare `*.workers.dev` (no domain needed), reaching the Pi over the existing Workers VPC binding. Vercel was considered and rejected (no private link to the Pi; the app is Cloudflare-specific).
- **Maintenance site:** separate Worker (e.g. `poultrix-maintenance.<account>.workers.dev`), bypass password required.

## Superseded
`SPEC-pi-control-hardening.md` was deleted 2026-11-06 with the owner's OK. Its auth/CORS/test-route/rate-limit parts move into `remote-access`; forward-only AI moves into `stage-schedule`. Its R1 (restore SAFE) is dropped.
