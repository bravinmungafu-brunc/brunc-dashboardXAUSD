import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL as string,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY as string
)

const TD_KEY = process.env.TWELVEDATA_API_KEY
const FINNHUB_KEY = process.env.FINNHUB_API_KEY
const GROQ_KEY = process.env.GROQ_API_KEY

// Twelve Data Basic (free) plan limit, confirmed live at 800 credits/day.
// Shared with resolve-signals via the same av_usage table/counter -- both
// routes draw from one real daily total, same pattern used with Alpha
// Vantage before. (Twelve Data also caps at 8 requests/minute, but that's
// not tracked here -- low risk for this app's click-driven usage pattern.)
const DAILY_LIMIT = 800

function todayUTC() {
  return new Date().toISOString().slice(0, 10)
}

async function getUsage(): Promise<number> {
  const { data } = await supabase.from('av_usage').select('count').eq('usage_date', todayUTC()).maybeSingle()
  return data?.count ?? 0
}

async function incrementUsage(): Promise<number> {
  const next = (await getUsage()) + 1
  await supabase.from('av_usage').upsert({ usage_date: todayUTC(), count: next })
  return next
}

async function fetchSpotPrice(): Promise<{ price: number | null; usedNow: number }> {
  const used = await getUsage()
  if (used >= DAILY_LIMIT) {
    return { price: null, usedNow: used }
  }
  if (!TD_KEY || TD_KEY.includes('paste_your')) {
    return { price: null, usedNow: used }
  }
  try {
    const url = `https://api.twelvedata.com/price?symbol=XAU/USD&apikey=${TD_KEY}`
    const res = await fetch(url)
    const data = await res.json()
    const price = data?.price != null ? parseFloat(data.price) : null
    const usedNow = await incrementUsage()
    return { price, usedNow }
  } catch {
    const usedNow = await incrementUsage()
    return { price: null, usedNow }
  }
}

// Finnhub's free Market News endpoint, not the paid Economic Calendar --
// this gives recent forex-relevant headlines rather than a precise "CPI
// in 40 minutes" flag, the closest free approximation of what the news
// step used to do. Failure here is non-fatal -- the prompt just notes
// news is unavailable and Groq reasons on price structure alone.
async function fetchNews(): Promise<{ text: string; ok: boolean }> {
  if (!FINNHUB_KEY || FINNHUB_KEY.includes('paste_your')) {
    return { text: '', ok: false }
  }
  try {
    const res = await fetch(`https://finnhub.io/api/v1/news?category=forex&token=${FINNHUB_KEY}`)
    const data = await res.json()
    if (!Array.isArray(data) || data.length === 0) {
      return { text: '', ok: false }
    }
    const top = data.slice(0, 5)
    const text = top.map((a: any) => {
      const when = a.datetime ? new Date(a.datetime * 1000).toISOString() : 'unknown time'
      return `- [${when}] ${a.headline}${a.summary ? ' — ' + a.summary : ''}`
    }).join('\n')
    return { text, ok: true }
  } catch {
    return { text: '', ok: false }
  }
}

