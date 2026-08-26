import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL as string,
  process.env.SUPABASE_SERVICE_KEY as string
)

const TD_KEY = process.env.TWELVEDATA_API_KEY
const DAILY_LIMIT = 800
const MAX_SIGNALS_PER_RUN = 20
const MAX_PAGES_PER_SIGNAL = 6

function todayUTC() {
  return new Date().toISOString().slice(0, 10)
}

async function getUsage(): Promise<number> {
  const { data } = await supabase.from('av_usage').select('count').eq('usage_date', todayUTC()).maybeSingle()
  return data?.count ?? 0
}

async function incrementUsage(by: number = 1): Promise<number> {
  const next = (await getUsage()) + by
  await supabase.from('av_usage').upsert({ usage_date: todayUTC(), count: next })
  return next
}

export async function GET() {
  const used = await getUsage()
  return Response.json({ used, limit: DAILY_LIMIT })
}

const INTERVAL_MAP: Record<string, string> = { '1': '1min', '3': '5min', '5': '5min' }

interface RawBar { time: string; high: number; low: number }

async function fetchBarPage(fromIso: string, execTf: string | null | undefined): Promise<{ bars: RawBar[]; raw: any }> {
  const interval = INTERVAL_MAP[execTf ?? ''] ?? '1min'
  const startParam = new Date(fromIso).toISOString().slice(0, 19).replace('T', ' ')

  const url = `https://api.twelvedata.com/time_series?symbol=XAU/USD&interval=${interval}&start_date=${encodeURIComponent(startParam)}&order=ASC&outputsize=5000&apikey=${TD_KEY}`
  const res = await fetch(url)
  const data = await res.json()

  if (data?.status === 'error' || !Array.isArray(data?.values)) {
    return { bars: [], raw: data }
  }

  const bars: RawBar[] = data.values
    .map((v: any) => ({ time: v.datetime, high: parseFloat(v.high), low: parseFloat(v.low) }))
    .sort((a: RawBar, b: RawBar) => a.time.localeCompare(b.time))

  return { bars, raw: null }
}

function walkPageForOutcome(
  bars: RawBar[],
  direction: string,
  sl: number | null,
  tp: number | null
) {
  const isBuy = direction === 'buy' || direction === 'long'

  for (const bar of bars) {
    const slTouched = sl != null && (isBuy ? bar.low <= sl : bar.high >= sl)
    const tpTouched = tp != null && (isBuy ? bar.high >= tp : bar.low <= tp)

    if (slTouched) return { outcome: 'stopped_out' as const, slHit: true, tpHit: tpTouched, resolvedAt: bar.time }
    if (tpTouched) return { outcome: 'tp_hit' as const, slHit: false, tpHit: true, resolvedAt: bar.time }
  }

  return { outcome: 'still_open' as const, slHit: false, tpHit: false, resolvedAt: null as string | null }
}

async function resolveAcrossPages(
  createdAt: string,
  execTf: string | null | undefined,
  direction: string,
  sl: number | null,
  tp: number | null,
  usedRef: { used: number }
) {
  let cursor = createdAt
  let barsChecked = 0

  for (let page = 0; page < MAX_PAGES_PER_SIGNAL; page++) {
    if (usedRef.used >= DAILY_LIMIT) {
      return { outcome: 'quota_exceeded' as const, slHit: false, tpHit: false, resolvedAt: null as string | null, barsChecked }
    }

    const { bars, raw } = await fetchBarPage(cursor, execTf)
    usedRef.used = await incrementUsage(1)

    if (bars.length === 0) {
      return barsChecked === 0
        ? { outcome: 'no_data' as const, slHit: false, tpHit: false, resolvedAt: null as string | null, barsChecked, raw }
        : { outcome: 'still_open' as const, slHit: false, tpHit: false, resolvedAt: null as string | null, barsChecked }
    }

    barsChecked += bars.length
    const result = walkPageForOutcome(bars, direction, sl, tp)
    if (result.outcome !== 'still_open') {
      return { ...result, barsChecked }
    }

    const lastBar = bars[bars.length - 1]
    if (bars.length < 5000) {
      return { outcome: 'still_open' as const, slHit: false, tpHit: false, resolvedAt: null as string | null, barsChecked }
    }
    cursor = new Date(new Date(lastBar.time).getTime() + 1000).toISOString()
  }

  return { outcome: 'still_open' as const, slHit: false, tpHit: false, resolvedAt: null as string | null, barsChecked }
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

  const usedRef = { used: await getUsage() }

  if (!openSignals || openSignals.length === 0) {
    return Response.json({ checked: 0, resolved: 0, stillOpen: 0, deferred: 0, malformed: 0, updates: [], used: usedRef.used, limit: DAILY_LIMIT })
  }

  const toProcess = openSignals.slice(0, MAX_SIGNALS_PER_RUN)
  const deferred = openSignals.length - toProcess.length

  const updates: any[] = []
  let resolvedCount = 0
  let malformedCount = 0

  for (const sig of toProcess) {
    if (usedRef.used >= DAILY_LIMIT) {
      updates.push({ signal_id: sig.signal_id ?? sig.id, outcome: 'quota_exceeded' })
      continue
    }

    const direction = (sig.direction === 'buy' || sig.direction === 'long') ? 'buy' : 'sell'
    const sl = sig.exits?.sl ?? null
    const tp = sig.exits?.tp ?? null

    if (sl == null && tp == null) {
      malformedCount++
      updates.push({ signal_id: sig.signal_id ?? sig.id, outcome: 'malformed_exits' })
      continue
    }

    const result = await resolveAcrossPages(sig.created_at, sig.execution_tf, direction, sl, tp, usedRef)

    if (result.outcome !== 'still_open' && result.outcome !== 'quota_exceeded' && result.outcome !== 'no_data') {
      const resolvedAtDate = result.resolvedAt ? new Date(result.resolvedAt) : new Date()
      const createdAtDate = new Date(sig.created_at)
      const timeToResolutionSeconds = Math.max(0, Math.round((resolvedAtDate.getTime() - createdAtDate.getTime()) / 1000))

      const { error: updateErr, data: updateData } = await supabase
        .from('signals')
        .update({
          sl_hit: result.slHit,
          tp_hit: result.tpHit,
          status: 'closed',
          final_outcome: result.outcome,
          resolved_at: resolvedAtDate.toISOString(),
          time_to_resolution: `${timeToResolutionSeconds} seconds`,
        })
        .eq('id', sig.id)
        .select()

      if (!updateErr && updateData && updateData.length > 0) resolvedCount++
    }

    updates.push({ signal_id: sig.signal_id ?? sig.id, outcome: result.outcome, barsChecked: result.barsChecked })
  }

  return Response.json({
    checked: toProcess.length,
    resolved: resolvedCount,
    stillOpen: toProcess.length - resolvedCount - malformedCount,
    deferred,
    malformed: malformedCount,
    updates,
    used: usedRef.used,
    limit: DAILY_LIMIT,
  })
}