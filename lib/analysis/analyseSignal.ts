// lib/analysis/analyseSignal.ts
//
// The core "analyse one signal" logic, extracted so BOTH the new
// immediate push-triggered route (analyse-signal-now) and the
// existing cron-based safety-net route (analyse-signals) call the
// exact same code -- no risk of the two drifting apart the way
// earlier duplicated files in this project did before being caught.

import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL as string,
  process.env.SUPABASE_SERVICE_KEY as string
)

// STAGE CHANGE: replaced OpenRouter entirely, after three straight
// days of confirmed zero successful analyses despite two real fixes
// (stopping wasted retries, switching to OpenRouter's own free-model
// router). Briefly tried Google Gemini's free tier (genuinely 1,500
// req/day, verified before switching) as the replacement, but moved
// to Groq instead given real prior experience that Gemini didn't
// work out reliably in practice. Landed on openai/gpt-oss-120b
// specifically -- one of Groq's dedicated "reasoning models", trained
// for structured multi-factor judgment, a better fit for this task's
// actual shape than a pure-speed small model. 1,000 requests/day on
// this model, over 20x real daily signal volume -- capacity is a
// non-issue. Groq's API is OpenAI SDK-compatible, same request/
// response shape as the original OpenRouter integration.
const GROQ_KEY = process.env.GROQ_API_KEY_ANALYSED_SIGNALS
const MODEL = 'openai/gpt-oss-120b'
export const DAILY_LIMIT = 1000
const KEY_NAME = 'analysed_signals'

const TD_KEY = process.env.TWELVEDATA_API_KEY_ANALYSED_SIGNALS
const TD_DAILY_LIMIT = 800
const TD_KEY_NAME = 'analysed_signals'

const SNIPER_RR_LEVELS = [3, 4, 5, 6, 7, 8, 9, 10]
const PRECISION_RR_LEVELS = [2, 3, 4]

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

async function getTdUsage(): Promise<number> {
  const { data } = await supabase
    .from('av_usage')
    .select('count')
    .eq('usage_date', todayUTC())
    .eq('key_name', TD_KEY_NAME)
    .maybeSingle()
  return data?.count ?? 0
}

async function incrementTdUsage(by: number): Promise<void> {
  const next = (await getTdUsage()) + by
  await supabase.from('av_usage').upsert({ usage_date: todayUTC(), key_name: TD_KEY_NAME, count: next })
}

interface PriceContext {
  currentPrice: number
  rangePts: number
  netMovePts: number
  netMoveDirection: 'up' | 'down' | 'flat'
  chopinessNote: string
}

async function fetchPriceContext(): Promise<PriceContext | null> {
  if (!TD_KEY) return null
  try {
    const used = await getTdUsage()
    if (used >= TD_DAILY_LIMIT) return null
    const url = `https://api.twelvedata.com/time_series?symbol=XAU/USD&interval=1min&outputsize=15&apikey=${TD_KEY}`
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) })
    const data = await res.json()
    await incrementTdUsage(1)
    if (data?.status === 'error' || !Array.isArray(data?.values) || data.values.length === 0) return null

    const bars = data.values
      .map((v: any) => ({ time: v.datetime, high: parseFloat(v.high), low: parseFloat(v.low), close: parseFloat(v.close) }))
      .sort((a: any, b: any) => new Date(a.time).getTime() - new Date(b.time).getTime())

    const currentPrice = bars[bars.length - 1].close
    const oldestClose = bars[0].close
    const maxHigh = Math.max(...bars.map((b: any) => b.high))
    const minLow = Math.min(...bars.map((b: any) => b.low))

    const rangePts = Math.round((maxHigh - minLow) / 0.01)
    const netMove = currentPrice - oldestClose
    const netMovePts = Math.round(Math.abs(netMove) / 0.01)
    const netMoveDirection: 'up' | 'down' | 'flat' = netMove > 0 ? 'up' : netMove < 0 ? 'down' : 'flat'
    const efficiency = rangePts > 0 ? netMovePts / rangePts : 0
    const chopinessNote = efficiency > 0.7
      ? 'a clean, directional trend'
      : efficiency < 0.35
        ? 'choppy/ranging conditions'
        : 'moderately directional conditions'

    return { currentPrice, rangePts, netMovePts, netMoveDirection, chopinessNote }
  } catch {
    return null
  }
}

