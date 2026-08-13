// app/(app)/performance/page.tsx
'use client'
import { useEffect, useState, useCallback } from 'react'
import { supabase } from '@/lib/supabaseClient'

const POINT_SIZE = 0.01

function pointsBetween(a: number, b: number) {
  return Math.round(Math.abs(a - b) / POINT_SIZE)
}

// Approximation: for tp_hit outcomes, uses the furthest TP marked hit
// (TP3 > TP2 > TP1) as the reference exit price. Since resolution is a
// live spot-price snapshot (not full history), this is the most accurate
// read available, not a precise recorded fill price.
function netPointsForSignal(sig: any): number {
  const entry = sig.entry
  const exits = sig.exits || {}
  if (entry == null) return 0

  if (sig.final_outcome === 'stopped_out' && exits.sl != null) {
    return -pointsBetween(entry, exits.sl)
  }
  if (sig.final_outcome === 'tp_hit') {
    const exitPrice = sig.tp3_hit ? exits.tp3 : sig.tp2_hit ? exits.tp2 : sig.tp1_hit ? exits.tp1 : null
    if (exitPrice != null) return pointsBetween(entry, exitPrice)
  }
  return 0
}

// Same tier chain as the Signals page -- low -> high box tiers Pine
// anchors SL/TP against via htf_rung.
const TIER_CHAIN = ['3', '5', '15', '60', '240', 'D', 'W', 'M', '12M']
const TIER_LABELS: Record<string, string> = {
  '3': '3min', '5': '5min', '15': '15min', '60': '1H', '240': '4H',
  'D': 'Daily', 'W': 'Weekly', 'M': 'Monthly', '12M': 'Year',
}

const TYPE_LABEL: Record<string, string> = {
  fade: 'Fade entries',
  sniper_fade: 'Fade entries',
  sniper_confirmation: 'Sniper confirmation entries',
  precision: 'Precision entries',
  directional_ride: 'Directional ride entries',
}

// Real FX session windows in UTC: London 08:00-17:00, NY 13:00-22:00.
// The 13:00-17:00 intersection is its own "Overlap" bucket rather than
// being silently absorbed into either session (previous version's
// boundaries didn't match this at all).
function sessionForDate(dateStr: string) {
  const h = new Date(dateStr).getUTCHours()
  const inLondon = h >= 8 && h < 17
  const inNewYork = h >= 13 && h < 22
  if (inLondon && inNewYork) return 'Overlap'
  if (inLondon) return 'London'
  if (inNewYork) return 'New York'
  return 'Asian'
}

const SESSION_ORDER = ['Asian', 'London', 'New York', 'Overlap']

