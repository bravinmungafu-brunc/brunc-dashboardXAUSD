'use client'
import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabaseClient'

function getExits(sig: any) {
  const sl = sig.exits?.sl ?? sig.stop_loss ?? null
  const tp1 = sig.exits?.tp1 ?? null
  const tp2 = sig.exits?.tp2 ?? null
  const tp3 = sig.exits?.tp3 ?? null
  const entry = sig.entry ?? sig.price ?? null
  return { sl, tp1, tp2, tp3, entry }
}

function computeRR(entry: number | null, sl: number | null, tp1: number | null) {
  if (entry == null || sl == null || tp1 == null) return { riskPoints: null, rewardPoints: null, rr: null }
  const riskPoints = Math.abs(entry - sl)
  const rewardPoints = Math.abs(tp1 - entry)
  const rr = riskPoints > 0 ? (rewardPoints / riskPoints).toFixed(2) : null
  return { riskPoints: riskPoints.toFixed(2), rewardPoints: rewardPoints.toFixed(2), rr }
}

export default function SignalsPage() {
  const [signals, setSignals] = useState<any[]>([])
  const [filter, setFilter] = useState('all')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function fetchSignals() {
      const { data } = await supabase.from('signals').select('*').order('created_at', { ascending: false }).limit(50)
      setSignals(data || [])
      setLoading(false)
    }
    fetchSignals()
    const channel = supabase.channel('signals-feed')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'signals' }, fetchSignals)
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [])

  const filtered = signals.filter(s => {
    if (filter === 'all') return true
    if (filter === 'sniper_confirmation') return s.signal_type === 'sniper_confirmation'
    if (filter === 'open') return s.status === 'open'
    if (filter === 'closed') return s.status === 'closed'
    if (filter === 'precision') return s.tier === 1
    if (filter === 'fade') return s.tier === 2 || s.tier === 3
    return true
  })

  return (
    <div className="p-6 md:p-8">
      <div className="mb-6">
        <h1 className="text-3xl font-bold text-white">Signals <span className="text-[#3A434D] font-medium">— entry, SL, TP &amp; outcome</span></h1>
        <div className="font-mono text-xs text-[#7C8896] mt-2">Precision entries confirm CSOD+BOS inside an open window · fade entries fire live off the exec box</div>
      </div>

      <div className="flex gap-2 mb-6 flex-wrap">
        {['all','sniper_confirmation','precision','fade','open','closed'].map(f => (
          <button key={f} onClick={() => setFilter(f)}
            className={`font-mono text-[11px] uppercase tracking-wide px-4 py-1.5 rounded ${
              filter === f ? 'bg-[#14625A]/40 text-[#2DD4BF] border border-[#2DD4BF]' : 'border border-[#1B232C] text-[#7C8896]'
            }`}>{f === 'sniper_confirmation' ? 'SNIPER CONFIRMATION' : f}</button>
        ))}
      </div>

      {loading ? (
        <div className="text-[#7C8896] font-mono text-sm">Loading…</div>
      ) : filtered.length === 0 ? (
        <div className="text-[#7C8896] font-mono text-sm">No signals yet — waiting on live signal feed.</div>
      ) : (
        <div className="space-y-4">
          {filtered.map(sig => {
            const { sl, tp1, tp2, tp3, entry } = getExits(sig)
            const { riskPoints, rewardPoints, rr } = computeRR(entry, sl, tp1)
            const tierLabel = sig.signal_type
              ? sig.signal_type.replace(/_/g, ' ').toUpperCase()
              : (sig.tier === 1 ? 'PRECISION' : 'FADE')
            const gradeValue = sig.grade?.value ?? null
            const gradeOf = sig.grade?.of ?? null

            return (
              <div key={sig.id} className="bg-[#0B0F14] border-l-2 border-l-[#2DD4BF] border-y border-r border-[#1B232C] rounded-xl p-5">
                <div className="flex justify-between items-center mb-4 flex-wrap gap-2">
                  <span className="font-bold text-white text-base flex items-center gap-2">
                    {(sig.direction === 'long' || sig.direction === 'buy') ? <span className="text-[#34D399]">▲</span> : <span className="text-[#F87171]">▼</span>}
                    {sig.direction?.toUpperCase()} {sig.symbol}
                    <span className="font-mono text-[10px] px-2 py-0.5 rounded border border-[#2DD4BF] text-[#2DD4BF]">{tierLabel}</span>
                    {gradeValue !== null && (
                      <span className="font-mono text-[10px] px-2 py-0.5 rounded border border-[#7C8896] text-[#7C8896]">
                        GRADE {gradeValue}/{gradeOf}
                      </span>
                    )}
                  </span>
                  <span className={`font-mono text-[10px] px-2.5 py-1 rounded ${sig.status === 'open' ? 'bg-[#14625A]/30 text-[#2DD4BF]' : 'bg-[#34D399]/15 text-[#34D399]'}`}>
                    {sig.status === 'open' ? (sig.entry_filled ? 'OPEN' : 'PENDING') : (sig.final_outcome || 'CLOSED').toUpperCase()}
                  </span>
                </div>

                <div className="grid grid-cols-2 md:grid-cols-5 gap-2.5 mb-3">
                  <div className="bg-[#0F141A] rounded-lg p-2.5">
                    <div className="text-[9px] text-[#7C8896] uppercase tracking-wide mb-1 font-mono">Stop</div>
                    <div className="text-[#F87171] font-mono text-sm">{sl ?? '—'}</div>
                  </div>
                  <div className="bg-[#0F141A] rounded-lg p-2.5">
                    <div className="text-[9px] text-[#7C8896] uppercase tracking-wide mb-1 font-mono">Entry</div>
                    <div className="text-white font-mono text-sm">{entry ?? '—'}</div>
                  </div>
                  <div className="bg-[#0F141A] rounded-lg p-2.5">
                    <div className="text-[9px] text-[#7C8896] uppercase tracking-wide mb-1 font-mono">TP1 <span className="text-[#3A434D]">· 15min</span></div>
                    <div className="text-[#34D399] font-mono text-sm">{tp1 ?? '—'}</div>
                  </div>
                  <div className="bg-[#0F141A] rounded-lg p-2.5">
                    <div className="text-[9px] text-[#7C8896] uppercase tracking-wide mb-1 font-mono">TP2 <span className="text-[#3A434D]">· 1H</span></div>
                    <div className="text-[#34D399] font-mono text-sm">{tp2 ?? '—'}</div>
                  </div>
                  <div className="bg-[#0F141A] rounded-lg p-2.5">
                    <div className="text-[9px] text-[#7C8896] uppercase tracking-wide mb-1 font-mono">TP3 <span className="text-[#3A434D]">· 4H</span></div>
                    <div className="text-[#34D399] font-mono text-sm">{tp3 ?? '—'}</div>
                  </div>
                </div>

                <div className="font-mono text-[11px] text-[#7C8896] mb-3">{sig.reasoning || 'Signal logic recorded from live signal payload.'}</div>

                <div className="flex justify-between font-mono text-[11px] text-[#7C8896] flex-wrap gap-2">
                  <span>Risk: <span className="text-[#F87171]">{riskPoints ?? '—'} pts</span></span>
                  <span>Target: <span className="text-[#2DD4BF]">+{rewardPoints ?? '—'} pts</span> · R:R <span className="text-white">{rr ?? '—'}</span></span>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}