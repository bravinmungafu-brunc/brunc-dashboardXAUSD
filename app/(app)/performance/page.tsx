'use client'
import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabaseClient'

export default function PerformancePage() {
  const [signals, setSignals] = useState<any[]>([])

  useEffect(() => {
    async function load() {
      const { data } = await supabase.from('signals').select('*').order('created_at', { ascending: true })
      setSignals(data || [])
    }
    load()
  }, [])

  const closed = signals.filter(s => s.status === 'closed')
  const wins = closed.filter(s => s.final_outcome && s.final_outcome !== 'stopped_out').length
  const losses = closed.length - wins
  const successRate = closed.length > 0 ? ((wins / closed.length) * 100).toFixed(1) : null

  const byTier = [
    { label: 'Precision entries', group: closed.filter(s => s.tier === 1) },
    { label: 'Fade entries', group: closed.filter(s => s.tier !== 1) },
  ].map(g => ({
    label: g.label,
    pct: g.group.length ? Math.round((g.group.filter(s => s.final_outcome && s.final_outcome !== 'stopped_out').length / g.group.length) * 100) : null
  }))

  // Performance by Grade — groups resolved signals by grade.value/grade.of
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

  // Performance by Timeframe — hit rate per TP level (TP1=15min, TP2=1H, TP3=4H)
  const byTimeframe = [
    { key: 'tp1_hit', label: 'TP1 · 15min' },
    { key: 'tp2_hit', label: 'TP2 · 1H' },
    { key: 'tp3_hit', label: 'TP3 · 4H' },
  ].map(tp => {
    const tracked = closed.filter(s => s[tp.key] !== undefined && s[tp.key] !== null)
    const hit = tracked.filter(s => s[tp.key] === true).length
    return { label: tp.label, count: tracked.length, pct: tracked.length ? Math.round((hit / tracked.length) * 100) : null }
  })

  return (
    <div className="p-6 md:p-8">
      <div className="mb-6">
        <h1 className="text-3xl font-bold text-white">Performance <span className="text-[#3A434D] font-medium">— success rate &amp; analytics</span></h1>
        <div className="font-mono text-xs text-[#7C8896] mt-2">Track record across every precision and fade signal logged since engine start</div>
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
          <div className="text-center"><div className="text-white text-xl font-bold">—</div><div className="text-[9px] text-[#7C8896] uppercase mt-1">Net Points</div></div>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
        <div className="bg-[#0B0F14] border border-[#1B232C] rounded-xl p-6">
          <div className="font-mono text-[11px] tracking-widest text-[#7C8896] uppercase mb-4">By Signal Type</div>
          {byTier.map((t, i) => (
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
          {['Asian','London','New York'].map((s, i) => (
            <div key={i} className="flex items-center gap-3 mb-3 font-mono text-xs">
              <span className="w-16 text-[#7C8896]">{s.toUpperCase()}</span>
              <div className="flex-1 h-3.5 bg-[#0F141A] rounded overflow-hidden flex">
                <div className="h-full bg-[#34D399]" style={{ width: '0%' }} />
                <div className="h-full bg-[#F87171]" style={{ width: '0%' }} />
              </div>
              <span className="w-10 text-right text-[#7C8896]">—</span>
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
        {byTimeframe.every(t => t.count === 0) ? (
          <div className="text-[#7C8896] font-mono text-sm">No TP-level outcome data yet — populates once the closed-signal analysis job runs.</div>
        ) : (
          byTimeframe.map((t, i) => (
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