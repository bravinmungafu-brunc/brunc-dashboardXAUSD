// app/api/fetch-calendar/route.ts
//
// Runs ONCE PER DAY (cron: e.g. daily at 00:05 UTC, not every 10
// minutes like the other jobs). JBlanked's free tier is confirmed at
// 1 request/day directly from their own docs, which is exactly why
// this route is idempotent -- it checks whether today's events are
// already cached BEFORE calling out, so an accidental duplicate
// trigger (or a cron misconfigured to run more often) can never waste
// the single daily request.
//
// Endpoint and auth format confirmed from JBlanked's own documentation:
//   GET https://www.jblanked.com/news/api/mql5/calendar/today/
//   Authorization: Api-Key YOUR_KEY
//
// HONEST GAP: the exact response field names weren't confirmed from a
// live sample during research -- extractField() below checks a few
// likely variants per field rather than assuming one fixed schema.
// Check the first real response this route gets and adjust the
// candidate field names if the actual shape differs.

import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL as string,
  process.env.SUPABASE_SERVICE_KEY as string
)

const JBLANKED_KEY = process.env.JBLANKED_API_KEY
const CRON_SECRET = process.env.CRON_SECRET

function todayUTC() {
  return new Date().toISOString().slice(0, 10)
}

function extractField(obj: any, candidates: string[]): any {
  for (const key of candidates) {
    if (obj?.[key] !== undefined && obj[key] !== null) return obj[key]
  }
  return null
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  if (!CRON_SECRET || searchParams.get('secret') !== CRON_SECRET) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }
  if (!JBLANKED_KEY) {
    return Response.json({ error: 'JBLANKED_API_KEY not set.' })
  }

  const today = todayUTC()

  // Idempotent guard -- this is the actual protection for the 1/day limit.
  const { data: existing } = await supabase
    .from('calendar_events')
    .select('id')
    .eq('fetched_for_date', today)
    .limit(1)

  if (existing && existing.length > 0) {
    return Response.json({ skipped: true, reason: 'already_cached_today', date: today })
  }

  try {
    const res = await fetch('https://www.jblanked.com/news/api/mql5/calendar/today/', {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Api-Key ${JBLANKED_KEY}`,
      },
      signal: AbortSignal.timeout(15000),
    })
    const data = await res.json()

    if (!res.ok) {
      return Response.json({ error: `JBlanked HTTP ${res.status}`, detail: data })
    }

    const rawEvents: any[] = Array.isArray(data) ? data : (data?.events ?? data?.results ?? [])

    const rows = rawEvents
      .map((e: any) => ({
        event_time: extractField(e, ['date', 'time', 'event_time', 'datetime']),
        currency: extractField(e, ['currency', 'economy', 'symbol']),
        event_name: extractField(e, ['name', 'event', 'title']),
        impact: extractField(e, ['impact', 'strength', 'category']),
        fetched_for_date: today,
      }))
      .filter((r: any) => r.event_time) // drop anything we couldn't parse a time for

    if (rows.length > 0) {
      await supabase.from('calendar_events').insert(rows)
    }

    return Response.json({ fetched: rows.length, date: today })
  } catch (err: any) {
    return Response.json({ error: err?.message ?? String(err) })
  }
}