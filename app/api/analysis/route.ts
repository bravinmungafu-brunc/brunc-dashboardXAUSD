import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL as string,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY as string
)

const AV_KEY = process.env.ALPHAVANTAGE_API_KEY
const DAILY_LIMIT = 25

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
  if (!AV_KEY || AV_KEY.includes('paste_your')) {
    return { price: null, usedNow: used }
  }
  try {
    const url = `https://www.alphavantage.co/query?function=GOLD_SILVER_SPOT&symbol=XAU&apikey=${AV_KEY}`
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

function extractJsonArray(text: string): any[] | null {
  const cleaned = text.replace(/```json|```/g, '').trim()
  try {
    return JSON.parse(cleaned)
  } catch {
    const start = cleaned.indexOf('[')
    const end = cleaned.lastIndexOf(']')
    if (start !== -1 && end !== -1 && end > start) {
      try {
        return JSON.parse(cleaned.slice(start, end + 1))
      } catch {
        return null
      }
    }
    return null
  }
}

export async function GET() {
  const geminiKey = process.env.GEMINI_API_KEY
  if (!geminiKey || geminiKey.includes('paste_your')) {
    return Response.json({ error: 'Gemini API key not set yet in .env.local' })
  }

  const { data: openSignals } = await supabase
    .from('signals')
    .select('signal_id,symbol,direction,signal_type,path,grade,exits,entry,created_at')
    .eq('status', 'open')
    .order('created_at', { ascending: false })
    .limit(20)

  if (!openSignals || openSignals.length === 0) {
    return Response.json({ error: 'No open signals right now to analyze.' })
  }

  const { price: spot, usedNow } = await fetchSpotPrice()
  const spotNote = spot == null
    ? (usedNow >= DAILY_LIMIT
        ? 'unavailable — daily Alpha Vantage quota reached, assess on news and structural levels only'
        : 'unavailable — assess on structural levels alone')
    : String(spot)

  const signalsSummary = openSignals.map(s =>
    `- signal_id: ${s.signal_id} | ${s.direction?.toUpperCase()} ${s.symbol} | type: ${s.signal_type}${s.path ? ' (' + s.path + ')' : ''} | grade: ${s.grade?.value}/${s.grade?.of} | entry: ${s.entry} | SL: ${s.exits?.sl} | TP1: ${s.exits?.tp1} | TP2: ${s.exits?.tp2} | TP3: ${s.exits?.tp3} | opened: ${s.created_at}`
  ).join('\n')

  const prompt = `You are a market-context assistant for a gold (XAUUSD) trading desk. Below are currently open trade signals — entry/SL/TP are already fixed by the trading system and must never be changed, restated as different values, or treated as something you can override.

Current live XAUUSD spot price: ${spotNote}.

Open signals:
${signalsSummary}

Step 1: Use search to check whether a high-impact economic release (CPI, NFP, FOMC, PPI, major central bank speech) is scheduled within roughly the next 60 minutes, or was just released within the last 60 minutes.

Step 2:
- If such an event is imminent or just happened, weight your assessment primarily on that news and its likely market reaction on gold.
- If no such event is imminent (or it simply isn't a day/time real economic news is scheduled), weight your assessment primarily on how the current live spot price sits relative to each signal's entry, SL, and TP levels — a pure price-structure read, not news.
- If the live spot price is unavailable, rely on search-grounded news plus each signal's own structural levels only.

Return ONLY a JSON array, no markdown fences, no extra text before or after, in exactly this shape:

[
  {
    "signal_id": "the exact signal_id from above",
    "validity": "valid" | "caution" | "invalid",
    "reasoning": "1-2 sentences on why, referencing the specific news or price-structure factor used",
    "recommendation": "one short actionable note — advisory only, never a new price"
  }
]

Rules:
- "valid" means current conditions support the signal's direction.
- "invalid" means current conditions actively contradict the signal's direction.
- "caution" means mixed/unclear conditions or an imminent high-impact event adding risk either way.
- Never suggest a new entry, stop loss, or take-profit price.
- One object per signal_id above, same order, no omissions.
- Output valid JSON only — no prose, no citations, no markdown, before or after the array.`

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent?key=${geminiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          tools: [{ google_search: {} }],
          generationConfig: {
            temperature: 0.2,
            maxOutputTokens: 2048,
          },
        })
      }
    )
    const data = await res.json()

    if (!res.ok || data.error) {
      return Response.json({
        error: `Gemini API error: ${data.error?.message || res.statusText}`,
        raw: data,
        used: usedNow,
        limit: DAILY_LIMIT,
      })
    }

    const finishReason = data?.candidates?.[0]?.finishReason
    if (finishReason && finishReason !== 'STOP') {
      return Response.json({
        error: `Gemini stopped without completing (reason: ${finishReason}).`,
        raw: data,
        used: usedNow,
        limit: DAILY_LIMIT,
      })
    }

    const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text || ''
    const assessments = extractJsonArray(rawText)

    if (!assessments) {
      return Response.json({ error: 'Gemini did not return valid JSON this run — try again.', raw: rawText || data, used: usedNow, limit: DAILY_LIMIT })
    }

    return Response.json({ assessments, spot, used: usedNow, limit: DAILY_LIMIT })
  } catch (e) {
    return Response.json({ error: 'Gemini request failed.', used: usedNow, limit: DAILY_LIMIT })
  }
}