'use client'
import { useEffect, useState } from 'react'
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

export default function OverviewPage() {
  const [latestStates, setLatestStates] = useState<any[]>([])
  const [selectedTf, setSelectedTf] = useState('15')
  const [stats, setStats] = useState<{ open: number; today: number; successRate: string | null; net: number }>({ open: 0, today: 0, successRate: null, net: 0 })

  useEffect(() => {
    async function load() {
      const { data: states } = await supabase.from('tf_states').select('*').order('bar_time', { ascending: false }).limit(8)
      setLatestStates(states || [])

      const { data: openSignals } = await supabase.from('signals').select('id').eq('status', 'open')
      const { data: resolved } = await supabase.from('signals').select('final_outcome').eq('status', 'closed')
      const wins = (resolved || []).filter((s: any) => s.final_outcome && s.final_outcome !== 'stopped_out').length
      const total = (resolved || []).length
      const todayStart = new Date(); todayStart.setHours(0,0,0,0)
      const { data: todaySignals } = await supabase.from('signals').select('id').gte('created_at', todayStart.toISOString())

      setStats({
        open: openSignals?.length || 0,
        today: todaySignals?.length || 0,
        successRate: total > 0 ? ((wins / total) * 100).toFixed(1) : null,
        net: 0
      })
    }
    load()
  }, [])

  const selectedState = latestStates.find(s => s.timeframe === selectedTf)
  const isBullish = selectedState?.state === 1
  const hasData = !!selectedState

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
                {!hasData ? '—' : isBullish ? 'BULLISH' : 'BEARISH'}
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
            {!hasData ? (
              <>No data yet for this timeframe — waiting on live signal feed.</>
            ) : (
              <>
                <span style={{ color: gaugeColor }} className="font-semibold">{isBullish ? 'Bullish' : 'Bearish'}</span>
                {' '}— current box-chain state on the {TIMEFRAMES.find(t => t.key === selectedTf)?.label} timeframe.
              </>
            )}
          </div>
        </div>

        <div className="bg-[#0B0F14] border border-[#1B232C] rounded-xl p-6">
          <div className="font-mono text-[11px] tracking-widest text-[#7C8896] uppercase mb-4">Timeframe Boxes — box-chain state</div>
          {latestStates.length === 0 ? (
            <div className="text-[#7C8896] font-mono text-sm">No data yet — waiting on live signal feed.</div>
          ) : (
            <div className="grid grid-cols-2 gap-3">
              {latestStates.map(s => (
                <div key={s.id} className="bg-[#0F141A] border border-[#1B232C] rounded-lg p-3">
                  <div className="font-mono text-[10px] text-[#7C8896] uppercase tracking-wide mb-1">{s.timeframe}</div>
                  <div className={`font-mono text-sm font-semibold ${s.state === 1 ? 'text-[#34D399]' : 'text-[#F87171]'}`}>
                    {s.state === 1 ? 'BULLISH' : 'BEARISH'}
                  </div>
                  {s.event && <div className="font-mono text-[9px] text-[#2DD4BF] mt-0.5">{s.event}</div>}
                </div>
              ))}
            </div>
          )}
          <div className="mt-4 bg-[#14625A]/20 border border-[#14625A] rounded-lg p-4 flex justify-between items-center">
            <div>
              <div className="font-mono text-[11px] text-[#2DD4BF] font-semibold uppercase">Window</div>
              <div className="font-mono text-[11px] text-[#7C8896] mt-1">Exec close breaching a higher-TF box in trade direction</div>
            </div>
            <span className="font-mono text-[10px] border border-[#2DD4BF] text-[#2DD4BF] px-3 py-1 rounded">—</span>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {[
          { label: 'Open Signals', value: stats.open, color: 'text-white' },
          { label: "Today's Signals", value: stats.today, color: 'text-white' },
          { label: 'Success Rate', value: stats.successRate !== null ? stats.successRate + '%' : '—', color: 'text-[#34D399]' },
          { label: 'Net Points (30d)', value: '—', color: 'text-[#2DD4BF]' },
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