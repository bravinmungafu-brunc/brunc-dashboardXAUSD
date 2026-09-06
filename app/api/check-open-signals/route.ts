// app/api/check-open-signals/route.ts
//
// Runs the 10-minute open-signal check. Triggered externally by a
// free cron service (e.g. cron-job.org) hitting this URL with the
// correct ?secret= query param every 10 minutes -- there is no button
// for this, it's meant to run continuously in the background.
//
// COST DESIGN, worth understanding before changing this file: open
// signals are grouped by execution interval (at most 2 buckets --
// '1min' or '5min', matching INTERVAL_MAP below), and each group gets
// exactly ONE Twelve Data request per cycle covering every signal in
// it, not one request per signal. That's what keeps this at roughly
// 2 credits per 10-minute cycle (~288/day worst case, realistically
// less) instead of scaling with how many signals happen to be open.
// Uses a SEPARATE, dedicated Twelve Data key (TWELVEDATA_API_KEY_RESOLUTION)
// so this never competes with Backtest's TWELVEDATA_API_KEY quota.
//
// Each signal tracks its own last_checked_at cursor so a bar already
// walked once is never re-fetched or re-walked on a later cycle --
// once a signal closes, it drops out of the next cycle's query
// entirely (status is no longer 'open').

import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL as string,
  process.env.SUPABASE_SERVICE_KEY as string
)

const TD_KEY = process.env.TWELVEDATA_API_KEY_RESOLUTION
const DAILY_LIMIT = 800
const KEY_NAME = 'resolution' // separate usage counter from Backtest's 'backtest' key_name

// Shared secret so this public URL can only be triggered by your own
// cron service, not random internet traffic that could otherwise spam
// writes to your signals table. Set CRON_SECRET in your environment
// and configure cron-job.org's URL as:
//   https://your-app.onrender.com/api/check-open-signals?secret=YOUR_SECRET
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

const INTERVAL_MAP: Record<string, string> = { '1': '1min', '3': '5min', '5': '5min' }

interface RawBar { time: string; open: number; high: number; low: number }

async function fetchBarsSince(fromIso: string, interval: string): Promise<{ bars: RawBar[]; raw: any }> {
  const startParam = new Date(fromIso).toISOString().slice(0, 19).replace('T', ' ')
  const url = `https://api.twelvedata.com/time_series?symbol=XAU/USD&interval=${interval}&start_date=${encodeURIComponent(startParam)}&order=ASC&outputsize=5000&apikey=${TD_KEY}`
  const res = await fetch(url)
  const data = await res.json()
  if (data?.status === 'error' || !Array.isArray(data?.values)) {
    return { bars: [], raw: data }
  }
  // NOTE: v.datetime from Twelve Data is space-separated
  // ("2026-08-29 14:20:00"), NOT the same format as Supabase's ISO
  // timestamps ("2026-08-29T14:20:00.000Z"). Every comparison against
  // a Supabase cursor below goes through new Date(...).getTime(),
  // never raw string comparison -- confirmed by direct test that
  // comparing the two formats as strings gives WRONG answers (a
  // later bar can appear "less than" an earlier cursor purely
  // because 'T' and ' ' sort differently at that character position).
  const bars: RawBar[] = data.values
    .map((v: any) => ({ time: v.datetime, open: parseFloat(v.open), high: parseFloat(v.high), low: parseFloat(v.low) }))
    .sort((a: RawBar, b: RawBar) => new Date(a.time).getTime() - new Date(b.time).getTime())
  return { bars, raw: null }
}

