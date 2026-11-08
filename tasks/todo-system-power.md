# Plan + tasks: system-power

Spec: `SPEC-system-power.md` (approved 2026-11-08).

## Approach
Build the Pi routes and the gateway owner check first, with offline tests and no real reboot. Then the Settings card. Deploy everything together. The first real restart and power-off happen only in Checkpoint P-A, with the owner at the farm.

```
P1 Pi routes (+ offline harness) ─┐
P2 gateway owner-only routes ─────┴─ P3 Settings card ── deploy (owner "deploy" + owner secret) ── Checkpoint P-A (owner at the farm)
```

**Risks**
- **Climate control stops while the Pi is off**, because the Arduino is USB-powered. Mitigations:
  - the warning in the confirm dialog;
  - wake times only 5/15/30 min;
  - "stay off" needs its own explicit choice.
- **The Pi powers off but the wake alarm wasn't set:** the alarm is written and read back before power-off; if it doesn't match, the request is refused.
- **A non-owner powers off the farm:** the gateway checks `POULTRIX_OWNER_EMAILS`, and the Pi double-checks the forwarded `X-Poultrix-User`.
- **A request arrives during feeding:** refused with 409.

## P1: Pi routes
**Status (2026-11-08): built, not deployed.**
- `app.py`: `/api/system/reboot`, `/api/system/power-off`, `_system_power()`, `set_wake_alarm()` (clear, set, read back within ±10 s), `clear_wake_alarm()`, `_feeding_busy()`, `_prepare_for_power_action()` (job stop, schedule-test cancel, FEED:STOP, end maintenance), and a delayed `sudo -n systemctl reboot|poweroff` thread (fixed argv).
- The owner check uses the tunnel-trusted `X-Poultrix-User` against the env `POULTRIX_OWNER_EMAILS`; an empty list refuses everyone.
- Offline harness: 21/21. `py_compile` OK.
- Checked on the Pi (no power action): `sudo -n tee` clears `/sys/class/rtc/rtc0/wakealarm` and the file is world-readable. EEPROM `POWER_OFF_ON_HALT=0` (default).

**Description:** in `app.py`:
- `POST /api/system/reboot` `{confirm:"REBOOT"}` and `POST /api/system/power-off` `{confirm:"POWEROFF", minutes:5|15|30}` or `{confirm:"POWEROFF", minutes:null, stayOff:true}`.
- Each request is checked: it must come through the tunnel (localhost) from a user in `POULTRIX_OWNER_EMAILS` (env on the Pi, same value as the Worker), and no feeding may be active.
- **Sequence:** `FEED:STOP`, cancel jobs, end maintenance, `[AUDIT]`, then reply 202. After about 2 s a background thread runs `sudo -n systemctl reboot|poweroff` (fixed argv, no shell).
- **Wake alarm:** `sudo -n tee` writes `0`, then `+seconds`, to `/sys/class/rtc/rtc0/wakealarm`; it's read back and must be within ±5 s of the expected wake time, or the request is refused with 500.

**Acceptance:**
- [x] Offline harness (stubbed subprocess and serial):
  - wrong or missing confirm → 400;
  - bad minutes → 400;
  - not owner → 403;
  - dispensing → 409;
  - FEED:STOP and BYPASS:OFF before the command;
  - alarm read-back mismatch → 500, no power-off;
  - stay off clears the alarm;
  - argv exact.
- [x] `py_compile` OK.

**Files:** `raspberry-pi/app.py`, plus the systemd env on the Pi (`POULTRIX_OWNER_EMAILS`) · **Scope:** M

## P2: Gateway owner-only routes
**Status (2026-11-08): built, not deployed.** `PiRoute.owner`, the `POULTRIX_OWNER_EMAILS` env (Worker secret, to be set at deploy), `system/reboot` and `system/power-off` on `APP_ROUTES` (now 24); none on the maintenance site (12). Gateway tests ALL PASS (owner 200 with the fixed Pi path and owner user header; approved non-owner 403 `OWNER_ONLY` with no upstream call; signed out 401; GET 405; empty owner list refuses; non-owner can still read). tsc 13 (unchanged), lint clean for the gateway, build OK.

**Description:** a `PiRoute.owner` flag:
- the `supabase` auth checks the confirmed email against `POULTRIX_OWNER_EMAILS` (Worker secret), else 403 `OWNER_ONLY`;
- two `APP_ROUTES` entries;
- not in `MAINTENANCE_ROUTES`.

**Acceptance:**
- [x] `npm run test:gateway`:
  - owner → 200;
  - approved non-owner → 403 `OWNER_ONLY`;
  - signed out → 401;
  - GET → 405;
  - maintenance site → 404;
  - empty owner list refuses everyone.

**Files:** `src/lib/server/pi-gateway.ts`, `tests/pi-gateway/*` · **Scope:** S

## P3: Settings card
**Status (2026-11-08): built, not deployed.** New `src/components/poultrix/SystemPowerCard.tsx` on Settings.
- **Controls:** Restart system; Power off for 5/15/30 minutes, or and stay off.
- **Confirm dialogs** with the climate-control warning; stay off says nothing turns it back on remotely.
- **Banner** ("Restarting…" / "Powered off until about HH:MM" / "Turn it on at the farm"), kept in `sessionStorage`, cleared when a snapshot succeeds more than 45 s after the action.
- **Disabled** while a gate is DISPENSING or an action is pending.
- **Owner check:** 403 shows "Only the farm owner can do this".
- **Polling:** none added (uses the shared snapshot).
- **Checks:** lint clean (new file and settings), tsc 13 (unchanged), build OK.

**Description:** a "System power" card on `src/routes/settings.tsx` (component `SystemPowerCard.tsx`):
- **Restart** button, and **Power off** with 5/15/30 min / Stay off;
- confirm dialogs with the warnings from the spec;
- a banner kept in `sessionStorage` until the snapshot sees the Pi again;
- the `OWNER_ONLY` message;
- disabled while feed is dispensing (from the snapshot);
- no new polls.

**Acceptance:**
- [x] `npm run build`, `npm run lint` (no new errors).

**Files:** `src/components/poultrix/SystemPowerCard.tsx`, `src/routes/settings.tsx`, `src/lib/live-endpoints.ts` or `pi-client` call · **Scope:** S

## Deploy (owner says "deploy")
- Set the Worker secret `POULTRIX_OWNER_EMAILS` and the Pi env `POULTRIX_OWNER_EMAILS`, back up `app.py`, deploy the Pi and the Worker `app`.

### Checkpoint P-A (owner at the farm)
- [ ] Restart: the site shows "Restarting…" and comes back; same stage; `BOOT:AUTO`.
- [ ] Power off 5 min: note whether the Arduino LCD and relays stay powered while the Pi is off. The Pi wakes about 5 min later and the site comes back.
- [ ] (Optional) Stay off: power on with the Pi 5 button.
- [ ] Update the spec Facts with the USB-power answer.
