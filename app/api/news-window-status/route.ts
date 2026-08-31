// app/api/news-window-status/route.ts
//
// Lightweight, read-only, no cron secret required -- this is meant to
// be polled directly by the frontend (Sidebar, Topbar, News Signals
// page) for the live blue indicator, not just called by a cron job.
// Pure Supabase read against the already-cached calendar_events table
// -- zero external API cost no matter how often this gets called.
//
// "Active" means: right now falls within PRE_MINUTES before or
// POST_MINUTES after a HIGH-impact cached event. Impact matching is
// case-insensitive substring match rather than an exact string
// comparison, since JBlanked's real field values weren't confirmed
// from a live sample as of when this was written (see fetch-calendar
// route's own honest-gap note) -- safer to match loosely than to
// silently miss real high-impact events over an exact-casing mismatch.

import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL as string,
  process.env.SUPABASE_SERVICE_KEY as string
)

const PRE_MINUTES = 15
const POST_MINUTES = 30

export async function GET() {
  const now = new Date()
  const windowStart = new Date(now.getTime() - POST_MINUTES * 60000)
  const windowEnd = new Date(now.getTime() + PRE_MINUTES * 60000)

  const { data } = await supabase
    .from('calendar_events')
    .select('event_time, currency, event_name, impact')
    .gte('event_time', windowStart.toISOString())
    .lte('event_time', windowEnd.toISOString())
    .order('event_time', { ascending: true })

  const highImpact = (data ?? []).filter((e: any) =>
    typeof e.impact === 'string' && e.impact.toLowerCase().includes('high')
  )

  if (highImpact.length === 0) {
    return Response.json({ active: false, event: null })
  }

  const e = highImpact[0] as any
  return Response.json({
    active: true,
    event: {
      time: e.event_time,
      currency: e.currency,
      name: e.event_name,
      impact: e.impact,
      label: `${e.currency ?? ''} ${e.event_name ?? 'economic event'} (${e.impact ?? 'high'} impact)`,
    },
  })
}