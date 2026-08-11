'use client'
import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabaseClient'

const POINT_SIZE = 0.01
function pointsBetween(a: number, b: number) {
  return Math.round(Math.abs(a - b) / POINT_SIZE)
}

function getExits(sig: any) {
  const sl = sig.exits?.sl ?? null
  const tp1 = sig.exits?.tp1 ?? null
  const tp2 = sig.exits?.tp2 ?? null
  const tp3 = sig.exits?.tp3 ?? null
  const entry = sig.entry ?? null
  return { sl, tp1, tp2, tp3, entry }
}

// Prefers Pine's own computed risk object. Math.abs() guards against
// newer payloads sending a negative sl_distance for certain setups
// (e.g. directional_ride) — distance is always displayed as a positive
// magnitude regardless of the sign Pine sends.
function getRiskReward(sig: any, entry: number | null, sl: number | null, tp1: number | null) {
  if (sig.risk?.sl_distance != null && sig.risk?.tp1_distance != null) {
    return {
      riskPoints: Math.round(Math.abs(sig.risk.sl_distance) / POINT_SIZE),
      rewardPoints: Math.round(Math.abs(sig.risk.tp1_distance) / POINT_SIZE),
      rr: sig.risk.tp1_rr != null ? Math.abs(sig.risk.tp1_rr).toFixed(2) : null,
    }
  }
  if (entry == null || sl == null || tp1 == null) return { riskPoints: null, rewardPoints: null, rr: null }
  const riskPoints = pointsBetween(entry, sl)
  const rewardPoints = pointsBetween(entry, tp1)
  const rr = riskPoints > 0 ? (rewardPoints / riskPoints).toFixed(2) : null
  return { riskPoints, rewardPoints, rr }
}

const TYPE_LABEL: Record<string, string> = {
  fade: 'FADE',
  sniper_fade: 'FADE',
  sniper_confirmation: 'SNIPER CONFIRMATION',
  precision: 'PRECISION',
  directional_ride: 'DIRECTIONAL RIDE',
}

