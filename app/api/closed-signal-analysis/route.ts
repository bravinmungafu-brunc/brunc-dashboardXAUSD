import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL as string,
  process.env.SUPABASE_SERVICE_KEY as string
)

const MIN_SAMPLE = 3

const MANUAL_CONDITIONS: { key: string; label: string }[] = [
  { key: 'bias_1h', label: '1H directional bias' },
  { key: 'zone_tapped', label: 'order block zone tapped' },
  { key: 'discount_premium', label: 'Fibonacci discount/premium' },
  { key: 'session_open', label: 'London/NY session open' },
  { key: 'doji_or_rejection', label: '1m doji or rejection candle' },
]

const SESSION_ORDER = ['Asian', 'London', 'New York', 'Overlap']
function sessionForDate(dateStr: string) {
  const h = new Date(dateStr).getUTCHours()
  const inLondon = h >= 8 && h < 17
  const inNewYork = h >= 13 && h < 22
  if (inLondon && inNewYork) return 'Overlap'
  if (inLondon) return 'London'
  if (inNewYork) return 'New York'
  return 'Asian'
}

export async function GET() {
  const { data: signals, error } = await supabase
    .from('signals')
    .select('*')
    .eq('status', 'closed')
    .order('created_at', { ascending: false })
    .limit(200)

  if (error) return Response.json({ error: error.message })

  const closed = signals || []
  const losses = closed.filter(s => s.final_outcome === 'stopped_out')
  const wins = closed.filter(s => s.final_outcome && s.final_outcome !== 'stopped_out')

  const patterns: string[] = []

  if (closed.length < MIN_SAMPLE) {
    return Response.json({
      totalClosed: closed.length,
      totalWins: wins.length,
      totalLosses: losses.length,
      patterns: [],
      note: `Only ${closed.length} closed signal${closed.length === 1 ? '' : 's'} so far -- need at least ${MIN_SAMPLE} before any pattern is worth reporting.`,
    })
  }

  const precisionLosses = losses.filter(s => s.signal_type === 'precision' && s.manual_entry_filter?.applicable === true)
  if (precisionLosses.length >= MIN_SAMPLE) {
    for (const { key, label } of MANUAL_CONDITIONS) {
      const falseCount = precisionLosses.filter(s => s.manual_entry_filter[key] === false).length
      const pct = falseCount / precisionLosses.length
      if (pct >= 0.5) {
        patterns.push(`${falseCount} of ${precisionLosses.length} Precision losses had "${label}" reading false at signal time.`)
      }
    }
  }

  const setupA = closed.filter(s => s.path === 'setup_a')
  const setupB = closed.filter(s => s.path === 'setup_b')
  if (setupA.length >= MIN_SAMPLE && setupB.length >= MIN_SAMPLE) {
    const aWinRate = Math.round((setupA.filter(s => s.final_outcome !== 'stopped_out').length / setupA.length) * 100)
    const bWinRate = Math.round((setupB.filter(s => s.final_outcome !== 'stopped_out').length / setupB.length) * 100)
    if (Math.abs(aWinRate - bWinRate) >= 20) {
      const weaker = aWinRate < bWinRate ? 'Setup A' : 'Setup B'
      const weakerRate = Math.min(aWinRate, bWinRate)
      const strongerRate = Math.max(aWinRate, bWinRate)
      patterns.push(`${weaker} is winning less often than the other path (${weakerRate}% vs ${strongerRate}%) across ${setupA.length + setupB.length} closed Sniper Confirmation signals.`)
    }
  }

  const sessionStats = SESSION_ORDER.map(name => {
    const group = closed.filter(s => sessionForDate(s.created_at) === name)
    const winRate = group.length ? Math.round((group.filter(s => s.final_outcome !== 'stopped_out').length / group.length) * 100) : null
    return { name, count: group.length, winRate }
  }).filter(s => s.count >= MIN_SAMPLE)

  if (sessionStats.length >= 2) {
    const sorted = [...sessionStats].sort((a, b) => (a.winRate ?? 0) - (b.winRate ?? 0))
    const weakest = sorted[0]
    const others = sorted.slice(1)
    const avgOthers = others.reduce((sum, s) => sum + (s.winRate ?? 0), 0) / others.length
    if (avgOthers - (weakest.winRate ?? 0) >= 20) {
      patterns.push(`${weakest.name} session is trailing the others -- ${weakest.winRate}% win rate across ${weakest.count} signals, versus an average of ${Math.round(avgOthers)}% elsewhere.`)
    }
  }

  const lowGrade = closed.filter(s => s.grade?.value != null && s.grade.value <= 2)
  const highGrade = closed.filter(s => s.grade?.value != null && s.grade.value >= 5)
  if (lowGrade.length >= MIN_SAMPLE && highGrade.length >= MIN_SAMPLE) {
    const lowWinRate = Math.round((lowGrade.filter(s => s.final_outcome !== 'stopped_out').length / lowGrade.length) * 100)
    const highWinRate = Math.round((highGrade.filter(s => s.final_outcome !== 'stopped_out').length / highGrade.length) * 100)
    if (highWinRate - lowWinRate >= 20) {
      patterns.push(`Grade 5+/7 signals are winning notably more than grade 0-2/7 signals (${highWinRate}% vs ${lowWinRate}%, across ${highGrade.length} and ${lowGrade.length} signals respectively).`)
    }
  }

  return Response.json({
    totalClosed: closed.length,
    totalWins: wins.length,
    totalLosses: losses.length,
    patterns,
    note: patterns.length === 0 ? 'No pattern currently clears the reporting threshold -- either performance is fairly even across the board, or sample sizes in each category are still too small to say.' : null,
  })
}