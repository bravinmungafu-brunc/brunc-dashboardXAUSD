// app/api/check-transitions/route.ts
//
// Cron-triggered (every 5 minutes). Detects real state transitions
// and writes a notification row for each:
//   1. Session change (existing) -- e.g. London ended, NY began.
//   2. News window going live (existing).
//   3. Upcoming session warning (NEW) -- a session is about to begin.
//   4. Market open/closed transition (NEW).
//   5. Daily/weekly high-low break (NEW) -- live price crossed the
//      previous completed day's or week's high/low.
// "Last known state" tracked in app_settings throughout.

import { createClient } from '@supabase/supabase-js'
import { getActiveSession, isMarketOpen, getUpcomingSession } from '@/lib/sessions'
import { checkPriceLevelBreaks } from '@/lib/priceLevels'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL as string,
  process.env.SUPABASE_SERVICE_KEY as string
)

const CRON_SECRET = process.env.CRON_SECRET

async function getSetting(key: string): Promise<string | null> {
  const { data } = await supabase.from('app_settings').select('value').eq('key', key).maybeSingle()
  if (!data) return null
  return typeof data.value === 'string' ? data.value : JSON.stringify(data.value)
}

async function setSetting(key: string, value: string) {
  await supabase.from('app_settings').upsert({ key, value })
}

async function getActiveNewsEvent(): Promise<{ label: string } | null> {
  const now = new Date()
  const windowStart = new Date(now.getTime() - 30 * 60000)
  const windowEnd = new Date(now.getTime() + 15 * 60000)

  const { data } = await supabase
    .from('calendar_events')
    .select('event_time, currency, event_name, impact')
    .gte('event_time', windowStart.toISOString())
    .lte('event_time', windowEnd.toISOString())
    .order('event_time', { ascending: true })

  const highImpact = (data ?? []).filter((e: any) =>
    typeof e.impact === 'string' && e.impact.toLowerCase().includes('high')
  )
  if (highImpact.length === 0) return null
  const e = highImpact[0] as any
  return { label: `${e.currency ?? ''} ${e.event_name ?? 'economic event'} (${e.impact ?? 'high'} impact)` }
}

function formatPrice(p: number): string {
  return p.toFixed(2)
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  if (!CRON_SECRET || searchParams.get('secret') !== CRON_SECRET) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const results: string[] = []
  const now = new Date()

  // --- 1. Session transition (existing) ---
  const currentSession = getActiveSession(now)
  const currentSessionName = currentSession?.name ?? ''
  const lastSessionName = (await getSetting('last_known_session')) ?? ''

  if (currentSessionName !== lastSessionName) {
    let message: string
    if (currentSessionName && lastSessionName) {
      message = `${lastSessionName} session ended. ${currentSessionName} session has begun.`
    } else if (currentSessionName && !lastSessionName) {
      message = `${currentSessionName} session has begun.`
    } else {
      message = `${lastSessionName} session ended.`
    }
    await supabase.from('notifications').insert({ type: 'session_change', message, detail: currentSession?.detail ?? null })
    await setSetting('last_known_session', currentSessionName)
    results.push(`session: ${message}`)
  }

  // --- 2. News window transition (existing) ---
  const activeEvent = await getActiveNewsEvent()
  const isNewsActiveNow = !!activeEvent
  const wasNewsActive = (await getSetting('last_known_news_active')) === 'true'

  if (isNewsActiveNow && !wasNewsActive) {
    const message = `News is live: ${activeEvent!.label}`
    await supabase.from('notifications').insert({ type: 'news_live', message, detail: activeEvent!.label })
    results.push(`news: ${message}`)
  }
  if (isNewsActiveNow !== wasNewsActive) {
    await setSetting('last_known_news_active', String(isNewsActiveNow))
  }

  // --- 3. STAGE ADD: upcoming session warning ---
  // Fires once per upcoming session, not every cycle -- tracks which
  // session it already warned about via last_warned_upcoming_session,
  // separate from last_known_session (which only updates once the
  // session actually BEGINS).
  const upcoming = getUpcomingSession(now, 10)
  if (upcoming) {
    const alreadyWarned = (await getSetting('last_warned_upcoming_session')) === upcoming.name
    if (!alreadyWarned) {
      const message = `${upcoming.name} session starting soon.`
      await supabase.from('notifications').insert({ type: 'session_upcoming', message, detail: upcoming.detail })
      await setSetting('last_warned_upcoming_session', upcoming.name)
      results.push(`upcoming: ${message}`)
    }
  }

  // --- 4. STAGE ADD: market open/closed transition ---
  const marketOpenNow = isMarketOpen(now)
  const marketStateKnown = (await getSetting('last_known_market_open')) !== null
  const wasMarketOpen = (await getSetting('last_known_market_open')) === 'true'

  if (marketStateKnown && marketOpenNow !== wasMarketOpen) {
    const message = marketOpenNow ? 'Markets are now open.' : 'Markets are now closed for the weekend.'
    await supabase.from('notifications').insert({ type: 'market_status', message, detail: null })
    results.push(`market: ${message}`)
  }
  await setSetting('last_known_market_open', String(marketOpenNow))

  // --- 5. STAGE ADD: daily/weekly high-low break ---
  // Only worth checking while markets are actually open -- avoids a
  // spurious "live price" read against a closed/stale market.
  if (marketOpenNow) {
    const breaks = await checkPriceLevelBreaks()
    for (const b of breaks) {
      const labelMap: Record<string, string> = {
        daily_high: "Yesterday's daily high",
        daily_low: "Yesterday's daily low",
        weekly_high: "Last week's high",
        weekly_low: "Last week's low",
      }
      const message = `${labelMap[b.type]} (${formatPrice(b.level)}) has been broken -- live price ${formatPrice(b.livePrice)}.`
      await supabase.from('notifications').insert({ type: 'price_level_break', message, detail: b.type })
      results.push(`price_level: ${message}`)
    }
  }

  return Response.json({ checked: true, transitions: results })
}