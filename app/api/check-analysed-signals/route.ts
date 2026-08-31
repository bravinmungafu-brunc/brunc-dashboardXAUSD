// app/api/check-analysed-signals/route.ts
//
// Resolves analysed_signals -- the LLM's OWN preferred entry/SL/TP,
// not Pine's original ones (that's check-open-signals' job). Same
// cadence pattern: cron-triggered every 10 minutes, cron-secret
// protected, reuses TWELVEDATA_API_KEY_RESOLUTION since this is
// genuinely the same "resolve open positions against real price"
// purpose as check-open-signals, just a different table.
//
// KEY DESIGN INSIGHT: llm_sl is ALWAYS identical to Pine's own SL --
// the LLM never had an independent structural basis to differ (see
// analyse-signals-route.ts). llm_tp only differs when verdict is
// 'invalid'. So a 'valid'-verdict row resolving independently would
// just rediscover exactly what check-open-signals already found for
// the original signal -- pure waste. This route:
//   1. Syncs every open 'valid' row directly from its matching,
//      already-resolved signals row -- zero API cost, pure Supabase.
//   2. Only independently walks real price for 'invalid' rows, since
//      those have a genuinely different exit condition worth checking.
// Always uses 1-minute bars regardless of the original signal's exec
// timeframe -- finer granularity only ever catches a touch at least as
// well as coarser bars would, so this is strictly safe, and avoids
// needing to join back to signals just to look up execution_tf.

import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL as string,
  process.env.SUPABASE_SERVICE_KEY as string
)

const TD_KEY = process.env.TWELVEDATA_API_KEY_RESOLUTION
const DAILY_LIMIT = 800
const KEY_NAME = 'resolution' // same counter check-open-signals already uses -- same account, same purpose
const CRON_SECRET = process.env.CRON_SECRET

function todayUTC() {
  return new Date().toISOString().slice(0, 10)
}

async function getUsage(): Promise<number> {
  const { data } = await supabase
    .from('av_usage')
    .select('count')
    .eq('usage_date', todayUTC())
    .eq('key_name', KEY_NAME)
    .maybeSingle()
  return data?.count ?? 0
}

async function incrementUsage(by: number): Promise<number> {
  const next = (await getUsage()) + by
  await supabase.from('av_usage').upsert({ usage_date: todayUTC(), key_name: KEY_NAME, count: next })
  return next
}

interface RawBar { time: string; high: number; low: number }

async function fetchBarsSince(fromIso: string): Promise<RawBar[]> {
  const startParam = new Date(fromIso).toISOString().slice(0, 19).replace('T', ' ')
  const url = `https://api.twelvedata.com/time_series?symbol=XAU/USD&interval=1min&start_date=${encodeURIComponent(startParam)}&order=ASC&outputsize=5000&apikey=${TD_KEY}`
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) })
  const data = await res.json()
  if (data?.status === 'error' || !Array.isArray(data?.values)) return []
  // Same date-format lesson from check-open-signals: Twelve Data's
  // v.datetime is space-separated, not the same shape as Supabase's
  // ISO timestamps. Every comparison below goes through
  // new Date(...).getTime(), never raw string comparison.
  return data.values
    .map((v: any) => ({ time: v.datetime, high: parseFloat(v.high), low: parseFloat(v.low) }))
    .sort((a: RawBar, b: RawBar) => new Date(a.time).getTime() - new Date(b.time).getTime())
}

