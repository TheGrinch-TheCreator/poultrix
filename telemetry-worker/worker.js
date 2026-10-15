
 // Poultrix telemetry-only Worker. No hardware-control routes are exposed.
export class TelemetryStore {
  constructor(state) { this.state = state; }
  async fetch(request) {
    if (request.method === 'POST') {
      const payload = await request.json();
      await this.state.storage.put('latest', { payload, receivedAt: Date.now() });
      return Response.json({ ok: true });
    }
    const stored = await this.state.storage.get('latest');
    return Response.json(stored || { payload: null, receivedAt: null });
  }
}

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
};
const json = (value, status = 200) => Response.json(value, { status, headers });
const maxAgeMs = 15000;
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    if (url.pathname === '/health' && request.method === 'GET') return json({ ok: true });
    if (!['/api/status', '/api/ai/status', '/api/feeding/weight'].includes(url.pathname) && url.pathname !== '/ingest') return json({ error: 'Not found' }, 404);
    if (url.pathname === '/ingest') {
      if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
      const auth = request.headers.get('Authorization') || '';
      if (!env.INGEST_TOKEN || auth !== `Bearer ${env.INGEST_TOKEN}`) return json({ error: 'Unauthorized' }, 401);
      if (Number(request.headers.get('Content-Length') || 0) > 16000) return json({ error: 'Too large' }, 413);
      let body;
      try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }
      if (!body || typeof body !== 'object' || Array.isArray(body)) return json({ error: 'Invalid payload' }, 400);
      const allowed = ['connected','mode','stage','temperature','humidity','lightRaw','lux','fansOn','heatersOn','led','temperatureTarget','camera','ai','hopperWeight','troughWeight','feedWeightGrams','feedWeightStatus','feedWeightUpdatedAt','lastSeen','sensorSource'];
      const safe = Object.fromEntries(allowed.filter(k => Object.prototype.hasOwnProperty.call(body,k)).map(k => [k,body[k]]));
      const stub = env.TELEMETRY.idFromName('poultrix');
      const result = await env.TELEMETRY.get(stub).fetch('https://internal/', { method:'POST', body: JSON.stringify(safe), headers: { 'Content-Type':'application/json' } });
      return json({ ok: result.ok }, result.ok ? 200 : 502);
    }
    if (request.method !== 'GET') return json({ error: 'Read-only endpoint' }, 405);
    const stub = env.TELEMETRY.idFromName('poultrix');
    const result = await env.TELEMETRY.get(stub).fetch('https://internal/');
    const stored = await result.json();
    if (!stored.payload) return json({ connected:false, telemetryOnline:false, telemetryError:'No telemetry received' }, 503);
    const fresh = Date.now() - stored.receivedAt <= maxAgeMs;
    const p = stored.payload;
    if (url.pathname === '/api/ai/status') return json({ ...(p.ai || {}), telemetryOnline:fresh, telemetryReceivedAt:new Date(stored.receivedAt).toISOString() });
    if (url.pathname === '/api/feeding/weight') return json({ hopperWeight:p.hopperWeight ?? null, troughWeight:p.troughWeight ?? null, feedWeightGrams:p.feedWeightGrams ?? null, feedWeightStatus:p.feedWeightStatus ?? 'WAITING', telemetryOnline:fresh });
    return json({ ...p, connected:Boolean(p.connected) && fresh, telemetryOnline:fresh, telemetryReceivedAt:new Date(stored.receivedAt).toISOString() });
  }
};
