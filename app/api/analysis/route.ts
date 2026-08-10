import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL as string,
  process.env.SUPABASE_SERVICE_KEY as string
)

export async function GET() {
  const geminiKey = process.env.GEMINI_API_KEY
  if (!geminiKey || geminiKey.includes('paste_your')) {
    return Response.json({ error: 'Gemini API key not set yet in .env.local' })
  }

  const { data: openSignals } = await supabase
    .from('signals')
    .select('signal_id,symbol,direction,signal_type,grade,exits,entry,created_at')
    .eq('status', 'open')
    .order('created_at', { ascending: false })
    .limit(20)

  if (!openSignals || openSignals.length === 0) {
    return Response.json({ error: 'No open signals right now to analyze.' })
  }

  const signalsSummary = openSignals.map(s =>
    `- signal_id: ${s.signal_id} | ${s.direction?.toUpperCase()} ${s.symbol} | type: ${s.signal_type} | grade: ${s.grade?.value}/${s.grade?.of} | entry: ${s.entry} | SL: ${s.exits?.sl} | TP1: ${s.exits?.tp1} | TP2: ${s.exits?.tp2} | TP3: ${s.exits?.tp3} | opened: ${s.created_at}`
  ).join('\n')

  const prompt = `You are a market-context assistant for a gold (XAUUSD) trading desk. Below are currently open trade signals — entry/SL/TP are already fixed by the trading system and must never be changed, restated as different values, or treated as something you can override.

Open signals:
${signalsSummary}

Using current, real news (economic calendar events, Fed/central bank commentary, DXY moves, geopolitical developments), assess each signal and return ONLY a JSON array, no markdown fences, no extra text before or after, in exactly this shape:

[
  {
    "signal_id": "the exact signal_id from above",
    "validity": "valid" | "caution" | "invalid",
    "reasoning": "1-2 sentences on why, referencing the specific news or macro factor",
    "recommendation": "one short actionable note — advisory only, never a new price"
  }
]

Rules:
- "valid" means current news/macro conditions support the signal's direction.
- "invalid" means current news/macro conditions actively contradict the signal's direction (e.g. a sell signal during a strong bullish gold catalyst).
- "caution" means mixed or unclear conditions, or an imminent high-impact event that adds risk either way.
- Never suggest a new entry, stop loss, or take-profit price.
- One object per signal_id above, same order, no omissions.`

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${geminiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          tools: [{ google_search: {} }],
        })
      }
    )
    const data = await res.json()
    const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text || ''
    const cleaned = rawText.replace(/```json|```/g, '').trim()

    let assessments: any[] = []
    try {
      assessments = JSON.parse(cleaned)
    } catch {
      return Response.json({ error: 'Gemini did not return valid JSON this run — try again.', raw: rawText })
    }

    return Response.json({ assessments })
  } catch (e) {
    return Response.json({ error: 'Gemini request failed.' })
  }
}