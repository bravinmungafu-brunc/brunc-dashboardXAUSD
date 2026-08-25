// app/api/backtest/route.ts
import { createClient } from '@supabase/supabase-js'
import {
  runBacktest, summarize, DEFAULT_PARAMS,
  type Bar, type BarsByTF, type BacktestParams,
} from '@/lib/backtest/engine'

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
async function incrementUsage(by: number): Promise<number> {
  const next = (await getUsage()) + by
  await supabase.from('av_usage').upsert({ usage_date: todayUTC(), count: next })
  return next
}

async function fetchSeriesPaginated(
  interval: string, startDate: string, endDate: string
): Promise<{ bars: Bar[]; creditsUsed: number }> {
  const allBars: Bar[] = []
  let cursor = endDate
  let creditsUsed = 0
  const startTime = new Date(startDate).getTime()

  for (let guard = 0; guard < 40; guard++) {
    const url = `https://api.twelvedata.com/time_series?symbol=XAU/USD&interval=${interval}&end_date=${encodeURIComponent(cursor)}&order=DESC&outputsize=5000&apikey=${TD_KEY}`
    const res = await fetch(url)
    const data = await res.json()
    creditsUsed++

    if (data?.status === 'error' || !Array.isArray(data?.values) || data.values.length === 0) break

    const chunk: Bar[] = data.values.map((v: any) => ({
      time: v.datetime.replace(' ', 'T') + 'Z',
      open: parseFloat(v.open), high: parseFloat(v.high), low: parseFloat(v.low), close: parseFloat(v.close),
    }))
    allBars.push(...chunk)

    const oldest = chunk[chunk.length - 1]
    if (new Date(oldest.time).getTime() <= startTime) break
    if (chunk.length < 5000) break

    cursor = new Date(new Date(oldest.time).getTime() - 1000).toISOString().slice(0, 19).replace('T', ' ')
  }

  const bars = allBars
    .filter(b => new Date(b.time).getTime() >= startTime)
    .sort((a, b) => a.time.localeCompare(b.time))

  return { bars, creditsUsed }
}

async function fetchDxy(startDate: string, endDate: string): Promise<{ bars: Bar[]; creditsUsed: number }> {
  const url = `https://api.twelvedata.com/time_series?symbol=DXY&interval=1h&start_date=${encodeURIComponent(startDate)}&end_date=${encodeURIComponent(endDate)}&order=ASC&outputsize=5000&apikey=${TD_KEY}`
  const res = await fetch(url)
  const data = await res.json()
  if (data?.status === 'error' || !Array.isArray(data?.values)) return { bars: [], creditsUsed: 1 }
  const bars: Bar[] = data.values.map((v: any) => ({
    time: v.datetime.replace(' ', 'T') + 'Z',
    open: parseFloat(v.open), high: parseFloat(v.high), low: parseFloat(v.low), close: parseFloat(v.close),
  })).sort((a: Bar, b: Bar) => a.time.localeCompare(b.time))
  return { bars, creditsUsed: 1 }
}

function monthlyToYearly(monthly: Bar[]): Bar[] {
  const byYear = new Map<string, Bar[]>()
  for (const bar of monthly) {
    const year = bar.time.slice(0, 4)
    if (!byYear.has(year)) byYear.set(year, [])
    byYear.get(year)!.push(bar)
  }
  const out: Bar[] = []
  for (const [year, bars] of Array.from(byYear.entries()).sort()) {
    out.push({
      time: `${year}-01-01T00:00:00Z`,
      open: bars[0].open,
      high: Math.max(...bars.map(b => b.high)),
      low: Math.min(...bars.map(b => b.low)),
      close: bars[bars.length - 1].close,
    })
  }
  return out
}

function mergeParams(overrides: Partial<BacktestParams>): BacktestParams {
  return { ...DEFAULT_PARAMS, ...overrides }
}

export async function POST(req: Request) {
  if (!TD_KEY || TD_KEY.includes('paste_your')) {
    return Response.json({ error: 'Twelve Data API key not set (TWELVEDATA_API_KEY).' })
  }

  const body = await req.json()
  const startDate: string = body.startDate
  const endDate: string = body.endDate
  const configs: { name: string; params: Partial<BacktestParams> }[] = body.configs?.length
    ? body.configs
    : [{ name: 'Baseline (current live settings)', params: {} }]

  if (!startDate || !endDate) {
    return Response.json({ error: 'startDate and endDate are required.' })
  }
  if (configs.length > 4) {
    return Response.json({ error: 'Maximum 4 configurations per run, to keep this within a reasonable quota footprint.' })
  }

  const used = await getUsage()
  if (used >= DAILY_LIMIT) {
    return Response.json({ error: `Daily Twelve Data limit reached (${used}/${DAILY_LIMIT}). Resets at 00:00 UTC.`, quotaExceeded: true })
  }

  try {
    let creditsUsed = 0

    const [oneMin, fiveMin, fifteenMin, sixtyMin, fourHour, daily, weekly, monthly, dxy] = await Promise.all([
      fetchSeriesPaginated('1min', startDate, endDate),
      fetchSeriesPaginated('5min', startDate, endDate),
      fetchSeriesPaginated('15min', startDate, endDate),
      fetchSeriesPaginated('1h', startDate, endDate),
      fetchSeriesPaginated('4h', startDate, endDate),
      fetchSeriesPaginated('1day', startDate, endDate),
      fetchSeriesPaginated('1week', startDate, endDate),
      fetchSeriesPaginated('1month', startDate, endDate),
      fetchDxy(startDate, endDate),
    ])

    creditsUsed = [oneMin, fiveMin, fifteenMin, sixtyMin, fourHour, daily, weekly, monthly, dxy]
      .reduce((sum, r) => sum + r.creditsUsed, 0)

    if (oneMin.bars.length === 0) {
      return Response.json({ error: 'No 1-minute price data returned for this date range -- try a shorter or more recent range.' })
    }

    const barsByTF: BarsByTF = {
      '1': oneMin.bars,
      '3': fiveMin.bars,
      '5': fiveMin.bars,
      '15': fifteenMin.bars,
      '60': sixtyMin.bars,
      '240': fourHour.bars,
      'D': daily.bars,
      'W': weekly.bars,
      'M': monthly.bars,
      '12M': monthlyToYearly(monthly.bars),
      dxy60: dxy.bars,
    }

    await incrementUsage(creditsUsed)

    const results = configs.map(cfg => {
      const params = mergeParams(cfg.params)
      const signals = runBacktest(barsByTF, params)
      return { name: cfg.name, params, summary: summarize(signals), signals }
    })

    return Response.json({
      results,
      meta: {
        barsCounts: {
          '1m': oneMin.bars.length, '5m': fiveMin.bars.length, '15m': fifteenMin.bars.length,
          '1h': sixtyMin.bars.length, '4h': fourHour.bars.length, 'D': daily.bars.length,
          'W': weekly.bars.length, 'M': monthly.bars.length, 'dxy1h': dxy.bars.length,
        },
        creditsUsed,
        used: used + creditsUsed,
        limit: DAILY_LIMIT,
      },
    })
  } catch (err: any) {
    return Response.json({ error: err?.message ?? 'Backtest run failed.' })
  }
}