async function getUpcomingHighImpactEvent(hoursAhead: number = 2): Promise<string | null> {
  const now = new Date()
  const cutoff = new Date(now.getTime() + hoursAhead * 3600000)
  const { data } = await supabase
    .from('calendar_events')
    .select('event_time, currency, event_name, impact')
    .gte('event_time', now.toISOString())
    .lte('event_time', cutoff.toISOString())
    .order('event_time', { ascending: true })
    .limit(1)
  if (!data || data.length === 0) return null
  const e = data[0] as any
  return `${e.currency ?? ''} ${e.event_name ?? 'economic event'} (impact: ${e.impact ?? 'unknown'}) at ${e.event_time}`
}

export async function getToggleEnabled(): Promise<boolean> {
  const { data } = await supabase
    .from('app_settings')
    .select('value')
    .eq('key', 'analysed_signals_enabled')
    .maybeSingle()
  if (!data) return true
  return data.value === true || data.value === 'true'
}

function buildPrompt(sig: any, priceCtx: PriceContext | null, upcomingEvent: string | null): string {
  const rrLevels = sig.signal_type === 'precision' ? PRECISION_RR_LEVELS : SNIPER_RR_LEVELS

  let movementNote = 'Live price unavailable for this check -- judge on the signal data alone.'
  if (priceCtx != null && sig.entry != null) {
    const isBuy = sig.direction === 'buy' || sig.direction === 'long'
    const delta = priceCtx.currentPrice - sig.entry
    const movedInFavor = isBuy ? delta > 0 : delta < 0
    const points = Math.abs(Math.round(delta / 0.01))
    movementNote = `Live price right now: ${priceCtx.currentPrice} (entry was ${sig.entry}). Price has moved ${points}pts ${movedInFavor ? 'IN FAVOR of' : 'AGAINST'} this ${sig.direction} since it fired -- real movement Pine's own snapshot couldn't have known about. Recent market conditions (last ~15min): ${priceCtx.chopinessNote}, net ${priceCtx.netMoveDirection} move of ${priceCtx.netMovePts}pts within a ${priceCtx.rangePts}pt range. Choppy conditions mean any given SL is more likely to get clipped by noise even if the overall direction is right.`
  }

  const calendarNote = upcomingEvent
    ? `IMPORTANT: a high-impact economic event is scheduled soon -- ${upcomingEvent}. Weight this heavily: a signal firing close to major news carries real added risk regardless of how strong its grade/confluence looks, since price can move violently and unpredictably around the release.`
    : 'No high-impact economic event scheduled in the next 2 hours, per today\'s cached calendar.'

  return `You are reviewing a trading signal from BRUNC's own XAUUSD strategy. Judge whether THIS signal genuinely satisfies the strategy's own rules -- do not apply a different technical analysis framework.

Signal:
- Type: ${sig.signal_type}${sig.path ? ' (' + sig.path + ')' : ''}
- Direction: ${sig.direction}
- Entry: ${sig.entry}
- Grade: ${sig.grade?.value}/${sig.grade?.of} timeframes in agreement
- Pine's own chosen exit: SL ${sig.exits?.sl}, TP ${sig.exits?.tp}, R:R 1:${sig.risk?.tp_rr ?? sig.exits?.rr_selected}
- HTF confluence: ${JSON.stringify(sig.htf_confluence ?? [])}
- Manual entry filter (Precision only): ${JSON.stringify(sig.manual_entry_filter ?? {})}

${movementNote}

${calendarNote}

Judge validity based on: does the grade and HTF confluence genuinely support this signal type firing, does the live price movement above still support this direction, and is there imminent news risk? For Precision, does the manual filter show real strength (most conditions true), or is this thin?

IMPORTANT CONSTRAINT on any alternate level you suggest: you do NOT have access to raw structural price data (box highs/lows) beyond what's given above -- Pine's own chosen SL (${sig.exits?.sl}) is the only genuinely real structural reference available to you. If you judge this signal invalid, do NOT invent a different SL price. Instead, only suggest a DIFFERENT R:R ratio from this exact allowed list: [${rrLevels.join(', ')}] -- pick a smaller (more conservative) ratio if the signal looks weak, keeping Pine's own SL and entry unchanged.

Respond with ONLY this JSON, no other text, no markdown fences:
{"verdict": "valid" or "invalid", "reasoning": "1-2 sentences, referencing specific grade/confluence/filter values above", "preferred_rr": <one number from the allowed list above, or null if valid>}`
}