function formatKenyaTime(iso: string) {
  try {
    return new Intl.DateTimeFormat('en-KE', {
      timeZone: 'Africa/Nairobi',
      day: '2-digit',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(new Date(iso)) + ' EAT'
  } catch {
    return '—'
  }
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
    if (filter === 'precision') return s.signal_type === 'precision'
    if (filter === 'fade') return s.signal_type === 'fade' || s.signal_type === 'sniper_fade'
    if (filter === 'directional') return s.signal_type === 'directional_ride'
    if (filter === 'open') return s.status === 'open'
    if (filter === 'closed') return s.status === 'closed'
    return true
  })

  return (
    <div className="p-6 md:p-8">
      <div className="mb-6">
        <h1 className="text-3xl font-bold text-white">Signals <span className="text-[#3A434D] font-medium">— entry, SL, TP &amp; outcome</span></h1>
        <div className="font-mono text-xs text-[#7C8896] mt-2">Precision entries confirm CSOD+BOS inside an open window · fade entries fire live off the exec box</div>
      </div>

      <div className="flex gap-2 mb-6 flex-wrap">
        {['all','sniper_confirmation','precision','fade','directional','open','closed'].map(f => (
          <button key={f} onClick={() => setFilter(f)}
            className={`font-mono text-[11px] uppercase tracking-wide px-4 py-1.5 rounded ${
              filter === f ? 'bg-[#14625A]/40 text-[#2DD4BF] border border-[#2DD4BF]' : 'border border-[#1B232C] text-[#7C8896]'
            }`}>{f === 'sniper_confirmation' ? 'SNIPER CONFIRMATION' : f === 'directional' ? 'DIRECTIONAL RIDE' : f}</button>
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
            const { riskPoints, rewardPoints, rr } = getRiskReward(sig, entry, sl, tp1)
            const tierLabel = TYPE_LABEL[sig.signal_type] || sig.signal_type?.replace(/_/g, ' ').toUpperCase() || '—'
            const gradeValue = sig.grade?.value ?? null
            const gradeOf = sig.grade?.of ?? null
            const isClosed = sig.status === 'closed'
            const isWin = sig.final_outcome === 'tp_hit'
            const regime = sig.regime

            return (
              <div key={sig.id} className={`bg-[#0B0F14] border-l-2 ${isClosed ? (isWin ? 'border-l-[#2B8CE0]' : 'border-l-[#F87171]') : 'border-l-[#2DD4BF]'} border-y border-r border-[#1B232C] rounded-xl p-5`}>
                <div className="flex justify-between items-center mb-4 flex-wrap gap-2">
                  <span className="font-bold text-white text-base flex items-center gap-2 flex-wrap">
                    {(sig.direction === 'long' || sig.direction === 'buy') ? <span className="text-[#34D399]">▲</span> : <span className="text-[#F87171]">▼</span>}
                    {sig.direction?.toUpperCase()} {sig.symbol}
                    <span className="font-mono text-[10px] px-2 py-0.5 rounded border border-[#2DD4BF] text-[#2DD4BF]">{tierLabel}</span>
                    {sig.path && (
                      <span className="font-mono text-[10px] px-2 py-0.5 rounded border border-[#3A434D] text-[#3A434D]">{sig.path}</span>
                    )}
                    {sig.htf_rung && (
                      <span className="font-mono text-[10px] px-2 py-0.5 rounded border border-[#3A434D] text-[#7C8896]">rung {sig.htf_rung}</span>
                    )}
                    {regime?.mode && (
                      <span className={`font-mono text-[10px] px-2 py-0.5 rounded border ${
                        regime.mode === 'directional' ? 'border-[#F5A623] text-[#F5A623]' : 'border-[#7C8896] text-[#7C8896]'
                      }`}>
                        {regime.mode}{regime.direction ? ` · ${regime.direction}` : ''}
                      </span>
                    )}
                    {gradeValue !== null && (
                      <span className="font-mono text-[10px] px-2 py-0.5 rounded border border-[#7C8896] text-[#7C8896]">
                        GRADE {gradeValue}/{gradeOf}
                      </span>
                    )}
                  </span>
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-[10px] text-[#7C8896]">{formatKenyaTime(sig.created_at)}</span>
                    <span className={`font-mono text-[10px] px-2.5 py-1 rounded ${
                      !isClosed ? 'bg-[#14625A]/30 text-[#2DD4BF]' : isWin ? 'bg-[#2B8CE0]/15 text-[#2B8CE0]' : 'bg-[#F87171]/15 text-[#F87171]'
                    }`}>
                      {!isClosed ? 'OPEN' : (sig.final_outcome || 'CLOSED').replace(/_/g, ' ').toUpperCase()}
                    </span>
                  </div>
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
                    <div className="text-[9px] text-[#7C8896] uppercase tracking-wide mb-1 font-mono">
                      TP1 <span className="text-[#3A434D]">· 15min</span>
                      {sig.tp1_hit && <span className="text-[#2B8CE0]"> ✓</span>}
                    </div>
                    <div className="text-[#34D399] font-mono text-sm">{tp1 ?? '—'}</div>
                  </div>
                  <div className="bg-[#0F141A] rounded-lg p-2.5">
                    <div className="text-[9px] text-[#7C8896] uppercase tracking-wide mb-1 font-mono">
                      TP2 <span className="text-[#3A434D]">· 1H</span>
                      {sig.tp2_hit && <span className="text-[#2B8CE0]"> ✓</span>}
                    </div>
                    <div className="text-[#34D399] font-mono text-sm">{tp2 ?? '—'}</div>
                  </div>
                  <div className="bg-[#0F141A] rounded-lg p-2.5">
                    <div className="text-[9px] text-[#7C8896] uppercase tracking-wide mb-1 font-mono">
                      TP3 <span className="text-[#3A434D]">· 4H</span>
                      {sig.tp3_hit && <span className="text-[#2B8CE0]"> ✓</span>}
                    </div>
                    <div className="text-[#34D399] font-mono text-sm">{tp3 ?? '—'}</div>
                  </div>
                </div>

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