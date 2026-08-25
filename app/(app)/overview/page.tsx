'use client'
import { useEffect, useState, useCallback } from 'react'
import { supabase } from '@/lib/supabaseClient'

const TIMEFRAMES = [
  { key: '15', label: '15min' },
  { key: '60', label: '1H' },
  { key: '240', label: '4H' },
  { key: 'D', label: 'Daily' },
  { key: 'W', label: 'Weekly' },
  { key: 'M', label: 'Monthly' },
  { key: '12M', label: 'Year' },
]

const TYPE_LABEL: Record<string, string> = {
  sniper_confirmation: 'Sniper Confirmation',
  precision: 'Precision',
}

const POINT_SIZE = 0.01
function pointsBetween(a: number, b: number) {
  return Math.round(Math.abs(a - b) / POINT_SIZE)
}

function netPointsForSignal(sig: any): number {
  const entry = sig.entry
  const exits = sig.exits || {}
  if (entry == null) return 0
  if (sig.final_outcome === 'stopped_out' && exits.sl != null) {
    return -pointsBetween(entry, exits.sl)
  }
  if (sig.final_outcome === 'tp_hit' && exits.tp != null) {
    return pointsBetween(entry, exits.tp)
  }
  return 0
}

export default function OverviewPage() {
  const [confluence, setConfluence] = useState<any[]>([])
  const [selectedTf, setSelectedTf] = useState('15')
  const [stats, setStats] = useState<{ open: number; today: number; successRate: string | null; net: number | null }>({ open: 0, today: 0, successRate: null, net: null })
  const [byType, setByType] = useState<{ type: string; pct: number | null; count: number }[]>([])

  const load = useCallback(async () => {
    const { data: latestSignal } = await supabase
      .from('signals')
      .select('htf_confluence')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    setConfluence(latestSignal?.htf_confluence || [])

    const { data: openSignals } = await supabase.from('signals').select('id').eq('status', 'open')

    const thirtyDaysAgo = new Date(); thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30)
    const { data: resolved } = await supabase
      .from('signals')
      .select('final_outcome,entry,exits,signal_type,created_at')
      .eq('status', 'closed')
      .gte('created_at', thirtyDaysAgo.toISOString())

    const wins = (resolved || []).filter((s: any) => s.final_outcome && s.final_outcome !== 'stopped_out').length
    const total = (resolved || []).length
    const netPoints = (resolved || []).reduce((sum: number, s: any) => sum + netPointsForSignal(s), 0)

    const types = Array.from(new Set((resolved || []).map((s: any) => s.signal_type).filter(Boolean)))
    const byTypeStats = types.map(t => {
      const group = (resolved || []).filter((s: any) => s.signal_type === t)
      const g = group.filter((s: any) => s.final_outcome && s.final_outcome !== 'stopped_out').length
      return {
        type: TYPE_LABEL[t as string] || (t as string).replace(/_/g, ' '),
        pct: group.length ? Math.round((g / group.length) * 100) : null,
        count: group.length,
      }
    })
    setByType(byTypeStats)

    const todayStart = new Date(); todayStart.setHours(0,0,0,0)
    const { data: todaySignals } = await supabase.from('signals').select('id').gte('created_at', todayStart.toISOString())

    setStats({
      open: openSignals?.length || 0,
      today: todaySignals?.length || 0,
      successRate: total > 0 ? ((wins / total) * 100).toFixed(1) : null,
      net: total > 0 ? netPoints : null,
    })
  }, [])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load()
    const channel = supabase.channel('overview-live')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'signals' }, load)
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [load])

  const selectedState = confluence.find((c: any) => c.tf === selectedTf)
  const rawState = selectedState?.state
  const hasData = rawState === 'bullish' || rawState === 'bearish'
  const isBullish = rawState === 'bullish'
  const gaugeColor = !hasData ? '#3A434D' : isBullish ? '#34D399' : '#F87171'
  const gaugeDash = hasData ? '465 0' : '0 465'

  return (
    <div className="p-6 md:p-8">
      <div className="mb-6">
        <h1 className="text-3xl font-bold text-white">Overview <span className="text-[#3A434D] font-medium">— live market cycle &amp; bias</span></h1>
        <div className="font-mono text-xs text-[#7C8896] mt-2">Multi-timeframe signal engine · box-chain state across 8 timeframes</div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5 mb-5">
        <div className="bg-[#0B0F14] border border-[#1B232C] rounded-xl p-6">
          <div className="font-mono text-[11px] tracking-widest text-[#7C8896] uppercase mb-4">Market Cycle</div>
          <div className="flex flex-col items-center mb-5">
            <svg width="180" height="180" viewBox="0 0 180 180">
              <circle cx="90" cy="90" r="74" fill="none" stroke="#141A21" strokeWidth="12" />
              <circle
                cx="90" cy="90" r="74" fill="none"
                stroke={gaugeColor}
                strokeWidth="12"
                strokeDasharray={gaugeDash}
                strokeLinecap="round"
                transform="rotate(-90 90 90)"
                opacity="0.9"
                style={{ transition: 'stroke 0.2s ease' }}
              />
            </svg>
            <div className="text-center -mt-[110px] mb-[80px]">
              <div className="text-lg font-bold tracking-wide" style={{ color: gaugeColor }}>
                {rawState === 'pending' ? 'PENDING' : !hasData ? '—' : isBullish ? 'BULLISH' : 'BEARISH'}
              </div>
              <div className="font-mono text-[10px] text-[#7C8896] mt-1">
                {TIMEFRAMES.find(t => t.key === selectedTf)?.label} box-chain state
              </div>
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            {TIMEFRAMES.map(tf => (
              <button
                key={tf.key}
                onClick={() => setSelectedTf(tf.key)}
                className={`font-mono text-xs px-3 py-1.5 rounded-lg border transition-colors ${
                  selectedTf === tf.key
                    ? 'border-[#2DD4BF] bg-[#2DD4BF]/10 text-white'
                    : 'border-[#1B232C] text-[#7C8896] hover:border-[#3A434D]'
                }`}
              >
                {tf.label}
              </button>
            ))}
          </div>

          <div className="mt-4 bg-[#0F141A] border border-[#1B232C] rounded-lg p-3.5 font-mono text-[11px] text-[#7C8896] leading-relaxed">
            {!selectedState ? (
              <>No data yet for this timeframe — waiting on live signal feed.</>
            ) : (
              <>
                <span style={{ color: gaugeColor }} className="font-semibold">
                  {rawState === 'pending' ? 'Pending' : isBullish ? 'Bullish' : 'Bearish'}
                </span>
                {' '}— current box-chain state on the {TIMEFRAMES.find(t => t.key === selectedTf)?.label} timeframe
                {selectedState.fade_active ? ', price currently outside the box edge' : ''}
                {selectedState.rejections ? `, ${selectedState.rejections} rejection(s)` : ''}.
              </>
            )}
          </div>
        </div>

        <div className="bg-[#0B0F14] border border-[#1B232C] rounded-xl p-6">
          <div className="font-mono text-[11px] tracking-widest text-[#7C8896] uppercase mb-4">Timeframe Boxes — box-chain state</div>
          {confluence.length === 0 ? (
            <div className="text-[#7C8896] font-mono text-sm">No data yet — waiting on live signal feed.</div>
          ) : (
            <div className="grid grid-cols-2 gap-3">
              {TIMEFRAMES.map(tf => {
                const c = confluence.find((x: any) => x.tf === tf.key)
                const st = c?.state
                return (
                  <div key={tf.key} className="bg-[#0F141A] border border-[#1B232C] rounded-lg p-3">
                    <div className="font-mono text-[10px] text-[#7C8896] uppercase tracking-wide mb-1">{tf.label}</div>
                    <div className={`font-mono text-sm font-semibold ${st === 'bullish' ? 'text-[#34D399]' : st === 'bearish' ? 'text-[#F87171]' : 'text-[#7C8896]'}`}>
                      {st === 'bullish' ? 'BULLISH' : st === 'bearish' ? 'BEARISH' : st === 'pending' ? 'PENDING' : '—'}
                    </div>
                    {c?.fade_active && <div className="font-mono text-[9px] text-[#2DD4BF] mt-0.5">OUTSIDE EDGE</div>}
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>

      {byType.length > 0 && (
        <div className="bg-[#0B0F14] border border-[#1B232C] rounded-xl p-5 mb-5">
          <div className="font-mono text-[11px] tracking-widest text-[#7C8896] uppercase mb-3">Success Rate by Signal Type (30d)</div>
          <div className="flex flex-wrap gap-6">
            {byType.map((t, i) => (
              <div key={i}>
                <div className="font-mono text-[10px] text-[#7C8896]">{t.type}</div>
                <div className={`text-xl font-bold ${t.pct !== null && t.pct >= 50 ? 'text-[#34D399]' : t.pct !== null ? 'text-[#F87171]' : 'text-white'}`}>
                  {t.pct !== null ? t.pct + '%' : '—'} <span className="text-[#3A434D] text-xs font-normal">· {t.count}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {[
          { label: 'Open Signals', value: stats.open, color: 'text-white' },
          { label: "Today's Signals", value: stats.today, color: 'text-white' },
          { label: 'Success Rate', value: stats.successRate !== null ? stats.successRate + '%' : '—', color: 'text-[#34D399]' },
          {
            label: 'Net Points (30d)',
            value: stats.net === null ? '—' : (stats.net > 0 ? '+' : '') + stats.net,
            color: stats.net === null ? 'text-white' : stats.net > 0 ? 'text-[#34D399]' : stats.net < 0 ? 'text-[#F87171]' : 'text-white'
          },
        ].map((c, i) => (
          <div key={i} className="bg-[#0B0F14] border border-[#1B232C] rounded-xl p-5">
            <div className="font-mono text-[10px] tracking-widest text-[#7C8896] uppercase mb-2">{c.label}</div>
            <div className={`text-2xl font-bold ${c.color}`}>{c.value}</div>
          </div>
        ))}
      </div>
    </div>
  )
}