async function callGroq(prompt: string): Promise<any> {
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${GROQ_KEY}`,
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
    throw new Error(data.error?.message || `Groq HTTP ${res.status}`)
  }
  const rawText = data?.choices?.[0]?.message?.content || ''
  const cleaned = rawText.replace(/```json|```/g, '').trim()
  return JSON.parse(cleaned)
}

export interface AnalyseResult {
  signal_id: string
  outcome: 'analysed' | 'error' | 'quota_exceeded' | 'stopped_early' | 'already_analysed' | 'toggled_off' | 'missing_config'
  verdict?: 'valid' | 'invalid'
  detail?: string
}

// The core unit: analyses exactly ONE signal end-to-end -- duplicate
// check, quota check, LLM call, insert. Self-contained and safe to
// call from either the immediate single-signal path or a batch loop;
// each call correctly checks/updates quota itself rather than relying
// on a caller to aggregate.
export async function analyseOneSignal(sig: any): Promise<AnalyseResult> {
  if (!GROQ_KEY || !process.env.SUPABASE_SERVICE_KEY) {
    return { signal_id: sig.signal_id, outcome: 'missing_config', detail: 'GROQ_API_KEY_ANALYSED_SIGNALS or SUPABASE_SERVICE_KEY not set.' }
  }

  const enabled = await getToggleEnabled()
  if (!enabled) return { signal_id: sig.signal_id, outcome: 'toggled_off' }

  // Duplicate protection -- matters most for the immediate-trigger
  // path, in case it and the cron safety net ever race on the same
  // signal.
  const { data: existing } = await supabase.from('analysed_signals').select('id').eq('signal_id', sig.signal_id).maybeSingle()
  if (existing) return { signal_id: sig.signal_id, outcome: 'already_analysed' }

  const used = await getUsage()
  if (used >= DAILY_LIMIT) return { signal_id: sig.signal_id, outcome: 'quota_exceeded' }

  try {
    const priceCtx = await fetchPriceContext()
    const upcomingEvent = await getUpcomingHighImpactEvent(2)
    const parsed = await callGroq(buildPrompt(sig, priceCtx, upcomingEvent))
    await incrementUsage(1)

    const verdict: 'valid' | 'invalid' = parsed.verdict === 'invalid' ? 'invalid' : 'valid'
    let llmTp = sig.exits?.tp ?? null
    let llmRr = sig.risk?.tp_rr ?? sig.exits?.rr_selected ?? null

    if (verdict === 'invalid' && parsed.preferred_rr != null) {
      const rr = Number(parsed.preferred_rr)
      const isBuy = sig.direction === 'buy' || sig.direction === 'long'
      const slDist = Math.abs((sig.entry ?? 0) - (sig.exits?.sl ?? sig.entry ?? 0))
      llmTp = isBuy ? sig.entry + slDist * rr : sig.entry - slDist * rr
      llmRr = rr
    }

    await supabase.from('analysed_signals').insert({
      signal_id: sig.signal_id,
      llm_model: MODEL,
      verdict,
      llm_entry: sig.entry,
      llm_sl: sig.exits?.sl ?? null,
      llm_tp: llmTp,
      llm_rr: llmRr,
      reasoning: parsed.reasoning ?? '',
      status: 'open',
      direction: sig.direction ?? null,
    })

    return { signal_id: sig.signal_id, outcome: 'analysed', verdict }
  } catch (err: any) {
    const msg = err?.message ?? String(err)
    if (/rate limit/i.test(msg) || /resource_exhausted/i.test(msg) || /quota/i.test(msg)) {
      await supabase.from('openrouter_usage').upsert({ usage_date: todayUTC(), key_name: KEY_NAME, count: DAILY_LIMIT })
      return { signal_id: sig.signal_id, outcome: 'stopped_early', detail: msg }
    }
    return { signal_id: sig.signal_id, outcome: 'error', detail: msg }
  }
}