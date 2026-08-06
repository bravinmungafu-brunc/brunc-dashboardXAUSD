'use client'
import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabaseClient'

const PHASES = [
  { key: 'accumulation', label: 'Accumulation — range formed', color: '#34D399' },
  { key: 'manipulation', label: 'Manipulation — swept 1H low', color: '#F87171' },
  { key: 'distribution', label: 'Distribution — expansion up', color: '#2DD4BF' },
]

export default function OverviewPage() {
  const [latestStates, setLatestStates] = useState<any[]>([])
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
              <circle cx="90" cy="90" r="74" fill="none" stroke="#34D399" strokeWidth="12" strokeDasharray="155 465" strokeLinecap="round" transform="rotate(-90 90 90)" opacity="0.9" />
              <circle cx="90" cy="90" r="74" fill="none" stroke="#F87171" strokeWidth="12" strokeDasharray="77 465" strokeDashoffset="-155" strokeLinecap="round" transform="rotate(-90 90 90)" opacity="0.9" />
              <circle cx="90" cy="90" r="74" fill="none" stroke="#2DD4BF" strokeWidth="12" strokeDasharray="116 465" strokeDashoffset="-232" strokeLinecap="round" transform="rotate(-90 90 90)" />
            </svg>
            <div className="text-center -mt-[100px] mb-[70px]">
              <div className="text-lg font-bold text-[#2DD4BF] tracking-wide">DISTRIBUTION</div>
              <div className="font-mono text-[10px] text-[#7C8896] mt-1">true move in progress</div>
            </div>
          </div>
          <div className="space-y-2">
            {PHASES.map(p => (
              <div key={p.key} className={`flex items-center gap-2.5 font-mono text-xs px-3 py-2 rounded-lg border ${p.key === 'distribution' ? 'border-[#2DD4BF] bg-[#2DD4BF]/10 text-white' : 'border-[#1B232C] text-[#7C8896]'}`}>
                <span className="w-2 h-2 rounded-sm" style={{ background: p.color }} />
                {p.label}
              </div>
            ))}
          </div>
          <div className="mt-4 bg-[#0F141A] border border-[#1B232C] rounded-lg p-3.5 font-mono text-[11px] text-[#7C8896] leading-relaxed">
            <span className="text-[#34D399] font-semibold">Bullish</span> — price wicked below the 1H box low then closed back above it. Bearish path invalidated on close. Valid until close back below the 1H box low or its high is reached.
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