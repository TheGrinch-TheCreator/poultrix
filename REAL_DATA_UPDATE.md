# Poultrix real weight telemetry update

Changes: Dashboard, Feeding, and System Status now display separate hopper and trough weights from `GET /api/feeding/weight` (`hopperWeight`, `troughWeight`). The Feeding page no longer presents hardcoded demo feed amounts, fake feeding history, or fabricated accuracy. All weight requests poll every 3 seconds. Arduino-calibrated grams are converted to kilograms for display only.

Expected API shape (example only, not a claim about current Pi response):
```json
{
  "hopperWeight": {"connected": true, "status": "OK", "weightGrams": 2500, "updatedAt": "2026-10-28T00:00:00Z"},
  "troughWeight": {"connected": true, "status": "OK", "weightGrams": 500, "updatedAt": "2026-10-28T00:00:00Z"}
}
```
If your actual backend uses different keys, update `src/lib/live-weights.ts` and the accessors or update the backend response. The uploaded ZIP contains frontend only; backend response shape could not be independently verified. No new calibration constants were added to the frontend.

For production: configure `VITE_POULTRIX_API_URL` in your Cloudflare deployment to a **reachable HTTPS** API endpoint. The default `http://192.168.1.48:5000` works only in certain local setups and is blocked or inaccessible from many HTTPS/mobile contexts. Secure authentication, CORS and transport are required for remote access. Do not expose actuator control endpoints without authorization.

Deployment: test `npm ci` and `npm run build` locally, commit to GitHub, push and let Cloudflare rebuild. Back up the deployed frontend first. No Raspberry Pi or Arduino files are changed by this ZIP.
