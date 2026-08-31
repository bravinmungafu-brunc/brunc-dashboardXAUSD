'use client'
import { useEffect, useState, useCallback } from 'react'
import { supabase } from '@/lib/supabaseClient'

type Verdict = 'valid' | 'invalid'

interface AnalysedSignal {
  rowId: number
  signal_id: string
  symbol: string
  direction: 'buy' | 'sell'
  signal_type: 'sniper_confirmation' | 'precision'
  path: string | null
  entry: number | null
  sl: number | null
  tp: number | null
  rr: number | null
  created_at: string
  llm_model: string
  verdict: Verdict
  llm_entry: number | null
  llm_sl: number | null
  llm_tp: number | null
  llm_rr: number | null
  reasoning: string
  resolution: 'open' | 'successful' | 'unsuccessful'
}

const OPENROUTER_DAILY_LIMIT = 50 // keep in sync with analyse-signals-route.ts's DAILY_LIMIT

function formatKenyaTime(iso: string) {
  try {
    return new Intl.DateTimeFormat('en-KE', {
      timeZone: 'Africa/Nairobi', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(new Date(iso)) + ' EAT'
  } catch { return '—' }
}

function todayUTC() {
  return new Date().toISOString().slice(0, 10)
}

export default function AnalysedSignalsPage() {
  const [enabled, setEnabled] = useState(true)
  const [loaded, setLoaded] = useState(false)
  const [toggling, setToggling] = useState(false)
  const [signals, setSignals] = useState<AnalysedSignal[]>([])
  const [resolutionFilter, setResolutionFilter] = useState<'all' | 'successful' | 'unsuccessful' | 'open'>('all')
  const [quotaUsed, setQuotaUsed] = useState(0)

  // Real server-side toggle -- was localStorage-only before, which
  // only affected what one browser displayed rather than what the
  // backend actually did. Now reads/writes the real app_settings row
  // via the toggle-analysed-signals API route.
  const loadToggleState = useCallback(async () => {
    try {
      const res = await fetch('/api/settings/toggle-analysed-signals')
      const data = await res.json()
      setEnabled(data.enabled !== false)
    } catch {
      setEnabled(true) // fail open to the default rather than block the page on a network hiccup
    }
    setLoaded(true)
  }, [])

  async function toggleEnabled() {
    const next = !enabled
    setToggling(true)
    setEnabled(next) // optimistic
    try {
      const res = await fetch('/api/settings/toggle-analysed-signals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: next }),
      })
      const data = await res.json()
      if (data.error) {
        setEnabled(!next) // revert on failure
      } else {
        setEnabled(data.enabled)
      }
    } catch {
      setEnabled(!next) // revert on network failure
    }
    setToggling(false)
  }

  const loadQuota = useCallback(async () => {
    const { data } = await supabase
      .from('openrouter_usage')
      .select('count')
      .eq('usage_date', todayUTC())
      .eq('key_name', 'analysed_signals')
      .maybeSingle()
    setQuotaUsed(data?.count ?? 0)
  }, [])

  const loadSignals = useCallback(async () => {
    const { data: analysed } = await supabase
      .from('analysed_signals')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(50)

    if (!analysed || analysed.length === 0) {
      setSignals([])
      return
    }

    const signalIds = analysed.map((a: any) => a.signal_id)
    const { data: originals } = await supabase
      .from('signals')
      .select('signal_id, symbol, direction, signal_type, path, entry, exits, risk, created_at')
      .in('signal_id', signalIds)

    const originalsById = new Map((originals ?? []).map((o: any) => [o.signal_id, o]))

    const merged: AnalysedSignal[] = analysed.map((a: any) => {
      const orig = originalsById.get(a.signal_id)
      const resolution: AnalysedSignal['resolution'] =
        a.status !== 'closed' ? 'open' : a.final_outcome === 'tp_hit' ? 'successful' : 'unsuccessful'

      return {
        rowId: a.id,
        signal_id: a.signal_id,
        symbol: orig?.symbol ?? 'XAUUSD',
        direction: (a.direction ?? orig?.direction ?? 'buy') as 'buy' | 'sell',
        signal_type: orig?.signal_type ?? 'sniper_confirmation',
        path: orig?.path ?? null,
        entry: orig?.entry ?? null,
        sl: orig?.exits?.sl ?? null,
        tp: orig?.exits?.tp ?? null,
        rr: orig?.risk?.tp_rr ?? orig?.exits?.rr_selected ?? null,
        created_at: a.created_at ?? orig?.created_at,
        llm_model: a.llm_model,
        verdict: a.verdict,
        llm_entry: a.llm_entry,
        llm_sl: a.llm_sl,
        llm_tp: a.llm_tp,
        llm_rr: a.llm_rr,
        reasoning: a.reasoning ?? '',
        resolution,
      }
    })

    setSignals(merged)
  }, [])

  useEffect(() => {
    loadToggleState()
    loadQuota()
    loadSignals()

    const channel = supabase.channel('analysed-signals-live')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'analysed_signals' }, () => {
        loadSignals()
        loadQuota()
      })
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [loadToggleState, loadQuota, loadSignals])

  const quotaRemaining = OPENROUTER_DAILY_LIMIT - quotaUsed
  const quotaExhausted = quotaRemaining <= 0

  const filtered = signals.filter(s => resolutionFilter === 'all' || s.resolution === resolutionFilter)
  const resolvedCount = signals.filter(s => s.resolution !== 'open').length
  const successCount = signals.filter(s => s.resolution === 'successful').length

  return (
    <div className="p-6 md:p-8">
      <div className="mb-6">
        <h1 className="text-3xl font-bold text-white">Analysed Signals <span className="text-[#3A434D] font-medium">— every signal, LLM-checked</span></h1>
        <div className="font-mono text-xs text-[#7C8896] mt-2">
          Every signal from the Signals page is automatically sent to one model for a second opinion — valid confirms the strategy's own rules were genuinely met, invalid comes with the model's preferred entry/SL/TP.
        </div>
      </div>

      <div className="bg-[#0B0F14] border border-[#1B232C] rounded-2xl p-4 mb-5 flex items-center justify-between flex-wrap gap-4">
        <div className="flex items-center gap-5 flex-wrap">
          <div>
            <div className="font-mono text-[9px] tracking-widest text-[#7C8896] uppercase">Analysis tokens today</div>
            <div className={`font-mono text-sm font-bold mt-0.5 ${quotaExhausted ? 'text-[#F87171]' : quotaRemaining <= 10 ? 'text-[#F5A623]' : 'text-[#2DD4BF]'}`}>
              {quotaUsed}/{OPENROUTER_DAILY_LIMIT} used
            </div>
          </div>
          <div className="w-px h-8 bg-[#1B232C]" />
          <div>
            <div className="font-mono text-[9px] tracking-widest text-[#7C8896] uppercase">Model</div>
            <div className="font-mono text-sm text-white mt-0.5">Ling 3.0 Flash Fin</div>
          </div>
        </div>
        <button
          onClick={toggleEnabled}
          disabled={!loaded || toggling}
          aria-pressed={enabled}
          className="flex items-center gap-2.5 disabled:opacity-50"
        >
          <span className="font-mono text-[10px] text-[#7C8896] uppercase tracking-wide">
            {enabled ? 'Analysis on' : 'Analysis off'}
          </span>
          <span className={`w-9 h-5 rounded-full relative transition-colors ${enabled ? 'bg-[#2DD4BF]' : 'bg-[#2A333D]'}`}>
            <span className={`w-4 h-4 rounded-full bg-[#05070A] absolute top-0.5 transition-all ${enabled ? 'right-0.5' : 'left-0.5'}`} />
          </span>
        </button>
      </div>

      {!enabled && (
        <div className="bg-[#F5A623]/10 border border-[#F5A623]/25 rounded-2xl px-5 py-4 mono text-xs text-[#F5A623] mb-5">
          Analysed Signals is paused — new signals will keep appearing on the Signals page as normal, but won't be sent for LLM analysis until you turn this back on.
        </div>
      )}
      {enabled && quotaExhausted && (
        <div className="bg-[#F87171]/10 border border-[#F87171]/25 rounded-2xl px-5 py-4 mono text-xs text-[#F87171] mb-5">
          Analysis tokens ended for today — resets at 00:00 UTC. New signals will still appear on the Signals page, just without a verdict until the quota resets.
        </div>
      )}

      <div className="flex gap-2 mb-6 flex-wrap">
        {(['all', 'open', 'successful', 'unsuccessful'] as const).map(f => (
          <button key={f} onClick={() => setResolutionFilter(f)}
            className={`font-mono text-[11px] uppercase tracking-wide px-4 py-1.5 rounded ${
              resolutionFilter === f ? 'bg-[#14625A]/40 text-[#2DD4BF] border border-[#2DD4BF]' : 'border border-[#1B232C] text-[#7C8896]'
            }`}>{f}</button>
        ))}
      </div>

      {filtered.length === 0 ? (
        <div className="bg-[#0B0F14] border border-[#1B232C] border-dashed rounded-2xl p-10 text-center">
          <div className="mono text-[11px] text-[#7C8896]">No analysed signals in this view yet — waiting on live signal feed.</div>
        </div>
      ) : (
        <div className="space-y-4 mb-8">
          {filtered.map(sig => {
            const isValid = sig.verdict === 'valid'
            return (
              <div key={sig.rowId} className="bg-[#0B0F14] border border-[#1B232C] rounded-xl overflow-hidden">
                <div className="p-5 flex justify-between items-start flex-wrap gap-3 border-b border-[#1B232C]">
                  <div>
                    <span className="font-bold text-white text-base flex items-center gap-2 flex-wrap">
                      {sig.direction === 'buy' ? <span className="text-[#34D399]">▲</span> : <span className="text-[#F87171]">▼</span>}
                      {sig.direction.toUpperCase()} {sig.symbol}
                      <span className="font-mono text-[10px] px-2 py-0.5 rounded border border-[#2DD4BF] text-[#2DD4BF]">
                        {sig.signal_type === 'precision' ? 'PRECISION' : 'SNIPER CONFIRMATION'}
                      </span>
                    </span>
                    <div className="font-mono text-[10px] text-[#7C8896] mt-1.5">{formatKenyaTime(sig.created_at)}</div>
                  </div>
                  <div className="font-mono text-xs text-[#7C8896] text-right">
                    <div>Entry <span className="text-white">{sig.entry?.toFixed(3) ?? '—'}</span></div>
                    <div>SL <span className="text-[#F87171]">{sig.sl?.toFixed(3) ?? '—'}</span> · TP <span className="text-[#34D399]">{sig.tp?.toFixed(3) ?? '—'}</span> · R:R <span className="text-white">{sig.rr != null ? '1:' + sig.rr : '—'}</span></div>
                  </div>
                </div>

                <div className="p-5 bg-[#0F141A]">
                  <div className="flex items-center justify-between mb-3">
                    <span className="font-mono text-[10px] tracking-widest text-[#7C8896] uppercase">{sig.llm_model} verdict</span>
                    <span className={`font-mono text-[10px] px-3 py-1 rounded border ${isValid ? 'text-[#2DD4BF] border-[#2DD4BF]' : 'text-[#F87171] border-[#F87171]'}`}>
                      {isValid ? 'VALID' : 'INVALID'}
                    </span>
                  </div>
                  <div className="text-sm text-[#EDEFF2] leading-relaxed mb-3">{sig.reasoning}</div>
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
                        <div className="text-[9px] text-[#7C8896] uppercase tracking-wide mb-1 font-mono">Preferred TP · R:R</div>
                        <div className="text-[#34D399] font-mono text-sm">{sig.llm_tp?.toFixed(3)} · 1:{sig.llm_rr}</div>
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
            LLM-Preferred Levels — Resolved <span className="text-[#7C8896] font-normal text-sm ml-2">— checked against real price data automatically</span>
          </h2>
        </div>
        <div className="font-mono text-[10px] text-[#7C8896] mb-4">
          {resolvedCount} of {signals.length} analysed signals resolved so far — {successCount} successful. Whether an LLM's preferred level actually won or lost is always computed from real market data, never reported by the model itself.
        </div>
        <details className="bg-[#0B0F14] border border-[#1B232C] rounded-xl">
          <summary className="cursor-pointer px-5 py-3.5 font-mono text-xs text-[#2DD4BF] uppercase tracking-wide">
            Show all resolved LLM-preferred levels ({resolvedCount})
          </summary>
          <div className="px-5 pb-4 space-y-1.5">
            {signals.filter(s => s.resolution !== 'open').length === 0 ? (
              <div className="font-mono text-[11px] text-[#7C8896] py-2">Nothing resolved yet.</div>
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