export async function GET() {
  if (!GROQ_KEY || GROQ_KEY.includes('paste_your')) {
    return Response.json({ error: 'Groq API key not set yet in .env.local (GROQ_API_KEY)' })
  }

  // Two-step check so the person gets an accurate message: "nothing open
  // at all" reads very differently from "everything open has already
  // been reviewed" -- both are zero-results but mean different things.
  const { count: openCount } = await supabase
    .from('signals')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'open')

  if (!openCount || openCount === 0) {
    return Response.json({ error: 'No open signals right now to analyze.' })
  }

  // Only signals never AI-reviewed before -- ai_reviewed_at is stamped
  // after a successful run below, so repeat clicks only ever pick up
  // genuinely new signals, never re-review the same one twice.
  const { data: openSignals } = await supabase
    .from('signals')
    .select('id,signal_id,symbol,direction,signal_type,path,grade,exits,entry,created_at')
    .eq('status', 'open')
    .is('ai_reviewed_at', null)
    .order('created_at', { ascending: false })
    .limit(5)

  if (!openSignals || openSignals.length === 0) {
    return Response.json({ error: 'No new signals to analyze — all open signals have already been reviewed.' })
  }

  // Price and news are independent lookups -- run them in parallel
  // rather than sequentially so a real-world run stays as fast as this
  // architecture allows.
  const [{ price: spot, usedNow }, { text: newsText, ok: newsOk }] = await Promise.all([
    fetchSpotPrice(),
    fetchNews(),
  ])

  const spotNote = spot == null
    ? (usedNow >= DAILY_LIMIT
        ? 'unavailable — daily Twelve Data quota reached, assess on news and structural levels only'
        : 'unavailable — assess on structural levels alone')
    : String(spot)

  const newsNote = newsOk
    ? newsText
    : 'unavailable — no live news feed this run, assess on price structure alone'

  const signalsSummary = openSignals.map(s =>
    `- signal_id: ${s.signal_id} | ${s.direction?.toUpperCase()} ${s.symbol} | type: ${s.signal_type}${s.path ? ' (' + s.path + ')' : ''} | grade: ${s.grade?.value}/${s.grade?.of} | entry: ${s.entry} | SL: ${s.exits?.sl} | TP1: ${s.exits?.tp1} | TP2: ${s.exits?.tp2} | TP3: ${s.exits?.tp3} | opened: ${s.created_at}`
  ).join('\n')

  const prompt = `You are a market-context assistant for a gold (XAUUSD) trading desk. Below are currently open trade signals — entry/SL/TP are already fixed by the trading system and must never be changed, restated as different values, or treated as something you can override.

Current live XAUUSD spot price: ${spotNote}.

Recent relevant news headlines:
${newsNote}

Open signals:
${signalsSummary}

Step 1: Check whether any of the news headlines above indicate a high-impact economic event (CPI, NFP, FOMC, PPI, major central bank speech) that just happened or is clearly imminent.

Step 2:
- If such an event is indicated, weight your assessment primarily on that news and its likely market reaction on gold.
- If no such event is indicated (or news is unavailable), weight your assessment primarily on how the current live spot price sits relative to each signal's entry, SL, and TP levels — a pure price-structure read.

Respond with ONLY a JSON object in exactly this shape, no other text:

{
  "assessments": [
    {
      "signal_id": "the exact signal_id from above",
      "validity": "valid" | "caution" | "invalid",
      "reasoning": "1-2 sentences on why, referencing the specific news or price-structure factor used",
      "recommendation": "one short actionable note — advisory only, never a new price"
    }
  ]
}

Rules:
- "valid" means current conditions support the signal's direction.
- "invalid" means current conditions actively contradict the signal's direction.
- "caution" means mixed/unclear conditions or an imminent high-impact event adding risk either way.
- Never suggest a new entry, stop loss, or take-profit price.
- One object per signal_id above, same order, no omissions.`

  try {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${GROQ_KEY}`,
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.2,
        max_tokens: 1024,
        response_format: { type: 'json_object' },
      })
    })
    const data = await res.json()

    if (!res.ok || data.error) {
      return Response.json({
        error: `Groq API error: ${data.error?.message || res.statusText}`,
        raw: data,
        used: usedNow,
        limit: DAILY_LIMIT,
      })
    }

    const rawText = data?.choices?.[0]?.message?.content || ''

    let parsed: any = null
    try {
      parsed = JSON.parse(rawText)
    } catch {
      return Response.json({ error: 'Groq did not return valid JSON this run — try again.', raw: rawText, used: usedNow, limit: DAILY_LIMIT })
    }

    const assessments = parsed?.assessments
    if (!Array.isArray(assessments)) {
      return Response.json({ error: 'Groq response was missing the assessments array.', raw: parsed, used: usedNow, limit: DAILY_LIMIT })
    }

    // Stamp only after a genuinely successful analysis -- if Groq or
    // parsing failed above, these signals stay unreviewed and are
    // retried on the next click instead of being silently skipped.
    const reviewedIds = openSignals.map(s => s.id)
    await supabase.from('signals').update({ ai_reviewed_at: new Date().toISOString() }).in('id', reviewedIds)

    return Response.json({ assessments, spot, used: usedNow, limit: DAILY_LIMIT })
  } catch (e) {
    return Response.json({ error: 'Groq request failed.', used: usedNow, limit: DAILY_LIMIT })
  }
}