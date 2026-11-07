# Retired (2026-11-07)

This read-only telemetry mirror is no longer deployed.

- The Cloudflare Worker `telemetry-worker` was deleted with `npx wrangler delete telemetry-worker`. It served farm status publicly, without a login.
- `poultrix-telemetry.service` on the Pi is stopped and disabled.
- Its replacement is the authenticated gateway `/api/pi/*` in the main Worker (`src/lib/server/pi-gateway.ts`), which needs a Supabase login and an approved email. See `SPEC-remote-access.md` (Q4) and remote-access task R8.

The code is kept for reference. Don't redeploy it without adding authentication.
