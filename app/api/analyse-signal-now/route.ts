// app/api/analyse-signal-now/route.ts
//
// Triggered directly by main.py the instant a webhook signal is
// saved to Supabase -- NOT waiting for the next 10-minute cron
// cycle. This is now the PRIMARY path to analysis. The cron-based
// analyse-signals route stays in place unchanged as a safety net --
// if this immediate call fails for any reason (network hiccup,
// timeout, OpenRouter down), the cron still picks up any signal
// that never made it into analysed_signals, just later.
//
// HONEST LATENCY NOTE: "immediate" means real LLM inference time
// (typically low single digits up to ~15-20s depending on current
// model load) plus one network hop from main.py -- not a guaranteed
// sub-second response. Reliably well under the previous worst case
// of up to ~10 minutes, though.

import { createClient } from '@supabase/supabase-js'
import { analyseOneSignal } from '@/lib/analysis/analyseSignal'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL as string,
  process.env.SUPABASE_SERVICE_KEY as string
)

const CRON_SECRET = process.env.CRON_SECRET

export async function POST(req: Request) {
  const { searchParams } = new URL(req.url)
  if (!CRON_SECRET || searchParams.get('secret') !== CRON_SECRET) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const body = await req.json().catch(() => ({}))
  const signalId = body.signal_id
  if (!signalId) {
    return Response.json({ error: 'signal_id required in request body.' })
  }

  const { data: sig } = await supabase.from('signals').select('*').eq('signal_id', signalId).maybeSingle()
  if (!sig) {
    // Not necessarily an error -- if main.py's insert and this call
    // race, the row might not be visible yet. Non-fatal: the cron
    // safety net will pick this signal up on its next cycle once the
    // row is genuinely there.
    return Response.json({ signal_id: signalId, outcome: 'not_found_yet', note: 'Cron safety net will pick this up on its next cycle.' })
  }

  const result = await analyseOneSignal(sig)
  return Response.json(result)
}