// app/api/process-news-signals/route.ts
//
// Cron-triggered, e.g. every 5 minutes (tighter than the other 10-min
// jobs, since news windows are narrow and freshness matters more
// here). Does essentially nothing, at zero cost, outside an active
// news window -- the first check below is a pure Supabase read
// against the already-cached calendar, no external API call, so
// running this frequently is cheap even when it finds nothing to do.
//
// MODEL: separate OpenRouter account (OPENROUTER_API_KEY_NEWS_SIGNALS)
// from Analysed Signals' key -- genuinely different feature (different
// trigger, different inputs, different prompt weighting), same
// legitimate-separate-purpose reasoning as the other multi-account
// splits in this project.
//
// PROMPT DESIGN: news content is weighted PRIMARY, technical structure
// secondary -- confirmed design decision, different from Analysed
// Signals where it's the reverse. Same honest SL-anchoring constraint
// as Analysed Signals still applies though: no raw structural price
// data in the payload, so Pine's own SL stays the reference; only the
// R:R rung (hence TP) can differ when the model prefers a more
// conservative target.

import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL as string,
  process.env.SUPABASE_SERVICE_KEY as string
)

const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY_NEWS_SIGNALS
const MODEL = 'inclusionai/ling-3.0-flash-fin:free'
const DAILY_LIMIT = 50
const KEY_NAME = 'news_signals'
const CRON_SECRET = process.env.CRON_SECRET
const FINNHUB_KEY = process.env.FINNHUB_API_KEY
const MAX_SIGNALS_PER_RUN = 5

const SNIPER_RR_LEVELS = [3, 4, 5, 6, 7, 8, 9, 10]
const PRECISION_RR_LEVELS = [2, 3, 4]

// Same active-window definition as news-window-status -- kept as a
// literal copy rather than a shared import, since Next.js API routes
// don't share module state across requests reliably; duplicating this
// small constant pair is simpler and safer than a cross-route import.
const PRE_MINUTES = 15
const POST_MINUTES = 30

function todayUTC() {
  return new Date().toISOString().slice(0, 10)
}

async function getUsage(): Promise<number> {
  const { data } = await supabase
    .from('openrouter_usage')
    .select('count')
    .eq('usage_date', todayUTC())
    .eq('key_name', KEY_NAME)
    .maybeSingle()
  return data?.count ?? 0
}

async function incrementUsage(by: number): Promise<number> {
  const next = (await getUsage()) + by
  await supabase.from('openrouter_usage').upsert({ usage_date: todayUTC(), key_name: KEY_NAME, count: next })
  return next
}

async function getActiveNewsEvent(): Promise<{ label: string; time: string } | null> {
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
  if (highImpact.length === 0) return null
  const e = highImpact[0] as any
  return { label: `${e.currency ?? ''} ${e.event_name ?? 'economic event'} (${e.impact ?? 'high'} impact)`, time: e.event_time }
}

// Reuses the exact same proven pattern already live in this project's
// own /api/analysis route -- not re-verified fresh here, since it's
// already working code from this same codebase.
async function fetchNews(): Promise<{ text: string; ok: boolean }> {
  if (!FINNHUB_KEY) return { text: '', ok: false }
  try {
    const res = await fetch(`https://finnhub.io/api/v1/news?category=forex&token=${FINNHUB_KEY}`)
    const data = await res.json()
    if (!Array.isArray(data) || data.length === 0) return { text: '', ok: false }
    const top = data.slice(0, 5)
    const text = top.map((a: any) => {
      const when = a.datetime ? new Date(a.datetime * 1000).toISOString() : 'unknown time'
      return `- [${when}] ${a.headline}${a.summary ? ' -- ' + a.summary : ''}`
    }).join('\n')
    return { text, ok: true }
  } catch {
    return { text: '', ok: false }
  }
}

function buildPrompt(sig: any, eventLabel: string, newsText: string): string {
  const rrLevels = sig.signal_type === 'precision' ? PRECISION_RR_LEVELS : SNIPER_RR_LEVELS

  return `A high-impact economic event is active right now: ${eventLabel}. This is happening DURING or immediately around this signal firing.

Recent relevant news headlines:
${newsText || 'No headlines available this check -- weight the event itself heavily regardless.'}

Trading signal from BRUNC's own XAUUSD strategy, fired during this news window:
- Direction: ${sig.direction}
- Entry: ${sig.entry}
- Pine's own chosen exit: SL ${sig.exits?.sl}, TP ${sig.exits?.tp}, R:R 1:${sig.risk?.tp_rr ?? sig.exits?.rr_selected}
- Grade: ${sig.grade?.value}/${sig.grade?.of} timeframes in agreement

WEIGHT THE NEWS AND EVENT ABOVE AS PRIMARY -- this is different from a normal technical check. Ask first: does the news/event content support or contradict this ${sig.direction} direction? Only use the grade/technical data as secondary, confirming context, not the main basis for your verdict.

IMPORTANT CONSTRAINT: you do not have raw structural price data beyond what's given -- Pine's own SL (${sig.exits?.sl}) is the only genuine structural reference available. If invalid, do NOT invent a different SL. Only suggest a different R:R ratio from this list: [${rrLevels.join(', ')}], more conservative if the news creates real uncertainty.

Respond with ONLY this JSON, no other text:
{"verdict": "valid" or "invalid", "reasoning": "1-2 sentences, referencing the specific news/event and how it relates to this direction", "preferred_rr": <one number from the list, or null if valid>}`
}

