// app/api/check-transitions/route.ts
//
// Cron-triggered (suggest every 5 minutes, matching news-window
// granularity elsewhere in this project). Detects two kinds of real
// state TRANSITIONS -- not current state, which session/news pages
// already show live -- and writes a notification row the moment
// either one actually changes:
//   1. Session change: e.g. London ended, New York began.
//   2. News window going live: a high-impact event just entered its
//      active window.
// "Last known state" is tracked in app_settings (reused rather than a
// new table, since it's just two small scalar values) so a genuine
// transition can be detected by comparing against what was true last
// time this ran.

import { createClient } from '@supabase/supabase-js'
import { getActiveSession } from '@/lib/sessions'

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

// Same active-news-window check as news-window-status route -- kept
// as a direct inline query rather than an internal HTTP self-call
// (fragile in serverless contexts) since it's small and self-contained.
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

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  if (!CRON_SECRET || searchParams.get('secret') !== CRON_SECRET) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const results: string[] = []

  // --- Session transition ---
  const currentSession = getActiveSession()
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

  // --- News window transition ---
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

  return Response.json({ checked: true, transitions: results })
}