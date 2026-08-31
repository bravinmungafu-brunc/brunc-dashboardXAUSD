// app/api/analyse-signals/route.ts
//
// Cron-triggered (same pattern as check-open-signals) -- no button,
// meant to run continuously in the background picking up new signals.
//
// MODEL: inclusionai/ling-3.0-flash-fin:free -- verified directly on
// OpenRouter's own model page as genuinely free (not the originally
// planned Llama 4 Maverick, which is now $0.20/$0.696 per million
// tokens, paid only, confirmed the same day this was written). This
// one is finance-domain-tuned specifically for investment workflows,
// which is a better fit for this task anyway, not just a fallback.
// It's also brand new (released 4 days before this was written,
// single-provider via NovitaAI) -- worth knowing it doesn't have a
// long track record yet, even though current uptime numbers are solid.
//
// HONEST DESIGN CONSTRAINT: the Pine webhook payload does NOT include
// raw box-edge price numbers -- only qualitative state (bullish/
// bearish, rejection counts). That means the LLM has no independent
// structural reference beyond Pine's own already-chosen SL. So this
// route does NOT ask the model to invent a different SL price -- it
// can only judge validity and, if invalid, suggest a more
// conservative R:R rung from Pine's own allowed ladder, with TP
// recomputed from Pine's real SL distance at that ratio. Anything
// more (genuinely different structural levels) would need the Pine
// payload extended with real box-edge numbers first.

import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL as string,
  process.env.SUPABASE_SERVICE_KEY as string
)

const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY_ANALYSED_SIGNALS
const MODEL = 'inclusionai/ling-3.0-flash-fin:free'
const DAILY_LIMIT = 50 // unfunded account default -- raise to 1000 here if you do the $10 top-up
const KEY_NAME = 'analysed_signals'
const CRON_SECRET = process.env.CRON_SECRET
const MAX_SIGNALS_PER_RUN = 5 // keeps one run from burning the whole daily quota if many stack up

// STAGE ADD: dedicated third Twelve Data account, separate from
// Backtest's and Resolution's, so this never competes with either.
// Bounded naturally at <=50/day (OpenRouter's cap already limits total
// signals analyzed per day) -- trivial against an 800/day account.
// Cost per lookup treated conservatively as 1 credit; Twelve Data
// doesn't publish a confirmed lighter weight specifically for /price,
// so this errs toward undercounting risk rather than overclaiming a
// discount that isn't verified.
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

// Graceful degradation by design: returns null on ANY failure (missing
// key, quota exhausted, network error, bad response) rather than
// throwing. A missing live price should never block analysis --
// it's enrichment, not a hard dependency.
async function fetchLivePrice(): Promise<number | null> {
  if (!TD_KEY) return null
  try {
    const used = await getTdUsage()
    if (used >= TD_DAILY_LIMIT) return null
    const res = await fetch(`https://api.twelvedata.com/price?symbol=XAU/USD&apikey=${TD_KEY}`, {
      signal: AbortSignal.timeout(8000),
    })
    const data = await res.json()
    await incrementTdUsage(1)
    const price = data?.price != null ? parseFloat(data.price) : null
    return Number.isFinite(price) ? price : null
  } catch {
    return null
  }
}

async function getToggleEnabled(): Promise<boolean> {
  const { data } = await supabase
    .from('app_settings')
    .select('value')
    .eq('key', 'analysed_signals_enabled')
    .maybeSingle()
  if (!data) return true // default on if the settings row was never created
  return data.value === true || data.value === 'true'
}