function walkForOutcome(bars: RawBar[], direction: string, sl: number | null, tp: number | null) {
  const isBuy = direction === 'buy' || direction === 'long'
  for (const bar of bars) {
    const slTouched = sl != null && (isBuy ? bar.low <= sl : bar.high >= sl)
    const tpTouched = tp != null && (isBuy ? bar.high >= tp : bar.low <= tp)
    if (slTouched) return { outcome: 'stopped_out' as const, resolvedAt: bar.time }
    if (tpTouched) return { outcome: 'tp_hit' as const, resolvedAt: bar.time }
  }
  return { outcome: 'still_open' as const, resolvedAt: null as string | null }
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  if (!CRON_SECRET || searchParams.get('secret') !== CRON_SECRET) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }
  if (!process.env.SUPABASE_SERVICE_KEY) {
    return Response.json({ error: 'SUPABASE_SERVICE_KEY not set.' })
  }

  // STEP 1: sync 'valid' rows for free from their already-resolved
  // signals row -- no API cost, pure Supabase-to-Supabase.
  const { data: validOpen } = await supabase
    .from('analysed_signals')
    .select('id, signal_id')
    .eq('status', 'open')
    .eq('verdict', 'valid')

  let syncedCount = 0
  for (const row of validOpen ?? []) {
    const { data: original } = await supabase
      .from('signals')
      .select('status, final_outcome, resolved_at')
      .eq('signal_id', row.signal_id)
      .maybeSingle()

    if (original && original.status === 'closed') {
      await supabase.from('analysed_signals').update({
        status: 'closed',
        final_outcome: original.final_outcome,
        resolved_at: original.resolved_at,
      }).eq('id', row.id)
      syncedCount++
    }
  }

  // STEP 2: independently resolve 'invalid' rows against their own
  // (possibly different) TP, since those weren't already answered by
  // step 1.
  if (!TD_KEY) {
    return Response.json({ syncedFromOriginal: syncedCount, invalidChecked: 0, note: 'TWELVEDATA_API_KEY_RESOLUTION not set -- valid-row sync still ran, invalid-row checking skipped.' })
  }

  const used = await getUsage()
  if (used >= DAILY_LIMIT) {
    return Response.json({ syncedFromOriginal: syncedCount, invalidChecked: 0, quotaExceeded: true, used, limit: DAILY_LIMIT })
  }

  const { data: invalidOpen } = await supabase
    .from('analysed_signals')
    .select('*')
    .eq('status', 'open')
    .eq('verdict', 'invalid')

  if (!invalidOpen || invalidOpen.length === 0) {
    return Response.json({ syncedFromOriginal: syncedCount, invalidChecked: 0, used, limit: DAILY_LIMIT })
  }

  let earliestCursor: string | null = null
  for (const sig of invalidOpen) {
    const cursor = sig.last_checked_at ?? sig.created_at
    if (!earliestCursor || new Date(cursor).getTime() < new Date(earliestCursor).getTime()) {
      earliestCursor = cursor
    }
  }

  const bars = await fetchBarsSince(earliestCursor as string)
  const creditsUsedThisRun = 1
  await incrementUsage(creditsUsedThisRun)

  let closedCount = 0
  const results: any[] = []

  for (const sig of invalidOpen) {
    const cursor = sig.last_checked_at ?? sig.created_at
    const cursorMs = new Date(cursor).getTime()
    const relevantBars = bars.filter(b => new Date(b.time).getTime() > cursorMs)

    if (relevantBars.length === 0) {
      results.push({ signal_id: sig.signal_id, outcome: 'no_new_bars' })
      continue
    }

    // direction now comes from the real column (fixed before shipping --
    // see the schema migration's note on why a fallback here would have
    // been a real correctness bug, not a safe default).
    if (!sig.direction) {
      results.push({ signal_id: sig.signal_id, outcome: 'error', detail: 'Missing direction -- was this row inserted before the direction column fix? Cannot safely resolve without it.' })
      continue
    }
    const result = walkForOutcome(relevantBars, sig.direction, sig.llm_sl, sig.llm_tp)

    if (result.outcome === 'still_open') {
      const lastBarIso = new Date(relevantBars[relevantBars.length - 1].time).toISOString()
      await supabase.from('analysed_signals').update({ last_checked_at: lastBarIso }).eq('id', sig.id)
      results.push({ signal_id: sig.signal_id, outcome: 'still_open' })
    } else {
      const resolvedAtDate = result.resolvedAt ? new Date(result.resolvedAt) : new Date()
      await supabase.from('analysed_signals').update({
        status: 'closed',
        final_outcome: result.outcome,
        resolved_at: resolvedAtDate.toISOString(),
      }).eq('id', sig.id)
      closedCount++
      results.push({ signal_id: sig.signal_id, outcome: result.outcome })
    }
  }

  const finalUsed = await getUsage() // read-only, no need to write since incrementUsage already ran once above

  return Response.json({
    syncedFromOriginal: syncedCount,
    invalidChecked: invalidOpen.length,
    closed: closedCount,
    results,
    creditsUsedThisRun,
    used: finalUsed,
    limit: DAILY_LIMIT,
  })
}