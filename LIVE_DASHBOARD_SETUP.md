# Poultrix v5 Live Dashboard

This is the user's POULTRIX_Independent_Local_v5(2) source project with its dashboard route replaced by live hardware-backed cards. Existing UI theme and other routes are retained.

## Setup

1. Install Node.js and run `npm install` then `npm run dev` in this directory.
2. Configure `.env.local` with `VITE_POULTRIX_API_URL=http://192.168.1.48:5000` for testing from the same LAN.
3. Start the *latest* Raspberry Pi Flask backend (the weight+health-integrated version, not the older uploaded app(3).py).
4. Verify on Pi: `curl http://127.0.0.1:5000/api/status`, `curl http://127.0.0.1:5000/api/system/health`, `curl http://127.0.0.1:5000/api/feeding/weight`, `curl http://127.0.0.1:5000/api/feeding/status`, `curl http://127.0.0.1:5000/api/ai/status`.
5. For actual DHT22 and LDR readings, switch the Arduino to LIVE mode through the existing backend POST /api/mode/live after verifying actuator safety. TEST mode is deliberately not shown as real sensor data.

## Deployment caution

An HTTPS Cloudflare Pages site cannot directly fetch an HTTP private LAN IP. Use a secure HTTPS backend address, with access controls and carefully restricted actuator POST endpoints, and set `VITE_POULTRIX_API_URL` to that address at build time. Do not expose the unauthenticated Flask backend to the public internet. Avoid `CORS(app)` unrestricted in public deployments.

## Current limitations

- Four half-bridge load sensors on one HX711 yield a combined estimate for both compartments; no per-compartment values.
- The current calibration is provisional; do not interpret it as verified accuracy.
- AI stage and Arduino control stage are separate.
- Backend health READY is not proof that DHT22 is reporting valid live values.
- No persistent history is claimed. Other pages may still contain demo data; only the Dashboard was converted in this update.
