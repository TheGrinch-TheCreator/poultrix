# Implementation Plan: remote-access

Spec: `SPEC-remote-access.md` (approved 2026-11-07) · Tasks: `tasks/todo-remote-access.md`

## Approach
Build the new path **next to** the current one, switch the frontend over, and only then close the old path. At every step the farm keeps working: the Arduino runs climate control on its own, and until R7 the LAN path still works.

```
Phase 1 (backend, invisible to users)
  R1 Pi: /api/snapshot, bypass rate limit, user log, drop /api/test/*
  R2 Worker: /api/pi/* allowlist + JWT/allowlist auth          ── Checkpoint R-A (curl matrix)
Phase 2 (frontend switch)
  R3 pi-client + shared snapshot store (5 s, pause when hidden)
  R4 pages/components → adapters (feeding, AI, flock, profile…)
  R5 bypass page → pi-client (login + maintenance token)
  R6 remove API_URL; deploy                                    ── Checkpoint R-B (phone on mobile data)
Phase 3 (close the old paths)
  R7 Pi: bind 127.0.0.1, remove CORS
  R8 retire the telemetry uploader + Worker
  R9 docs                                                      ── Checkpoint R-C (complete)
```

## Key decisions
- **One Worker route file, explicit table.** `src/routes/api/pi/$.ts` matches `(method, path)` against a `const` table. The upstream URL is `'http://127.0.0.1:5000' + entry.path`, taken from the table entry, never from the request. Query strings are only copied for listed keys (e.g. none for most routes).
- **Local JWT verification** (WebCrypto `ECDSA P-256 / SHA-256`, JWKS cached 10 min in module scope, refetched on an unknown `kid`). No Supabase round-trip per request, which matters at 1 request / 5 s / tab. Claims checked: `exp`, `iss = <SUPABASE_URL>/auth/v1`, `aud = authenticated`, `email`, and `user_metadata`/`email_verified` (or `app_metadata`). If the token lacks a reliable confirmed flag, fall back to one `/auth/v1/user` call per user, cached 5 min, and check `email_confirmed_at`.
- **Allowlist secret** `POULTRIX_ALLOWED_EMAILS` via `npx wrangler secret put` (the owner provides the emails). It's never in the repo.
- **Snapshot endpoint on the Pi** (`GET /api/snapshot`) returns `{status, ai, weight, health, feeding}` from in-memory state. It's one cheap call, and the existing per-endpoint routes stay for the feeding/AI pages.
- **Shared poller in the browser.** One module-level store (the `live-alerts.ts` pattern) polls `/api/pi/snapshot` every 5 s while `document.visibilityState === "visible"`. `useHardware`, `useAI`, weights and alerts all read from it, so there's one request per tab per 5 s.
- **Token plumbing.** `pi-client.ts` gets the session from `supabase.auth.getSession()` (auto-refreshing) and sets `Authorization: Bearer`. A 401 triggers one refresh + retry; a 403 shows "Account not approved".
- **Camera.** `<img src="/api/pi/camera/stream?access_token=…">`. The Worker accepts a query token for this one route only and streams `upstream.body` straight through.
- **Rate limit on the Pi** for `/api/bypass/login`, keyed by `X-Poultrix-User` (falling back to the remote address).

## Request budget (free plan, 100k/day)
| Source | Per tab, all day |
|---|---|
| Snapshot every 5 s (visible) | 17,280 |
| Page actions, feeding/AI pages | < 1,000 |
| Camera | 1 per view |

With 1–3 users who don't keep the tab open 24 h, expect < 40k/day. Verify on the Cloudflare dashboard after 24 h (success criterion 6).

## Risks and mitigations
| Risk | Mitigation |
|---|---|
| Lock-down (R7) breaks the tunnel | Verified: the VPC service targets `127.0.0.1:5000`. Rollback: restore the `app.py` backup |
| JWKS verification bug locks everyone out | R2 is deployed while the old LAN path still works; the R-A curl matrix runs before the frontend switch |
| Snapshot polling exceeds the free plan | Visibility pause + single store; check the dashboard; fall back to 10 s if needed |
| MJPEG stream held open by a background tab | Stop the stream on unmount and on hidden |
| An allowlisted helper's email registered by someone else | Require a confirmed email |
| Internet down at the farm → no app | Accepted (Q2). The Arduino keeps climate control; the LCD shows the state |
| Bypass via the Worker adds latency to ACK-gated actions | Worker timeout 15 s for bypass/feeding POSTs; the UI already waits for ACKs |

## Verification checkpoints
- **R-A (after R1, R2):** the curl matrix against the deployed Worker (401 / 403 / 404 / 405 / 413 / 200, plus a live snapshot). The current site is unaffected.
- **R-B (after R6):** the owner on a phone on mobile data: dashboard live within 10 s, a supervised short manual feed, bypass login + Resume, camera on the AI page, the "Account not approved" message for a non-listed account. No `192.168.` in the bundle.
- **R-C (after R7–R9):** LAN `curl 192.168.1.48:5000` refused; the app still works on Wi-Fi; the telemetry Worker is gone; docs updated; a 24 h request count under budget.
