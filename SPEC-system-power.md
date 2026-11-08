# Spec: system-power

Status: **APPROVED 2026-11-08** (owner: Q1 5/15/30 min or stay off, Q2 owner account only, Q3 yes). Plan and tasks: `tasks/todo-system-power.md`. New module `system-power` in `CAPABILITY_MAP.md` (depends on `remote-access` for login-protected controls).

## Objective
Buttons on the main site (Settings) to **safely reboot** the Raspberry Pi, or **safely power it off with a wake timer** so it turns itself back on. There's no remote power-on once the Pi is off; the Pi 5's built-in clock (RTC) wakes it.

Owner answers (2026-11-08):
1. The Arduino is powered **from the Pi's USB**.
2. Power-on method: **wake timer**.
3. Buttons on the **main site**.

### User stories
1. I press **Restart system**, confirm, and the site shows "Restarting…". It comes back by itself in about 1–2 minutes.
2. I press **Power off**, pick how long, confirm, and the Pi shuts down cleanly. At the chosen time it powers itself back on and the site comes back.
3. Or I pick **Stay off**: the Pi shuts down with no wake time, and I power it on at the farm (Pi 5 power button, or unplug and replug).

## Facts (verified 2026-11-08)
- **Pi:** Raspberry Pi 5 Model B. It has a real-time clock, `rtc0` (`rpi-rtc`). On a Pi 5, writing seconds to `/sys/class/rtc/rtc0/wakealarm` and then halting makes the board power itself back on at that time (Raspberry Pi documentation, "Real Time Clock"). This needs no battery while the power adapter stays plugged in.
- **sudo:** the `raspberry` user has passwordless sudo.
- **Arduino power:** the Arduino runs on the Pi's USB, so it may lose power while the Pi is off. With the relays active-low and unpowered, the heater and fans are then **off for the whole power-off time**. Climate control stops.
  - It's not yet verified whether the Pi 5 keeps USB powered while halted. A supervised test answers it (Checkpoint P-A).
- **Reboot:** the Arduino keeps its stage in EEPROM and restarts in automatic control (`BOOT:AUTO`) when the Pi's serial port reopens. The site is offline for about 1–2 min.

## Design
1. **Pi routes** (`app.py`), each needing a JSON body `{"confirm": "REBOOT"}` / `{"confirm": "POWEROFF", "minutes": N}`:
   - `POST /api/system/reboot`
   - `POST /api/system/power-off`

   **Checks before acting:** refuse (409) while feed is dispensing or a feeding job is running. `minutes` must be 5, 15 or 30, or `null` for stay off.

   **Safe sequence:**
   1. `FEED:STOP`;
   2. cancel jobs and end any maintenance session (`BYPASS:OFF`);
   3. log `[AUDIT] system reboot|power-off N min by <user>`;
   4. reply 202 with `{action, wakeAt}`;
   5. after about 2 s, in a background thread:
      - reboot: `sudo systemctl reboot`;
      - power-off with a timer: write `+N*60` to `rtc0/wakealarm` (clearing it first), check it was set, then `sudo systemctl poweroff`. **If the wake alarm can't be set, refuse with 500 and don't power off.**
      - stay off: clear any wake alarm, then `sudo systemctl poweroff`. It needs `{"confirm": "POWEROFF", "minutes": null, "stayOff": true}`.
2. **Gateway:** two new `APP_ROUTES` entries with a new `owner: true` flag.
   - These routes need the Supabase login **and** an email in the new Worker secret `POULTRIX_OWNER_EMAILS` (owner decision: only johnkarlduenas@gmail.com). Otherwise 403 `OWNER_ONLY`.
   - An empty list refuses everyone.
   - None on the maintenance site.
3. **Main site, Settings, new "System power" card:**
   - **Restart system:** confirm dialog: "The site goes offline for about 2 minutes. Climate control pauses briefly while the Arduino restarts."
   - **Power off:** pick 5, 15 or 30 minutes, or **Stay off** (warning: "Nothing turns it back on remotely. Someone must press the Pi's power button or replug it. Heater and fans stay off until then."). The confirm dialog shows the wake time and a clear warning: "The Arduino is powered by the Pi. Heater and fans stay off until <time>. Chicks may get cold or hot."
   - **After confirming:** a "Restarting…" or "Powered off until <time>" banner, kept in `sessionStorage`. It hides when the snapshot poll sees the Pi again, with no extra polling.
   - The power-off button is disabled while feed is being dispensed.
   - Other approved accounts get "Only the farm owner can do this" (403 `OWNER_ONLY`).
4. **Docs:** CLAUDE.md, API_REFERENCE, vault.

## Commands
```
npm run test:gateway                 # new routes on the main table; not on maintenance
npm run build && npm run lint
python -m py_compile raspberry-pi/app.py
npm run build && npx wrangler deploy # needs owner "deploy"
```

## Testing strategy
- **Gateway tests:** both routes POST-only on the main app, 401 without login, 404 on the maintenance site.
- **Offline harness** (stubbed `subprocess`, wake alarm and serial):
  - confirm words required;
  - minutes validated;
  - refused while dispensing;
  - FEED:STOP and BYPASS:OFF sent before the command;
  - no power-off if the wake alarm write fails.
- **Checkpoint P-A (owner present at the farm, supervised):**
  - Reboot from the site; the site comes back, the stage is kept, `BOOT:AUTO`.
  - Power off for **5 minutes**. Watch whether the Arduino LCD stays on (USB powered while halted?) and whether the Pi wakes on time. Then update this spec with the answer.

## Boundaries
- **Always:**
  - stop feeding and end maintenance first;
  - log `[AUDIT]`;
  - never power off without a wake alarm that was set and checked.
- **Ask first:**
  - other wake durations than 5/15/30 minutes;
  - adding the buttons to the maintenance site.
- **Never:**
  - a power-off with no wake time unless the owner explicitly chose **Stay off**;
  - routes reachable without login;
  - building the shell command from request data (fixed commands only; `minutes` from an allowed list).

## Success criteria
1. Restart from Settings brings the site back by itself, with the same stage and automatic control.
1b. Only the owner account can reboot or power off (gateway 403 `OWNER_ONLY` for other approved accounts).
2. Power-off for N minutes wakes the Pi by itself at about the shown time, and the site comes back.
3. Both are refused while feed is dispensing, need login plus confirmation, and are logged.
4. Gateway tests, build and lint pass.

## Decisions (owner, 2026-11-08)
1. Power-off: 5, 15 or 30 minutes with a wake timer, **or stay off** (manual power-on at the farm).
2. Only the owner account (johnkarlduenas@gmail.com) may use it.
3. The owner is present for Checkpoint P-A.