function buildPrompt(sig: any, livePrice: number | null): string {
  const rrLevels = sig.signal_type === 'precision' ? PRECISION_RR_LEVELS : SNIPER_RR_LEVELS

  let movementNote = 'Live price unavailable for this check -- judge on the signal data alone.'
  if (livePrice != null && sig.entry != null) {
    const isBuy = sig.direction === 'buy' || sig.direction === 'long'
    const delta = livePrice - sig.entry
    const movedInFavor = isBuy ? delta > 0 : delta < 0
    const points = Math.abs(Math.round(delta / 0.01))
    movementNote = `Live price right now: ${livePrice} (entry was ${sig.entry}). Price has moved ${points}pts ${movedInFavor ? 'IN FAVOR of' : 'AGAINST'} this ${sig.direction} since it fired -- this is real movement Pine's own snapshot at fire-time couldn't have known about, and is worth weighing in your verdict, especially if it's already moved meaningfully against the direction.`
  }

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

Judge validity based on: does the grade and HTF confluence genuinely support this signal type firing, AND does the live price movement above still support this direction? For Precision, does the manual filter show real strength (most conditions true), or is this thin?

IMPORTANT CONSTRAINT on any alternate level you suggest: you do NOT have access to raw structural price data (box highs/lows) beyond what's given above -- Pine's own chosen SL (${sig.exits?.sl}) is the only genuinely real structural reference available to you. If you judge this signal invalid, do NOT invent a different SL price. Instead, only suggest a DIFFERENT R:R ratio from this exact allowed list: [${rrLevels.join(', ')}] -- pick a smaller (more conservative) ratio if the signal looks weak, keeping Pine's own SL and entry unchanged.

Respond with ONLY this JSON, no other text, no markdown fences:
{"verdict": "valid" or "invalid", "reasoning": "1-2 sentences, referencing specific grade/confluence/filter values above", "preferred_rr": <one number from the allowed list above, or null if valid>}`
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
  // Manual fence-stripping rather than relying on response_format --
  // not confirmed this specific model/provider supports OpenAI-style
  // structured output mode, and a strict prompt instruction plus
  // defensive parsing works across more models than assuming support
  // for a feature that might error out entirely if unsupported.
  const cleaned = rawText.replace(/```json|```/g, '').trim()
  return JSON.parse(cleaned)
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  if (!CRON_SECRET || searchParams.get('secret') !== CRON_SECRET) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }
  if (!OPENROUTER_KEY) {
    return Response.json({ error: 'OPENROUTER_API_KEY_ANALYSED_SIGNALS not set -- needs its own dedicated OpenRouter account, separate from the one planned for News Signals.' })
  }
  if (!process.env.SUPABASE_SERVICE_KEY) {
    return Response.json({ error: 'SUPABASE_SERVICE_KEY not set.' })
  }

  const enabled = await getToggleEnabled()
  if (!enabled) {
    return Response.json({ skipped: true, reason: 'toggled_off' })
  }

  const used = await getUsage()
  if (used >= DAILY_LIMIT) {
    return Response.json({ skipped: true, reason: 'quota_exhausted', used, limit: DAILY_LIMIT })
  }

  const { data: already } = await supabase.from('analysed_signals').select('signal_id')
  const analysedIds = new Set((already ?? []).map((a: any) => a.signal_id))

  const { data: recentSignals } = await supabase
    .from('signals')
    .select('*')
    .order('created_at', { ascending: true })
    .limit(200)

  const pending = (recentSignals ?? []).filter((s: any) => !analysedIds.has(s.signal_id)).slice(0, MAX_SIGNALS_PER_RUN)

  if (pending.length === 0) {
    return Response.json({ checked: 0, analysed: 0, used, limit: DAILY_LIMIT })
  }

  let analysedCount = 0
  let creditsUsedThisRun = 0
  const results: any[] = []

  for (const sig of pending) {
    if (used + creditsUsedThisRun >= DAILY_LIMIT) {
      results.push({ signal_id: sig.signal_id, outcome: 'quota_exceeded' })
      continue
    }

    try {
      const livePrice = await fetchLivePrice() // returns null on any failure -- never blocks analysis
      const parsed = await callOpenRouter(buildPrompt(sig, livePrice))
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
      })

      analysedCount++
      results.push({ signal_id: sig.signal_id, verdict })
    } catch (err: any) {
      results.push({ signal_id: sig.signal_id, outcome: 'error', detail: err?.message ?? String(err) })
    }
  }

  const finalUsed = await incrementUsage(creditsUsedThisRun)

  return Response.json({
    checked: pending.length,
    analysed: analysedCount,
    creditsUsedThisRun,
    results,
    used: finalUsed,
    limit: DAILY_LIMIT,
  })
}