export default function PerformancePage() {
  const [signals, setSignals] = useState<any[]>([])

  const load = useCallback(async () => {
    const { data } = await supabase.from('signals').select('*').order('created_at', { ascending: true })
    setSignals(data || [])
  }, [])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load()
    const channel = supabase.channel('performance-live')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'signals' }, load)
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [load])

  const closed = signals.filter(s => s.status === 'closed')
  const wins = closed.filter(s => s.final_outcome && s.final_outcome !== 'stopped_out').length
  const losses = closed.length - wins
  const successRate = closed.length > 0 ? ((wins / closed.length) * 100).toFixed(1) : null
  const netPoints = closed.reduce((sum, s) => sum + netPointsForSignal(s), 0)

  // One row per signal_type actually present in closed signals -- no
  // longer a fixed precision-vs-everything-else split that lumped
  // sniper_confirmation and directional_ride in with fade.
  const byTier = (() => {
    const types = Array.from(new Set(closed.map(s => s.signal_type).filter(Boolean)))
    return types.map(t => {
      const group = closed.filter(s => s.signal_type === t)
      const g = group.filter(s => s.final_outcome && s.final_outcome !== 'stopped_out').length
      return {
        label: TYPE_LABEL[t as string] || (t as string).replace(/_/g, ' '),
        pct: group.length ? Math.round((g / group.length) * 100) : null,
      }
    })
  })()

  const byGrade = (() => {
    const map = new Map<string, any[]>()
    closed.forEach(s => {
      const gv = s.grade?.value
      if (gv === undefined || gv === null) return
      const key = `${gv}/${s.grade?.of ?? 7}`
      if (!map.has(key)) map.set(key, [])
      map.get(key)!.push(s)
    })
    return Array.from(map.entries())
      .map(([label, group]) => ({
        label,
        count: group.length,
        pct: group.length ? Math.round((group.filter(s => s.final_outcome && s.final_outcome !== 'stopped_out').length / group.length) * 100) : null
      }))
      .sort((a, b) => b.label.localeCompare(a.label))
  })()

  // Grouped by the actual htf_rung tier that anchored each signal's
  // SL/TP, not a fixed 15min/1H/4H assumption -- mirrors the Signals
  // page's per-signal timeframe labels from fix #1.
  const byRung = (() => {
    const present = TIER_CHAIN.filter(tier => closed.some(s => s.htf_rung === tier))
    return present.map(tier => {
      const group = closed.filter(s => s.htf_rung === tier)
      const g = group.filter(s => s.final_outcome && s.final_outcome !== 'stopped_out').length
      return {
        label: TIER_LABELS[tier] || tier,
        count: group.length,
        pct: group.length ? Math.round((g / group.length) * 100) : null,
      }
    })
  })()

  const bySession = SESSION_ORDER.map(name => {
    const group = closed.filter(sig => sessionForDate(sig.created_at) === name)
    const sWins = group.filter(sig => sig.final_outcome && sig.final_outcome !== 'stopped_out').length
    const winPct = group.length ? Math.round((sWins / group.length) * 100) : 0
    const lossPct = group.length ? 100 - winPct : 0
    return { name, count: group.length, winPct, lossPct }
  })

  return (
    <div className="p-6 md:p-8">
      <div className="mb-6">
        <h1 className="text-3xl font-bold text-white">Performance <span className="text-[#3A434D] font-medium">— success rate &amp; analytics</span></h1>
        <div className="font-mono text-xs text-[#7C8896] mt-2">Track record across every signal logged since engine start</div>
      </div>

      <div className="bg-[#0B0F14] border border-[#1B232C] rounded-xl p-6 mb-5 flex flex-wrap items-center justify-between gap-6">
        <div className="flex items-center gap-5">
          <svg width="90" height="90" viewBox="0 0 90 90">
            <circle cx="45" cy="45" r="38" fill="none" stroke="#141A21" strokeWidth="9" />
            <circle cx="45" cy="45" r="38" fill="none" stroke="#34D399" strokeWidth="9"
              strokeDasharray={`${closed.length ? (wins/closed.length)*238.7 : 0} 238.7`} strokeLinecap="round" transform="rotate(-90 45 45)" />
          </svg>
          <div>
            <div className="text-3xl font-bold text-[#34D399]">{successRate !== null ? successRate + '%' : '—'}</div>
            <div className="font-mono text-[11px] text-[#7C8896]">{closed.length} signals tracked · {wins} successful</div>
          </div>
        </div>
        <div className="flex gap-8 font-mono text-sm">
          <div className="text-center"><div className="text-[#34D399] text-xl font-bold">{wins}</div><div className="text-[9px] text-[#7C8896] uppercase mt-1">Wins</div></div>
          <div className="text-center"><div className="text-[#F87171] text-xl font-bold">{losses}</div><div className="text-[9px] text-[#7C8896] uppercase mt-1">Losses</div></div>
          <div className="text-center">
            <div className={`text-xl font-bold ${netPoints > 0 ? 'text-[#34D399]' : netPoints < 0 ? 'text-[#F87171]' : 'text-white'}`}>
              {closed.length === 0 ? '—' : (netPoints > 0 ? '+' : '') + netPoints}
            </div>
            <div className="text-[9px] text-[#7C8896] uppercase mt-1">Net Points</div>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
        <div className="bg-[#0B0F14] border border-[#1B232C] rounded-xl p-6">
          <div className="font-mono text-[11px] tracking-widest text-[#7C8896] uppercase mb-4">By Signal Type</div>
          {byTier.length === 0 ? (
            <div className="text-[#7C8896] font-mono text-sm">No closed signals yet.</div>
          ) : byTier.map((t, i) => (
            <div key={i} className="mb-4">
              <div className="flex justify-between font-mono text-sm mb-1.5">
                <span className="text-[#EDEFF2]">{t.label}</span><span className="text-white">{t.pct !== null ? t.pct + '%' : '—'}</span>
              </div>
              <div className="h-2 bg-[#0F141A] rounded-full overflow-hidden">
                <div className="h-full bg-[#2DD4BF]" style={{ width: `${t.pct ?? 0}%` }} />
              </div>
            </div>
          ))}
        </div>

        <div className="bg-[#0B0F14] border border-[#1B232C] rounded-xl p-6">
          <div className="font-mono text-[11px] tracking-widest text-[#7C8896] uppercase mb-4">By Session</div>
          {bySession.map((s, i) => (
            <div key={i} className="flex items-center gap-3 mb-3 font-mono text-xs">
              <span className="w-16 text-[#7C8896]">{s.name.toUpperCase()}</span>
              <div className="flex-1 h-3.5 bg-[#0F141A] rounded overflow-hidden flex">
                <div className="h-full bg-[#34D399]" style={{ width: `${s.winPct}%` }} />
                <div className="h-full bg-[#F87171]" style={{ width: `${s.lossPct}%` }} />
              </div>
              <span className="w-16 text-right text-[#7C8896]">{s.count ? `${s.winPct}% · ${s.count}` : '—'}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="bg-[#0B0F14] border border-[#1B232C] rounded-xl p-6 mt-5">
        <div className="font-mono text-[11px] tracking-widest text-[#7C8896] uppercase mb-4">Performance by Grade</div>
        {byGrade.length === 0 ? (
          <div className="text-[#7C8896] font-mono text-sm">No graded signals resolved yet — populates once closed signals carry a grade score.</div>
        ) : (
          byGrade.map((g, i) => (
            <div key={i} className="mb-4">
              <div className="flex justify-between font-mono text-sm mb-1.5">
                <span className="text-[#EDEFF2]">Grade {g.label} <span className="text-[#3A434D]">· {g.count} signals</span></span>
                <span className="text-white">{g.pct !== null ? g.pct + '%' : '—'}</span>
              </div>
              <div className="h-2 bg-[#0F141A] rounded-full overflow-hidden">
                <div className="h-full bg-[#2DD4BF]" style={{ width: `${g.pct ?? 0}%` }} />
              </div>
            </div>
          ))
        )}
      </div>

      <div className="bg-[#0B0F14] border border-[#1B232C] rounded-xl p-6 mt-5">
        <div className="font-mono text-[11px] tracking-widest text-[#7C8896] uppercase mb-4">Performance by Timeframe — HTF Confluence</div>
        {byRung.length === 0 ? (
          <div className="text-[#7C8896] font-mono text-sm">No TP-level outcome data yet — populates once the closed-signal analysis job runs.</div>
        ) : (
          byRung.map((t, i) => (
            <div key={i} className="mb-4">
              <div className="flex justify-between font-mono text-sm mb-1.5">
                <span className="text-[#EDEFF2]">{t.label} <span className="text-[#3A434D]">· {t.count} tracked</span></span>
                <span className="text-white">{t.pct !== null ? t.pct + '%' : '—'}</span>
              </div>
              <div className="h-2 bg-[#0F141A] rounded-full overflow-hidden">
                <div className="h-full bg-[#34D399]" style={{ width: `${t.pct ?? 0}%` }} />
              </div>
            </div>
          ))
        )}
      </div>

      {closed.length === 0 && (
        <div className="mt-5 text-[#7C8896] font-mono text-sm">No resolved signals yet — this fills in once the outcome-resolution job is running.</div>
      )}
    </div>
  )
}