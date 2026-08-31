'use client'
import { useEffect, useState, useCallback } from 'react'
import { supabase } from '@/lib/supabaseClient'

interface NewsEvent {
  time: string
  currency: string
  event: string
  impact: string
}

interface NewsSignal {
  rowId: number
  signal_id: string
  symbol: string
  direction: 'buy' | 'sell'
  entry: number | null
  sl: number | null
  tp: number | null
  created_at: string
  triggering_event: string
  news_summary: string
  verdict: 'valid' | 'invalid'
  llm_entry: number | null
  llm_sl: number | null
  llm_tp: number | null
  reasoning: string
  resolution: 'open' | 'successful' | 'unsuccessful'
}

function formatKenyaTime(iso: string) {
  try {
    return new Intl.DateTimeFormat('en-KE', {
      timeZone: 'Africa/Nairobi', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(new Date(iso)) + ' EAT'
  } catch { return '—' }
}

export default function NewsSignalsPage() {
  const [activeEvent, setActiveEvent] = useState<{ label: string; time: string } | null>(null)
  const [todayEvents, setTodayEvents] = useState<NewsEvent[]>([])
  const [signals, setSignals] = useState<NewsSignal[]>([])

  const checkNewsWindow = useCallback(async () => {
    try {
      const res = await fetch('/api/news-window-status')
      const data = await res.json()
      setActiveEvent(data.active ? { label: data.event.label, time: data.event.time } : null)
    } catch {
      setActiveEvent(null)
    }
  }, [])

  const loadTodayEvents = useCallback(async () => {
    const startOfDay = new Date(); startOfDay.setUTCHours(0, 0, 0, 0)
    const endOfDay = new Date(); endOfDay.setUTCHours(23, 59, 59, 999)
    const { data } = await supabase
      .from('calendar_events')
      .select('event_time, currency, event_name, impact')
      .gte('event_time', startOfDay.toISOString())
      .lte('event_time', endOfDay.toISOString())
      .order('event_time', { ascending: true })

    setTodayEvents(
      (data ?? []).map((e: any) => ({
        time: new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC' }).format(new Date(e.event_time)),
        currency: e.currency ?? '',
        event: e.event_name ?? 'Economic event',
        impact: e.impact ?? 'unknown',
      }))
    )
  }, [])

  const loadSignals = useCallback(async () => {
    const { data: news } = await supabase
      .from('news_signals')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(50)

    if (!news || news.length === 0) {
      setSignals([])
      return
    }

    const signalIds = news.map((n: any) => n.signal_id)
    const { data: originals } = await supabase
      .from('signals')
      .select('signal_id, symbol, entry, exits')
      .in('signal_id', signalIds)

    const originalsById = new Map((originals ?? []).map((o: any) => [o.signal_id, o]))

    const merged: NewsSignal[] = news.map((n: any) => {
      const orig = originalsById.get(n.signal_id)
      const resolution: NewsSignal['resolution'] =
        n.status !== 'closed' ? 'open' : n.final_outcome === 'tp_hit' ? 'successful' : 'unsuccessful'

      return {
        rowId: n.id,
        signal_id: n.signal_id,
        symbol: orig?.symbol ?? 'XAUUSD',
        direction: (n.direction ?? 'buy') as 'buy' | 'sell',
        entry: orig?.entry ?? n.llm_entry,
        sl: orig?.exits?.sl ?? n.llm_sl,
        tp: orig?.exits?.tp ?? null,
        created_at: n.created_at,
        triggering_event: n.triggering_event ?? '',
        news_summary: n.news_summary ?? '',
        verdict: n.verdict,
        llm_entry: n.llm_entry,
        llm_sl: n.llm_sl,
        llm_tp: n.llm_tp,
        reasoning: n.reasoning ?? '',
        resolution,
      }
    })

    setSignals(merged)
  }, [])

  useEffect(() => {
    checkNewsWindow()
    loadTodayEvents()
    loadSignals()

    const interval = setInterval(checkNewsWindow, 60000)
    const channel = supabase.channel('news-signals-live')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'news_signals' }, loadSignals)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'calendar_events' }, loadTodayEvents)
      .subscribe()
    return () => { supabase.removeChannel(channel); clearInterval(interval) }
  }, [checkNewsWindow, loadTodayEvents, loadSignals])

  const resolvedCount = signals.filter(s => s.resolution !== 'open').length
  const successCount = signals.filter(s => s.resolution === 'successful').length

  return (
    <div className="p-6 md:p-8">
      <div className="mb-6">
        <h1 className="text-3xl font-bold text-white">News Signals <span className="text-[#3A434D] font-medium">— analysed against live news &amp; calendar</span></h1>
        <div className="font-mono text-xs text-[#7C8896] mt-2">
          Only populates during scheduled high-impact news windows. When active, incoming signals are checked against the calendar event and current gold news before appearing here — news content is weighted primary, technical structure secondary.
        </div>
      </div>

      <div className={`rounded-2xl p-5 mb-6 border flex items-center justify-between flex-wrap gap-3 ${
        activeEvent ? 'bg-[#2B8CE0]/10 border-[#2B8CE0]/40' : 'bg-[#0B0F14] border-[#1B232C]'
      }`}>
        <div className="flex items-center gap-3">
          <span className={`w-3 h-3 rounded-full flex-shrink-0 ${activeEvent ? 'bg-[#2B8CE0] animate-pulse' : 'bg-[#3A434D]'}`} />
          <div>
            <div className={`font-mono text-sm font-bold ${activeEvent ? 'text-[#2B8CE0]' : 'text-[#7C8896]'}`}>
              {activeEvent ? 'NEWS TIME ACTIVE' : 'No news window active'}
            </div>
            {activeEvent && (
              <div className="font-mono text-[11px] text-[#7C8896] mt-0.5">{activeEvent.label}</div>
            )}
          </div>
        </div>
      </div>

      <div className="bg-[#0B0F14] border border-[#1B232C] rounded-xl p-5 mb-6">
        <div className="font-mono text-[10px] tracking-widest text-[#7C8896] uppercase mb-3">Today's high-impact events (cached, UTC)</div>
        {todayEvents.length === 0 ? (
          <div className="font-mono text-[11px] text-[#7C8896]">No cached events yet — waiting on the daily calendar fetch.</div>
        ) : (
          <div className="space-y-2">
            {todayEvents.map((e, i) => (
              <div key={i} className="flex items-center justify-between font-mono text-xs">
                <span className="text-[#EDEFF2]">{e.time} — {e.currency} {e.event}</span>
                <span className={`px-2 py-0.5 rounded text-[10px] ${e.impact.toLowerCase().includes('high') ? 'text-[#F87171] bg-[#F87171]/10' : 'text-[#F5A623] bg-[#F5A623]/10'}`}>
                  {e.impact.toUpperCase()}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {signals.length === 0 ? (
        <div className="bg-[#0B0F14] border border-[#1B232C] border-dashed rounded-2xl p-10 text-center mb-8">
          <div className="mono text-[11px] text-[#7C8896]">
            {activeEvent ? "News window is active, but no signal has fired yet during it." : "Signals only appear here during an active news window — check back closer to a scheduled event."}
          </div>
        </div>
      ) : (
        <div className="space-y-4 mb-8">
          {signals.map(sig => {
            const isValid = sig.verdict === 'valid'
            return (
              <div key={sig.rowId} className="bg-[#0B0F14] border border-[#2B8CE0]/30 rounded-xl overflow-hidden">
                <div className="p-5 flex justify-between items-start flex-wrap gap-3 border-b border-[#1B232C]">
                  <div>
                    <span className="font-bold text-white text-base flex items-center gap-2 flex-wrap">
                      {sig.direction === 'buy' ? <span className="text-[#34D399]">▲</span> : <span className="text-[#F87171]">▼</span>}
                      {sig.direction.toUpperCase()} {sig.symbol}
                      <span className="font-mono text-[10px] px-2 py-0.5 rounded border border-[#2B8CE0] text-[#2B8CE0]">
                        NEWS WINDOW
                      </span>
                    </span>
                    <div className="font-mono text-[10px] text-[#7C8896] mt-1.5">{formatKenyaTime(sig.created_at)} · {sig.triggering_event}</div>
                  </div>
                  <div className="font-mono text-xs text-[#7C8896] text-right">
                    <div>Entry <span className="text-white">{sig.entry?.toFixed(3) ?? '—'}</span></div>
                    <div>SL <span className="text-[#F87171]">{sig.sl?.toFixed(3) ?? '—'}</span> · TP <span className="text-[#34D399]">{sig.tp?.toFixed(3) ?? '—'}</span></div>
                  </div>
                </div>

                <div className="p-5 bg-[#0F141A]">
                  {sig.news_summary && (
                    <>
                      <div className="font-mono text-[9px] text-[#7C8896] uppercase tracking-wide mb-1.5">What's happening</div>
                      <div className="text-sm text-[#EDEFF2] leading-relaxed mb-4 pb-4 border-b border-[#1B232C]">{sig.news_summary}</div>
                    </>
                  )}

                  <div className="flex items-center justify-between mb-3">
                    <span className="font-mono text-[10px] tracking-widest text-[#7C8896] uppercase">Verdict</span>
                    <span className={`font-mono text-[10px] px-3 py-1 rounded border ${isValid ? 'text-[#2DD4BF] border-[#2DD4BF]' : 'text-[#F87171] border-[#F87171]'}`}>
                      {isValid ? 'VALID' : 'INVALID'}
                    </span>
                  </div>
                  <div className="text-sm text-[#EDEFF2] leading-relaxed">{sig.reasoning}</div>

                  {!isValid && sig.llm_entry != null && (
                    <div className="grid grid-cols-3 gap-2.5 mt-3 pt-3 border-t border-[#1B232C]">
                      <div className="bg-[#0B0F14] rounded-lg p-2.5">
                        <div className="text-[9px] text-[#7C8896] uppercase tracking-wide mb-1 font-mono">Preferred entry</div>
                        <div className="text-white font-mono text-sm">{sig.llm_entry.toFixed(3)}</div>
                      </div>
                      <div className="bg-[#0B0F14] rounded-lg p-2.5">
                        <div className="text-[9px] text-[#7C8896] uppercase tracking-wide mb-1 font-mono">Preferred SL</div>
                        <div className="text-[#F87171] font-mono text-sm">{sig.llm_sl?.toFixed(3)}</div>
                      </div>
                      <div className="bg-[#0B0F14] rounded-lg p-2.5">
                        <div className="text-[9px] text-[#7C8896] uppercase tracking-wide mb-1 font-mono">Preferred TP</div>
                        <div className="text-[#34D399] font-mono text-sm">{sig.llm_tp?.toFixed(3)}</div>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}

      <div className="pt-6 border-t border-[#1B232C]">
        <div className="mb-3">
          <div className="font-mono text-[10px] tracking-[0.3em] text-[#F5A623] uppercase mb-1">Deterministic, Not AI-Generated</div>
          <h2 className="text-lg font-bold text-white">
            News Signals — Resolved <span className="text-[#7C8896] font-normal text-sm ml-2">— checked against real price data automatically</span>
          </h2>
        </div>
        <div className="font-mono text-[10px] text-[#7C8896] mb-4">
          {resolvedCount} of {signals.length} news signals resolved so far — {successCount} successful.
        </div>
        <details className="bg-[#0B0F14] border border-[#1B232C] rounded-xl">
          <summary className="cursor-pointer px-5 py-3.5 font-mono text-xs text-[#2DD4BF] uppercase tracking-wide">
            Show all resolved news signals ({resolvedCount})
          </summary>
          <div className="px-5 pb-4 space-y-1.5">
            {signals.filter(s => s.resolution !== 'open').length === 0 ? (
              <div className="font-mono text-[11px] text-[#7C8896] py-2">No news signals resolved yet.</div>
            ) : signals.filter(s => s.resolution !== 'open').map(s => (
              <div key={s.rowId} className="font-mono text-[11px] flex justify-between items-center py-1.5 border-t border-[#1B232C] first:border-t-0">
                <span className="text-[#EDEFF2]">{s.signal_id}</span>
                <span className={`px-2 py-0.5 rounded ${s.resolution === 'successful' ? 'text-[#2B8CE0] bg-[#2B8CE0]/15' : 'text-[#F87171] bg-[#F87171]/15'}`}>
                  {s.resolution.toUpperCase()}
                </span>
              </div>
            ))}
          </div>
        </details>
      </div>
    </div>
  )
}