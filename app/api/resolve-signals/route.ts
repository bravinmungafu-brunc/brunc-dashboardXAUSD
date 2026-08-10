import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL as string,
  process.env.SUPABASE_SERVICE_KEY as string
)

const AV_KEY = process.env.ALPHAVANTAGE_API_KEY

async function fetchSpotPrice(): Promise<{ price: number | null; timestamp: string | null; raw: any }> {
  const url = `https://www.alphavantage.co/query?function=GOLD_SILVER_SPOT&symbol=XAU&apikey=${AV_KEY}`
  const res = await fetch(url)
  const data = await res.json()
  const price = data?.price != null ? parseFloat(data.price) : null
  const timestamp = data?.timestamp ?? null
  return { price, timestamp, raw: data }
}

function resolveAgainstSpot(signal: any, spot: number) {
  const direction = (signal.direction === 'buy' || signal.direction === 'long') ? 'buy' : 'sell'
  const sl = signal.exits?.sl ?? signal.stop_loss
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
  if (!AV_KEY || AV_KEY.includes('paste_your')) {
    return Response.json({ error: 'Alpha Vantage API key not set yet in .env.local (ALPHAVANTAGE_API_KEY)' })
  }

  const { data: openSignals, error: fetchErr } = await supabase
    .from('signals')
    .select('*')
    .eq('status', 'open')
    .order('created_at', { ascending: true })

  if (fetchErr) return Response.json({ error: fetchErr.message })
  if (!openSignals || openSignals.length === 0) {
    return Response.json({ checked: 0, resolved: 0, stillOpen: 0, updates: [] })
  }

  const { price: spot, timestamp, raw } = await fetchSpotPrice()
  if (spot == null) {
    return Response.json({ error: 'Could not read a price from the Alpha Vantage response.', raw })
  }

  const updates: any[] = []
  let resolvedCount = 0

  for (const sig of openSignals) {
    const result = resolveAgainstSpot(sig, spot)
    if (result.resolved) {
      const { error: updateErr } = await supabase
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

      if (!updateErr) {
        resolvedCount++
        updates.push({ signal_id: sig.signal_id ?? sig.id, outcome: result.outcome, spot })
      }
    }
  }

  return Response.json({
    checked: openSignals.length,
    resolved: resolvedCount,
    stillOpen: openSignals.length - resolvedCount,
    spot,
    spot_timestamp: timestamp,
    updates,
  })
}