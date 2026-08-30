'use client'
import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabaseClient'

const POINT_SIZE = 0.01
function pointsBetween(a: number, b: number) {
  return Math.round(Math.abs(a - b) / POINT_SIZE)
}

const TIER_CHAIN = ['15', '60', '240', 'D', 'W', 'M', '12M']
const TIER_LABELS: Record<string, string> = {
  '15': '15min', '60': '1H', '240': '4H',
  'D': 'Daily', 'W': 'Weekly', 'M': 'Monthly', '12M': 'Year',
}

const PATH_LABELS: Record<string, string> = {
  setup_a: 'Setup A',
  setup_b: 'Setup B',
}

const GRADE_BASIS_LABELS: Record<string, string> = {
  perfect_cycle_alignment: '15m cycle return + HTF mid-rejection (Precision)',
  premium_fade_alignment: 'CSOD + BOS confirmation (Setup A)',
  displacement_day_alignment: 'Displaced breakout + pullback + realignment (Setup B)',
}

const MANUAL_FILTER_LABELS: { key: string; label: string }[] = [
  { key: 'bias_1h', label: '1H directional bias' },
  { key: 'zone_tapped', label: 'Order block zone tapped' },
  { key: 'discount_premium', label: 'Fibonacci discount/premium' },
  { key: 'session_open', label: 'London/NY session open' },
  { key: 'doji_or_rejection', label: '1m doji or rejection candle' },
]

function getExits(sig: any) {
  const sl = sig.exits?.sl ?? null
  const tp = sig.exits?.tp ?? null
  const entry = sig.entry ?? null
  return { sl, tp, entry }
}

function getRiskReward(sig: any, entry: number | null, sl: number | null, tp: number | null) {
  if (sig.risk?.sl_distance != null && sig.risk?.tp_distance != null) {
    return {
      riskPoints: Math.round(Math.abs(sig.risk.sl_distance) / POINT_SIZE),
      rewardPoints: Math.round(Math.abs(sig.risk.tp_distance) / POINT_SIZE),
      rr: sig.risk.tp_rr != null ? Math.abs(sig.risk.tp_rr).toFixed(2) : null,
    }
  }
  if (entry == null || sl == null || tp == null) return { riskPoints: null, rewardPoints: null, rr: null }
  const riskPoints = pointsBetween(entry, sl)
  const rewardPoints = pointsBetween(entry, tp)
  const rr = riskPoints > 0 ? (rewardPoints / riskPoints).toFixed(2) : null
  return { riskPoints, rewardPoints, rr }
}

