import { createClient } from '@supabase/supabase-js'

// Service-role client: this route runs only server-side, never bundled
// to the browser, so using the service key here is safe. The anon key
// used previously only had a SELECT policy (added earlier to fix a
// different read bug) -- writes under it were silently blocked by RLS,
// which is why past runs reported "resolved" counts that never actually
// persisted to the database (Supabase returns no error on an
// RLS-blocked write, it just updates zero rows quietly).
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL as string,
  process.env.SUPABASE_SERVICE_KEY as string
)

const TD_KEY = process.env.TWELVEDATA_API_KEY
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

export async function GET() {
  const used = await getUsage()
  return Response.json({ used, limit: DAILY_LIMIT })
}

async function fetchSpotPrice(): Promise<{ price: number | null; timestamp: string | null; raw: any }> {
  const url = `https://api.twelvedata.com/price?symbol=XAU/USD&apikey=${TD_KEY}`
  const res = await fetch(url)
  const data = await res.json()
  const price = data?.price != null ? parseFloat(data.price) : null
  return { price, timestamp: new Date().toISOString(), raw: data }
}

function resolveAgainstSpot(signal: any, spot: number) {
  const direction = (signal.direction === 'buy' || signal.direction === 'long') ? 'buy' : 'sell'
  const sl = signal.exits?.sl
  const tp1 = signal.exits?.tp1
  const tp2 = signal.exits?.tp2
  const tp3 = signal.exits?.tp3

  let slHit = false, tp1Hit = false, tp2Hit = false, tp3Hit = false

  if (direction === 'buy') {
    slHit = sl != null && spot <= sl
    tp1Hit = tp1 != null && spot >= tp1
    tp2Hit = tp2 != null && spot >= tp2
    tp3Hit = tp3 != null && spot >= tp3
  } else {
    slHit = sl != null && spot >= sl
    tp1Hit = tp1 != null && spot <= tp1
    tp2Hit = tp2 != null && spot <= tp2
    tp3Hit = tp3 != null && spot <= tp3
  }

  const anyTpHit = tp1Hit || tp2Hit || tp3Hit
  const outcome = !slHit && !anyTpHit ? 'still_open' : slHit ? 'stopped_out' : 'tp_hit'
  return { slHit, tp1Hit, tp2Hit, tp3Hit, outcome, resolved: outcome !== 'still_open' }
}

export async function POST() {
  if (!TD_KEY || TD_KEY.includes('paste_your')) {
    return Response.json({ error: 'Twelve Data API key not set yet in .env.local (TWELVEDATA_API_KEY)' })
  }
  if (!process.env.SUPABASE_SERVICE_KEY) {
    return Response.json({ error: 'SUPABASE_SERVICE_KEY not set yet in .env.local -- required for writing resolved signals.' })
  }

  const { data: openSignals, error: fetchErr } = await supabase
    .from('signals')
    .select('*')
    .eq('status', 'open')
    .order('created_at', { ascending: true })

  if (fetchErr) return Response.json({ error: fetchErr.message })

  const used = await getUsage()

  if (!openSignals || openSignals.length === 0) {
    return Response.json({ checked: 0, resolved: 0, stillOpen: 0, updates: [], used, limit: DAILY_LIMIT })
  }

  if (used >= DAILY_LIMIT) {
    return Response.json({
      error: `Daily Twelve Data limit reached (${used}/${DAILY_LIMIT}). Resets at 00:00 UTC.`,
      quotaExceeded: true,
      used,
      limit: DAILY_LIMIT,
    })
  }

  const { price: spot, timestamp, raw } = await fetchSpotPrice()
  const usedNow = await incrementUsage()

  if (spot == null) {
    return Response.json({ error: 'Could not read a price from the Twelve Data response.', raw, used: usedNow, limit: DAILY_LIMIT })
  }

  const updates: any[] = []
  let resolvedCount = 0

  for (const sig of openSignals) {
    const result = resolveAgainstSpot(sig, spot)

    if (result.resolved) {
      const { error: updateErr, data: updateData } = await supabase
        .from('signals')
        .update({
          tp1_hit: result.tp1Hit,
          tp2_hit: result.tp2Hit,
          tp3_hit: result.tp3Hit,
          sl_hit: result.slHit,
          status: 'closed',
          final_outcome: result.outcome,
        })
        .eq('id', sig.id)
        .select()

      if (!updateErr && updateData && updateData.length > 0) resolvedCount++
    }

    updates.push({ signal_id: sig.signal_id ?? sig.id, outcome: result.outcome, spot })
  }

  return Response.json({
    checked: openSignals.length,
    resolved: resolvedCount,
    stillOpen: openSignals.length - resolvedCount,
    spot,
    spot_timestamp: timestamp,
    updates,
    used: usedNow,
    limit: DAILY_LIMIT,
  })
}