async function callOpenRouter(prompt: string): Promise<any> {
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${OPENROUTER_KEY}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.2,
      max_tokens: 400,
    }),
    signal: AbortSignal.timeout(15000),
  })
  const data = await res.json()
  if (!res.ok || data.error) {
    throw new Error(data.error?.message || `OpenRouter HTTP ${res.status}`)
  }
  const rawText = data?.choices?.[0]?.message?.content || ''
  const cleaned = rawText.replace(/```json|```/g, '').trim()
  return JSON.parse(cleaned)
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  if (!CRON_SECRET || searchParams.get('secret') !== CRON_SECRET) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Zero-cost check first -- pure Supabase read, no external call.
  const activeEvent = await getActiveNewsEvent()
  if (!activeEvent) {
    return Response.json({ skipped: true, reason: 'no_active_news_window' })
  }

  if (!OPENROUTER_KEY) {
    return Response.json({ error: 'OPENROUTER_API_KEY_NEWS_SIGNALS not set.' })
  }
  if (!process.env.SUPABASE_SERVICE_KEY) {
    return Response.json({ error: 'SUPABASE_SERVICE_KEY not set.' })
  }

  const used = await getUsage()
  if (used >= DAILY_LIMIT) {
    return Response.json({ skipped: true, reason: 'quota_exhausted', activeEvent, used, limit: DAILY_LIMIT })
  }

  const { data: already } = await supabase.from('news_signals').select('signal_id')
  const processedIds = new Set((already ?? []).map((a: any) => a.signal_id))

  // Only signals recent enough to still be "during" this window --
  // an old signal from hours ago isn't a genuine news-window signal
  // just because a new event happens to be active now.
  const lookback = new Date(Date.now() - POST_MINUTES * 60000).toISOString()
  const { data: recentSignals } = await supabase
    .from('signals')
    .select('*')
    .gte('created_at', lookback)
    .order('created_at', { ascending: true })
    .limit(50)

  const pending = (recentSignals ?? []).filter((s: any) => !processedIds.has(s.signal_id)).slice(0, MAX_SIGNALS_PER_RUN)

  if (pending.length === 0) {
    return Response.json({ activeEvent, checked: 0, processed: 0, used, limit: DAILY_LIMIT })
  }

  const { text: newsText } = await fetchNews() // Finnhub, 60/min limit, not the bottleneck here

  let processedCount = 0
  let creditsUsedThisRun = 0
  const results: any[] = []

  for (const sig of pending) {
    if (used + creditsUsedThisRun >= DAILY_LIMIT) {
      results.push({ signal_id: sig.signal_id, outcome: 'quota_exceeded' })
      continue
    }

    try {
      const parsed = await callOpenRouter(buildPrompt(sig, activeEvent.label, newsText))
      creditsUsedThisRun++

      const verdict = parsed.verdict === 'invalid' ? 'invalid' : 'valid'
      let llmTp = sig.exits?.tp ?? null
      let llmRr = sig.risk?.tp_rr ?? sig.exits?.rr_selected ?? null

      if (verdict === 'invalid' && parsed.preferred_rr != null) {
        const rr = Number(parsed.preferred_rr)
        const isBuy = sig.direction === 'buy' || sig.direction === 'long'
        const slDist = Math.abs((sig.entry ?? 0) - (sig.exits?.sl ?? sig.entry ?? 0))
        llmTp = isBuy ? sig.entry + slDist * rr : sig.entry - slDist * rr
        llmRr = rr
      }

      await supabase.from('news_signals').insert({
        signal_id: sig.signal_id,
        direction: sig.direction ?? null,
        triggering_event: activeEvent.label,
        news_summary: newsText ? newsText.split('\n')[0] : null,
        llm_model: MODEL,
        verdict,
        llm_entry: sig.entry,
        llm_sl: sig.exits?.sl ?? null,
        llm_tp: llmTp,
        llm_rr: llmRr,
        reasoning: parsed.reasoning ?? '',
        status: 'open',
      })

      processedCount++
      results.push({ signal_id: sig.signal_id, verdict })
    } catch (err: any) {
      results.push({ signal_id: sig.signal_id, outcome: 'error', detail: err?.message ?? String(err) })
    }
  }

  const finalUsed = await incrementUsage(creditsUsedThisRun)

  return Response.json({
    activeEvent,
    checked: pending.length,
    processed: processedCount,
    creditsUsedThisRun,
    results,
    used: finalUsed,
    limit: DAILY_LIMIT,
  })
}