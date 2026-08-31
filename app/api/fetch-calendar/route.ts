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

  // Idempotent guard, now checking whether TODAY was already
  // ATTEMPTED (not just whether it succeeded) -- a real gap found
  // live: a call that reaches JBlanked but extracts zero events still
  // spends the day's one free request, and the original version of
  // this check didn't account for that.
  const { data: existingAttempt } = await supabase
    .from('calendar_fetch_attempts')
    .select('attempt_date, events_extracted')
    .eq('attempt_date', today)
    .maybeSingle()

  if (existingAttempt) {
    return Response.json({
      skipped: true,
      reason: 'already_attempted_today',
      date: today,
      events_extracted_on_that_attempt: existingAttempt.events_extracted,
      note: 'JBlanked\'s free tier is 1 request/day. Today\'s single attempt already happened -- try again after the daily reset, not before.',
    })
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

    // Record the attempt IMMEDIATELY, before parsing -- this is what
    // actually protects the scarce 1/day quota, since the request has
    // already been spent the moment this fetch call was made,
    // regardless of what happens next.
    await supabase.from('calendar_fetch_attempts').upsert({ attempt_date: today, events_extracted: 0 })

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
    await supabase.from('calendar_fetch_attempts').update({ events_extracted: rows.length }).eq('attempt_date', today)

    // DIAGNOSTIC: if nothing was extracted, show a sample of the raw
    // response so the field-name guesses in extractField() can be
    // corrected from real data instead of guessed again. Safe to
    // leave in permanently -- only adds output on the zero-events
    // case, never affects normal operation once this is fixed.
    if (rows.length === 0) {
      return Response.json({
        fetched: 0,
        date: today,
        diagnostic_note: 'Zero events extracted -- likely a field-name mismatch, not a real "no events today". Check raw_sample below against extractField()\'s candidate names. This attempt is now recorded -- next try is tomorrow, not another call today.',
        raw_sample: Array.isArray(rawEvents) ? rawEvents.slice(0, 2) : rawEvents,
      })
    }

    return Response.json({ fetched: rows.length, date: today })
  } catch (err: any) {
    return Response.json({ error: err?.message ?? String(err) })
  }
}