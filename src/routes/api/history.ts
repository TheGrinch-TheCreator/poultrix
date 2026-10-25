import { createFileRoute } from '@tanstack/react-router'
import { env } from 'cloudflare:workers'

type HistoryBindings = {
  POULTRIX_HISTORY?: { fetch: (input: string | Request, init?: RequestInit) => Promise<Response> }
  SUPABASE_URL?: string
  SUPABASE_PUBLISHABLE_KEY?: string
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  })
}

async function getHistory({ request }: { request: Request }): Promise<Response> {
  const bindings = env as unknown as HistoryBindings
  const match = /^Bearer\s+(.+)$/i.exec(request.headers.get('authorization') ?? '')
  if (!match) return json({ error: 'Authentication required' }, 401)

  const url = new URL(request.url)
  const daysText = url.searchParams.get('days') ?? '1'
  if (!['1', '7', '30'].includes(daysText)) {
    return json({ error: 'days must be 1, 7, or 30' }, 400)
  }

  const supabaseUrl = bindings.SUPABASE_URL
  const supabaseKey = bindings.SUPABASE_PUBLISHABLE_KEY
  if (!supabaseUrl || !supabaseKey || !bindings.POULTRIX_HISTORY) {
    return json({ error: 'History API bindings are not configured' }, 503)
  }

  try {
    const auth = await fetch(`${supabaseUrl.replace(/\/$/, '')}/auth/v1/user`, {
      headers: { authorization: `Bearer ${match[1]}`, apikey: supabaseKey },
      signal: AbortSignal.timeout(8000),
    })
    if (!auth.ok) return json({ error: 'Invalid or expired session' }, 401)
    const user = (await auth.json()) as { id?: string }
    if (!user.id) return json({ error: 'Invalid session' }, 401)

    // Fixed, read-only upstream path: never proxy hardware-control endpoints.
    const upstream = await bindings.POULTRIX_HISTORY.fetch(
      `http://127.0.0.1:5000/api/history?days=${daysText}`,
      { method: 'GET', headers: { accept: 'application/json' }, signal: AbortSignal.timeout(12000) },
    )
    if (!upstream.ok) return json({ error: 'Private history backend unavailable' }, 502)
    const contentType = upstream.headers.get('content-type') ?? ''
    if (!contentType.includes('application/json')) return json({ error: 'History backend returned non-JSON response' }, 502)
    return json(await upstream.json())
  } catch (error) {
    console.error('Poultrix history route failed:', error)
    return json({ error: 'Unable to retrieve history' }, 502)
  }
}

export const Route = createFileRoute('/api/history')({
  server: {
    handlers: {
      GET: getHistory,
    },
  },
})
