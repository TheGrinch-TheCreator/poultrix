import { createFileRoute } from '@tanstack/react-router'
import { env } from 'cloudflare:workers'

type Bindings = {
  POULTRIX_HISTORY?: { fetch: (input: string | Request, init?: RequestInit) => Promise<Response> }
  SUPABASE_URL?: string
  SUPABASE_PUBLISHABLE_KEY?: string
}
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
}
async function handler({ request }: { request: Request }) {
  const bindings = env as unknown as Bindings
  const token = /^Bearer\s+(.+)$/i.exec(request.headers.get('authorization') ?? '')?.[1]
  if (!token) return json({ error: 'Authentication required' }, 401)
  if (!bindings.SUPABASE_URL || !bindings.SUPABASE_PUBLISHABLE_KEY || !bindings.POULTRIX_HISTORY)
    return json({ error: 'Alert API bindings are not configured' }, 503)
  try {
    const auth = await fetch(`${bindings.SUPABASE_URL.replace(/\/$/, '')}/auth/v1/user`, {
      headers: { authorization: `Bearer ${token}`, apikey: bindings.SUPABASE_PUBLISHABLE_KEY },
      signal: AbortSignal.timeout(8000),
    })
    if (!auth.ok) return json({ error: 'Invalid or expired session' }, 401)
    const user = await auth.json() as { id?: string }
    if (!user.id) return json({ error: 'Invalid session' }, 401)
    let body: string | undefined
    if (request.method !== 'GET') {
      const raw = await request.text()
      if (raw.length > 1024) return json({ error: 'Payload too large' }, 413)
      let parsed: unknown
      try { parsed = JSON.parse(raw) } catch { return json({ error: 'Invalid JSON' }, 400) }
      if (!parsed || typeof parsed !== 'object' || !('id' in parsed) ||
          typeof parsed.id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(parsed.id))
        return json({ error: 'Invalid alert ID' }, 400)
      body = JSON.stringify({ id: parsed.id })
    }
    const upstream = await bindings.POULTRIX_HISTORY.fetch('http://127.0.0.1:5000/api/alerts/acknowledgements', {
      method: request.method,
      headers: { 'accept': 'application/json', 'content-type': 'application/json', 'X-Poultrix-User': user.id },
      body, signal: AbortSignal.timeout(12000),
    })
    if (!(upstream.headers.get('content-type') ?? '').includes('application/json'))
      return json({ error: 'Invalid response from private alerts backend' }, 502)
    return json(await upstream.json(), upstream.status)
  } catch (error) {
    console.error('Poultrix alerts route failed', error)
    return json({ error: 'Unable to contact private alerts backend' }, 502)
  }
}
export const Route = createFileRoute('/api/alerts/acknowledgements')({
  server: { handlers: { GET: handler, POST: handler, DELETE: handler } },
})