const TYPE_LABEL: Record<string, string> = {
  sniper_confirmation: 'SNIPER CONFIRMATION',
  precision: 'PRECISION',
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
  const [expanded, setExpanded] = useState<Set<number>>(new Set())

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

  function toggleExpanded(id: number) {
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const filtered = signals.filter(s => {
    if (filter === 'all') return true
    if (filter === 'sniper_confirmation') return s.signal_type === 'sniper_confirmation'
    if (filter === 'precision') return s.signal_type === 'precision'
    if (filter === 'open') return s.status === 'open'
    if (filter === 'closed') return s.status === 'closed'
    return true
  })

  return (
    <div className="p-6 md:p-8">
      <div className="mb-6">
        <h1 className="text-3xl font-bold text-white">Signals <span className="text-[#3A434D] font-medium">— entry, SL, TP &amp; outcome</span></h1>
        <div className="font-mono text-xs text-[#7C8896] mt-2">
          Precision entries confirm a 15m cycle return with HTF mid-rejection · Sniper Confirmation entries confirm CSOD+BOS (Setup A) or a displacement-day realignment (Setup B)
        </div>
      </div>

      <div className="flex gap-2 mb-6 flex-wrap">
        {['all','sniper_confirmation','precision','open','closed'].map(f => (
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
            const { sl, tp, entry } = getExits(sig)
            const { riskPoints, rewardPoints, rr } = getRiskReward(sig, entry, sl, tp)
            const tierLabel = TYPE_LABEL[sig.signal_type] || sig.signal_type?.replace(/_/g, ' ').toUpperCase() || '—'
            const pathLabel = sig.path ? (PATH_LABELS[sig.path] ?? sig.path) : null
            const gradeValue = sig.grade?.value ?? null
            const gradeOf = sig.grade?.of ?? null
            const gradeBasisLabel = sig.grade?.basis ? (GRADE_BASIS_LABELS[sig.grade.basis] ?? sig.grade.basis) : null
            const isClosed = sig.status === 'closed'
            const isWin = sig.final_outcome === 'tp_hit'
            const isExpanded = expanded.has(sig.id)
            const manualFilter = sig.manual_entry_filter
            const manualApplicable = manualFilter?.applicable === true

            return (
              <div key={sig.id} className={`bg-[#0B0F14] border-l-2 ${isClosed ? (isWin ? 'border-l-[#2B8CE0]' : 'border-l-[#F87171]') : 'border-l-[#2DD4BF]'} border-y border-r border-[#1B232C] rounded-xl p-5`}>
                <div className="flex justify-between items-center mb-4 flex-wrap gap-2">
                  <span className="font-bold text-white text-base flex items-center gap-2 flex-wrap">
                    {(sig.direction === 'long' || sig.direction === 'buy') ? <span className="text-[#34D399]">▲</span> : <span className="text-[#F87171]">▼</span>}
                    {sig.direction?.toUpperCase()} {sig.symbol}
                    <span className="font-mono text-[10px] px-2 py-0.5 rounded border border-[#2DD4BF] text-[#2DD4BF]">{tierLabel}</span>
                    {pathLabel && (
                      <span className="font-mono text-[10px] px-2 py-0.5 rounded border border-[#3A434D] text-[#3A434D]">{pathLabel}</span>
                    )}
                    {sig.htf_rung && (
                      <span className="font-mono text-[10px] px-2 py-0.5 rounded border border-[#3A434D] text-[#7C8896]">rung {TIER_LABELS[sig.htf_rung] ?? sig.htf_rung}</span>
                    )}
                    {gradeValue !== null && (
                      <span className="font-mono text-[10px] px-2 py-0.5 rounded border border-[#7C8896] text-[#7C8896]">
                        GRADE {gradeValue}/{gradeOf}
                      </span>
                    )}
                  </span>
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-[10px] text-[#7C8896]">{formatKenyaTime(sig.created_at)}</span>
                    <span className={`font-mono text-[10px] px-2.5 py-1 rounded flex items-center gap-1.5 ${
                      !isClosed ? 'bg-[#14625A]/30 text-[#2DD4BF]' : isWin ? 'bg-[#2B8CE0]/15 text-[#2B8CE0]' : 'bg-[#F87171]/15 text-[#F87171]'
                    }`}>
                      {!isClosed && <span className="w-1.5 h-1.5 rounded-full bg-[#2B8CE0] animate-pulse" title="Still open — rechecked automatically every 10 minutes" />}
                      {!isClosed ? 'OPEN' : (sig.final_outcome || 'CLOSED').replace(/_/g, ' ').toUpperCase()}
                    </span>
                  </div>
                </div>

                <div className="grid grid-cols-3 gap-2.5 mb-3">
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
                      TP {sig.tp_hit && <span className="text-[#2B8CE0]"> ✓</span>}
                    </div>
                    <div className="text-[#34D399] font-mono text-sm">{tp ?? '—'}</div>
                  </div>
                </div>

                <div className="flex justify-between items-center font-mono text-[11px] text-[#7C8896] flex-wrap gap-2">
                  <div className="flex gap-4">
                    <span>Risk: <span className="text-[#F87171]">{riskPoints ?? '—'} pts</span></span>
                    <span>Target: <span className="text-[#2DD4BF]">+{rewardPoints ?? '—'} pts</span> · R:R <span className="text-white">{rr ?? '—'}</span></span>
                  </div>
                  <button
                    onClick={() => toggleExpanded(sig.id)}
                    className="text-[#2DD4BF] hover:text-white uppercase tracking-wide text-[10px]"
                  >
                    {isExpanded ? '▲ Hide details' : '▼ Show details'}
                  </button>
                </div>

                {isExpanded && (
                  <div className="mt-4 pt-4 border-t border-[#1B232C] space-y-4">
                    {gradeBasisLabel && (
                      <div>
                        <div className="text-[9px] text-[#7C8896] uppercase tracking-wide mb-1 font-mono">Grade basis</div>
                        <div className="font-mono text-xs text-[#EDEFF2]">{gradeBasisLabel}</div>
                      </div>
                    )}

                    <div>
                      <div className="text-[9px] text-[#7C8896] uppercase tracking-wide mb-2 font-mono">Manual entry filter</div>
                      {!manualFilter ? (
                        <div className="font-mono text-xs text-[#3A434D]">No data recorded for this signal.</div>
                      ) : !manualApplicable ? (
                        <div className="font-mono text-xs text-[#3A434D]">Not applicable — Sniper Confirmation signals don't use the manual entry filter.</div>
                      ) : (
                        <div className="flex flex-wrap gap-x-4 gap-y-1.5">
                          {MANUAL_FILTER_LABELS.map(({ key, label }) => {
                            const passed = manualFilter[key] === true
                            return (
                              <span key={key} className="font-mono text-xs flex items-center gap-1">
                                <span className={passed ? 'text-[#34D399]' : 'text-[#F87171]'}>{passed ? '✓' : '✗'}</span>
                                <span className="text-[#7C8896]">{label}</span>
                              </span>
                            )
                          })}
                        </div>
                      )}
                    </div>

                    {Array.isArray(sig.htf_confluence) && sig.htf_confluence.length > 0 && (
                      <div>
                        <div className="text-[9px] text-[#7C8896] uppercase tracking-wide mb-2 font-mono">HTF confluence</div>
                        <div className="grid grid-cols-4 sm:grid-cols-7 gap-1.5">
                          {sig.htf_confluence.map((tf: any, i: number) => (
                            <div key={i} className="bg-[#0F141A] rounded p-1.5 text-center">
                              <div className="text-[8px] text-[#3A434D] font-mono">{tf.tf}</div>
                              <div className={`text-[10px] font-mono ${tf.state === 'bullish' ? 'text-[#34D399]' : tf.state === 'bearish' ? 'text-[#F87171]' : 'text-[#7C8896]'}`}>
                                {tf.state?.slice(0, 4).toUpperCase() ?? '—'}
                              </div>
                              {tf.fade_active && (
                                <div className="text-[8px] text-[#F59E0B] font-mono">edge·{tf.rejections}</div>
                              )}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {sig.window_info && (
                      <div className="font-mono text-[10px] text-[#7C8896]">
                        Window: upper {sig.window_info.upper_breach_count ?? '—'}/7 ({sig.window_info.upper_open ? 'open' : 'closed'}) ·
                        {' '}lower {sig.window_info.lower_breach_count ?? '—'}/7 ({sig.window_info.lower_open ? 'open' : 'closed'})
                      </div>
                    )}

                    {sig.signal_version && (
                      <div className="font-mono text-[10px] text-[#3A434D]">Pine version: {sig.signal_version}</div>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}