function walkForOutcome(bars: RawBar[], direction: string, sl: number | null, tp: number | null) {
  const isBuy = direction === 'buy' || direction === 'long'
  for (const bar of bars) {
    const slTouched = sl != null && (isBuy ? bar.low <= sl : bar.high >= sl)
    const tpTouched = tp != null && (isBuy ? bar.high >= tp : bar.low <= tp)

    if (slTouched && tpTouched) {
      // STAGE FIX: real bug found -- this used to always report SL
      // first whenever both were touched in the same bar, regardless
      // of which genuinely happened first. OHLC data alone can't
      // reveal true intra-bar order, but this systematically
      // over-reported stopped_out every time both levels fell inside
      // one bar's range -- directly contributing to "SL always hit,
      // TP never hit" even on bars where TP may well have come first.
      // Defensible heuristic: whichever level sits CLOSER to the
      // bar's own open price is more likely to have been reached
      // first, since price typically moves progressively away from
      // the open before any reversal within the same bar.
      const distToSL = Math.abs(bar.open - (sl as number))
      const distToTP = Math.abs(bar.open - (tp as number))
      if (distToTP < distToSL) {
        return { outcome: 'tp_hit' as const, slHit: false, tpHit: true, resolvedAt: bar.time }
      }
      return { outcome: 'stopped_out' as const, slHit: true, tpHit: true, resolvedAt: bar.time }
    }
    if (slTouched) return { outcome: 'stopped_out' as const, slHit: true, tpHit: false, resolvedAt: bar.time }
    if (tpTouched) return { outcome: 'tp_hit' as const, slHit: false, tpHit: true, resolvedAt: bar.time }
  }
  return { outcome: 'still_open' as const, slHit: false, tpHit: false, resolvedAt: null as string | null }
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  if (!CRON_SECRET || searchParams.get('secret') !== CRON_SECRET) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }
  if (!TD_KEY || TD_KEY.includes('paste_your')) {
    return Response.json({ error: 'TWELVEDATA_API_KEY_RESOLUTION not set -- this needs its own dedicated Twelve Data account, separate from TWELVEDATA_API_KEY (reserved for Backtest).' })
  }
  if (!process.env.SUPABASE_SERVICE_KEY) {
    return Response.json({ error: 'SUPABASE_SERVICE_KEY not set -- required to write resolved signals.' })
  }

  const used = await getUsage()
  if (used >= DAILY_LIMIT) {
    return Response.json({ error: `Resolution key's daily Twelve Data limit reached (${used}/${DAILY_LIMIT}). Resets at 00:00 UTC.`, quotaExceeded: true, used, limit: DAILY_LIMIT })
  }

  const { data: openSignals, error: fetchErr } = await supabase
    .from('signals')
    .select('*')
    .eq('status', 'open')

  if (fetchErr) return Response.json({ error: fetchErr.message })
  if (!openSignals || openSignals.length === 0) {
    return Response.json({ checked: 0, closed: 0, stillOpen: 0, creditsUsedThisRun: 0, used, limit: DAILY_LIMIT })
  }

  // Group by interval -- at most 2 buckets, so this cycle costs at
  // most 2 credits regardless of how many signals are open.
  const groups: Record<string, typeof openSignals> = {}
  for (const sig of openSignals) {
    const interval = INTERVAL_MAP[sig.execution_tf ?? ''] ?? '1min'
    if (!groups[interval]) groups[interval] = []
    groups[interval].push(sig)
  }

  let creditsUsedThisRun = 0
  let closedCount = 0
  const results: any[] = []

  for (const [interval, group] of Object.entries(groups)) {
    if (used + creditsUsedThisRun >= DAILY_LIMIT) {
      for (const sig of group) results.push({ signal_id: sig.signal_id ?? sig.id, outcome: 'quota_exceeded' })
      continue
    }

    // Earliest cursor in this group -- compared as real timestamps,
    // never as raw strings (see fetchBarsSince note above for why).
    let earliestCursor: string | null = null
    for (const sig of group) {
      const cursor = sig.last_checked_at ?? sig.created_at
      if (!earliestCursor || new Date(cursor).getTime() < new Date(earliestCursor).getTime()) {
        earliestCursor = cursor
      }
    }
    if (!earliestCursor) continue

    const { bars } = await fetchBarsSince(earliestCursor, interval)
    creditsUsedThisRun++

    for (const sig of group) {
      const cursor = sig.last_checked_at ?? sig.created_at
      const cursorMs = new Date(cursor).getTime()
      const relevantBars = bars.filter(b => new Date(b.time).getTime() > cursorMs)

      if (relevantBars.length === 0) {
        results.push({ signal_id: sig.signal_id ?? sig.id, outcome: 'no_new_bars' })
        continue
      }

      const direction = (sig.direction === 'buy' || sig.direction === 'long') ? 'buy' : 'sell'
      const sl = sig.exits?.sl ?? null
      const tp = sig.exits?.tp ?? null
      const result = walkForOutcome(relevantBars, direction, sl, tp)

      if (result.outcome === 'still_open') {
        // Nothing touched yet -- advance the cursor to the last bar we
        // just checked, so next cycle only fetches/walks bars after it.
        const lastBarIso = new Date(relevantBars[relevantBars.length - 1].time).toISOString()
        await supabase.from('signals').update({ last_checked_at: lastBarIso }).eq('id', sig.id)
        results.push({ signal_id: sig.signal_id ?? sig.id, outcome: 'still_open' })
      } else {
        const resolvedAtDate = result.resolvedAt ? new Date(result.resolvedAt) : new Date()
        const createdAtDate = new Date(sig.created_at)
        const timeToResolutionSeconds = Math.max(0, Math.round((resolvedAtDate.getTime() - createdAtDate.getTime()) / 1000))
        await supabase.from('signals').update({
          sl_hit: result.slHit,
          tp_hit: result.tpHit,
          status: 'closed',
          final_outcome: result.outcome,
          resolved_at: resolvedAtDate.toISOString(),
          time_to_resolution: `${timeToResolutionSeconds} seconds`,
        }).eq('id', sig.id)
        closedCount++
        results.push({ signal_id: sig.signal_id ?? sig.id, outcome: result.outcome })
      }
    }
  }

  const finalUsed = await incrementUsage(creditsUsedThisRun)

  return Response.json({
    checked: openSignals.length,
    closed: closedCount,
    stillOpen: openSignals.length - closedCount,
    creditsUsedThisRun,
    results,
    used: finalUsed,
    limit: DAILY_LIMIT,
  })
}