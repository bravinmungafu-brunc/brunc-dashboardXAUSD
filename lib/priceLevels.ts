// lib/priceLevels.ts
//
// Tracks the PREVIOUS completed day's and week's high/low, and checks
// whether live price has broken either one. Reuses
// TWELVEDATA_API_KEY_RESOLUTION (same "price-checking" purpose family
// as check-open-signals/check-analysed-signals/check-news-signals) --
// deliberate simplification rather than a 4th dedicated Twelve Data
// account, given how light this usage is (a handful of calls per day,
// not per-cycle).
//
// Levels are cached in app_settings once per day (refreshed only when
// the cached date is stale), so most check-transitions cycles only
// need ONE lightweight live-price call, not a full re-fetch of
// historical daily/weekly bars every 5 minutes.

import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL as string,
  process.env.SUPABASE_SERVICE_KEY as string
)

const TD_KEY = process.env.TWELVEDATA_API_KEY_RESOLUTION

interface CachedLevels {
  date: string
  prevDayHigh: number | null
  prevDayLow: number | null
  prevWeekHigh: number | null
  prevWeekLow: number | null
}

function todayUTC() {
  return new Date().toISOString().slice(0, 10)
}

async function getSetting(key: string): Promise<string | null> {
  const { data } = await supabase.from('app_settings').select('value').eq('key', key).maybeSingle()
  if (!data) return null
  return typeof data.value === 'string' ? data.value : JSON.stringify(data.value)
}

async function setSetting(key: string, value: string) {
  await supabase.from('app_settings').upsert({ key, value })
}

async function fetchPreviousCompletedBar(interval: '1day' | '1week'): Promise<{ high: number; low: number } | null> {
  if (!TD_KEY) return null
  try {
    const url = `https://api.twelvedata.com/time_series?symbol=XAU/USD&interval=${interval}&outputsize=3&apikey=${TD_KEY}`
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) })
    const data = await res.json()
    if (data?.status === 'error' || !Array.isArray(data?.values) || data.values.length < 2) return null

    const today = todayUTC()
    // Twelve Data returns most-recent-first by default. The first
    // entry can be TODAY's still-forming bar -- we want the most
    // recent one that's genuinely a PAST, completed period, not the
    // current in-progress one.
    const completed = data.values.find((v: any) => v.datetime.slice(0, 10) < today) || data.values[1]
    if (!completed) return null
    return { high: parseFloat(completed.high), low: parseFloat(completed.low) }
  } catch {
    return null
  }
}

async function getCachedLevels(): Promise<CachedLevels> {
  const cachedDate = await getSetting('price_levels_cache_date')
  const today = todayUTC()

  if (cachedDate === today) {
    const prevDayHigh = await getSetting('prev_day_high')
    const prevDayLow = await getSetting('prev_day_low')
    const prevWeekHigh = await getSetting('prev_week_high')
    const prevWeekLow = await getSetting('prev_week_low')
    return {
      date: today,
      prevDayHigh: prevDayHigh != null ? parseFloat(prevDayHigh) : null,
      prevDayLow: prevDayLow != null ? parseFloat(prevDayLow) : null,
      prevWeekHigh: prevWeekHigh != null ? parseFloat(prevWeekHigh) : null,
      prevWeekLow: prevWeekLow != null ? parseFloat(prevWeekLow) : null,
    }
  }

  // Cache is stale (new day) -- refresh from real data, once.
  const prevCachedWeekHigh = await getSetting('prev_week_high')
  const [dayBar, weekBar] = await Promise.all([
    fetchPreviousCompletedBar('1day'),
    fetchPreviousCompletedBar('1week'),
  ])

  const levels: CachedLevels = {
    date: today,
    prevDayHigh: dayBar?.high ?? null,
    prevDayLow: dayBar?.low ?? null,
    prevWeekHigh: weekBar?.high ?? null,
    prevWeekLow: weekBar?.low ?? null,
  }

  await setSetting('price_levels_cache_date', today)
  if (levels.prevDayHigh != null) await setSetting('prev_day_high', String(levels.prevDayHigh))
  if (levels.prevDayLow != null) await setSetting('prev_day_low', String(levels.prevDayLow))
  if (levels.prevWeekHigh != null) await setSetting('prev_week_high', String(levels.prevWeekHigh))
  if (levels.prevWeekLow != null) await setSetting('prev_week_low', String(levels.prevWeekLow))
  // New day -> new prevDay levels -> reset daily notification flags.
  await setSetting('notified_daily_high_break', 'false')
  await setSetting('notified_daily_low_break', 'false')
  // STAGE FIX: real gap caught before shipping -- weekly flags were
  // never actually reset anywhere, meaning once notified about a
  // weekly break, it would silently NEVER notify again even after a
  // genuinely new week's levels came in. Now compares the newly
  // fetched weekly high against what was previously cached -- if it
  // changed, that's a real sign a new week's levels are in effect,
  // so the weekly flags reset too.
  const weekRolledOver = levels.prevWeekHigh != null && String(levels.prevWeekHigh) !== prevCachedWeekHigh
  if (weekRolledOver) {
    await setSetting('notified_weekly_high_break', 'false')
    await setSetting('notified_weekly_low_break', 'false')
  }

  return levels
}

async function getLivePrice(): Promise<number | null> {
  if (!TD_KEY) return null
  try {
    const res = await fetch(`https://api.twelvedata.com/price?symbol=XAU/USD&apikey=${TD_KEY}`, { signal: AbortSignal.timeout(8000) })
    const data = await res.json()
    const price = data?.price != null ? parseFloat(data.price) : null
    return Number.isFinite(price) ? price : null
  } catch {
    return null
  }
}

export interface PriceLevelBreak {
  type: 'daily_high' | 'daily_low' | 'weekly_high' | 'weekly_low'
  level: number
  livePrice: number
}

// Checks live price against cached levels, returning any NEW breaks
// (ones not already notified about) and marking them as notified so
// subsequent calls this same day/week don't re-fire on every cycle.
export async function checkPriceLevelBreaks(): Promise<PriceLevelBreak[]> {
  const levels = await getCachedLevels()
  const livePrice = await getLivePrice()
  if (livePrice == null) return []

  const breaks: PriceLevelBreak[] = []

  if (levels.prevDayHigh != null && livePrice > levels.prevDayHigh) {
    const alreadyNotified = (await getSetting('notified_daily_high_break')) === 'true'
    if (!alreadyNotified) {
      breaks.push({ type: 'daily_high', level: levels.prevDayHigh, livePrice })
      await setSetting('notified_daily_high_break', 'true')
    }
  }
  if (levels.prevDayLow != null && livePrice < levels.prevDayLow) {
    const alreadyNotified = (await getSetting('notified_daily_low_break')) === 'true'
    if (!alreadyNotified) {
      breaks.push({ type: 'daily_low', level: levels.prevDayLow, livePrice })
      await setSetting('notified_daily_low_break', 'true')
    }
  }
  if (levels.prevWeekHigh != null && livePrice > levels.prevWeekHigh) {
    const alreadyNotified = (await getSetting('notified_weekly_high_break')) === 'true'
    if (!alreadyNotified) {
      breaks.push({ type: 'weekly_high', level: levels.prevWeekHigh, livePrice })
      await setSetting('notified_weekly_high_break', 'true')
    }
  }
  if (levels.prevWeekLow != null && livePrice < levels.prevWeekLow) {
    const alreadyNotified = (await getSetting('notified_weekly_low_break')) === 'true'
    if (!alreadyNotified) {
      breaks.push({ type: 'weekly_low', level: levels.prevWeekLow, livePrice })
      await setSetting('notified_weekly_low_break', 'true')
    }
  }

  return breaks
}