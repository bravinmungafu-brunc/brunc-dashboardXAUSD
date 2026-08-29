'use client'
import { useEffect, useState } from 'react'

// ══════════════════════════════════════════════════════════
// MOCK DATA -- structured exactly like the real Supabase shape
// this page will read once the backend/LLM route exists. Every
// field here maps 1:1 to what the "analysed_signals" table (or
// equivalent join) will actually contain. Swap the two useEffect
// fetch stubs below for real Supabase calls when ready -- nothing
// else in this file needs to change.
// ══════════════════════════════════════════════════════════

type Verdict = 'valid' | 'invalid'

interface AnalysedSignal {
  id: number
  signal_id: string
  symbol: string
  direction: 'buy' | 'sell'
  signal_type: 'sniper_confirmation' | 'precision'
  path: string | null
  entry: number
  sl: number
  tp: number
  rr: number
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

const MOCK_SIGNALS: AnalysedSignal[] = [
  {
    id: 1, signal_id: 'XAUUSD-1m-1756412200-sniper_confirmation-sell', symbol: 'XAUUSD',
    direction: 'sell', signal_type: 'sniper_confirmation', path: 'setup_a',
    entry: 4582.290, sl: 4580.815, tp: 4577.865, rr: 3,
    created_at: new Date(Date.now() - 22 * 60000).toISOString(),
    llm_model: 'Llama 4 Maverick', verdict: 'valid',
    llm_entry: null, llm_sl: null, llm_tp: null, llm_rr: null,
    reasoning: 'CSOD+BOS confirmed with grade 5/7 HTF agreement and genuine 147.5pt structural SL -- consistent with the strategy\'s own confirmation rules.',
    resolution: 'open',
  },
  {
    id: 2, signal_id: 'XAUUSD-3m-1756411800-precision-buy', symbol: 'XAUUSD',
    direction: 'buy', signal_type: 'precision', path: null,
    entry: 4560.120, sl: 4555.940, tp: 4564.300, rr: 2,
    created_at: new Date(Date.now() - 48 * 60000).toISOString(),
    llm_model: 'Llama 4 Maverick', verdict: 'invalid',
    llm_entry: 4560.120, llm_sl: 4558.610, llm_tp: 4566.135, llm_rr: 4,
    reasoning: 'Manual filter shows only 3/5 conditions true (session and doji failing) -- weaker than typical for a Precision fire. A tighter SL at the nearer swing low with a further real structural target gives better R:R for the same setup.',
    resolution: 'unsuccessful',
  },
  {
    id: 3, signal_id: 'XAUUSD-1m-1756410900-sniper_confirmation-sell', symbol: 'XAUUSD',
    direction: 'sell', signal_type: 'sniper_confirmation', path: 'setup_b',
    entry: 4591.640, sl: 4601.640, tp: 4541.640, rr: 5,
    created_at: new Date(Date.now() - 65 * 60000).toISOString(),
    llm_model: 'Llama 4 Maverick', verdict: 'valid',
    llm_entry: null, llm_sl: null, llm_tp: null, llm_rr: null,
    reasoning: 'Realignment sequence intact -- displacement, pullback to midpoint, and fresh confirming CSOD all present as the strategy requires.',
    resolution: 'successful',
  },
]

const STORAGE_TOGGLE_KEY = 'brunc:analysedSignalsEnabled'

function formatKenyaTime(iso: string) {
  try {
    return new Intl.DateTimeFormat('en-KE', {
      timeZone: 'Africa/Nairobi', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(new Date(iso)) + ' EAT'
  } catch { return '—' }
}

export default function AnalysedSignalsPage() {
  const [enabled, setEnabled] = useState(true)
  const [loaded, setLoaded] = useState(false)
  const [signals, setSignals] = useState<AnalysedSignal[]>([])
  const [resolutionFilter, setResolutionFilter] = useState<'all' | 'successful' | 'unsuccessful' | 'open'>('all')

  // Quota -- mock for now. Real version reads a Supabase counter table
  // the same way av_usage already tracks Twelve Data, keyed to this
  // page's dedicated OpenRouter account.
  const [quotaUsed] = useState(14)
  const quotaLimit = 50
  const quotaRemaining = quotaLimit - quotaUsed
  const quotaExhausted = quotaRemaining <= 0

  useEffect(() => {
    const stored = localStorage.getItem(STORAGE_TOGGLE_KEY)
    if (stored !== null) setEnabled(stored === 'true')
    setLoaded(true)
    // TODO: replace with real Supabase fetch + Realtime subscription,
    // same pattern as Signals/Performance pages.
    setSignals(MOCK_SIGNALS)
  }, [])

  function toggleEnabled() {
    setEnabled(prev => {
      const next = !prev
      localStorage.setItem(STORAGE_TOGGLE_KEY, String(next))
      return next
    })
  }

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

      {/* Status bar: quota + toggle */}
      <div className="bg-[#0B0F14] border border-[#1B232C] rounded-2xl p-4 mb-5 flex items-center justify-between flex-wrap gap-4">
        <div className="flex items-center gap-5 flex-wrap">
          <div>
            <div className="font-mono text-[9px] tracking-widest text-[#7C8896] uppercase">Analysis tokens today</div>
            <div className={`font-mono text-sm font-bold mt-0.5 ${quotaExhausted ? 'text-[#F87171]' : quotaRemaining <= 10 ? 'text-[#F5A623]' : 'text-[#2DD4BF]'}`}>
              {quotaUsed}/{quotaLimit} used
            </div>
          </div>
          <div className="w-px h-8 bg-[#1B232C]" />
          <div>
            <div className="font-mono text-[9px] tracking-widest text-[#7C8896] uppercase">Model</div>
            <div className="font-mono text-sm text-white mt-0.5">Llama 4 Maverick</div>
          </div>
        </div>
        <button
          onClick={toggleEnabled}
          disabled={!loaded}
          aria-pressed={enabled}
          className="flex items-center gap-2.5"
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

      {/* Filter pills */}
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
          <div className="mono text-[11px] text-[#7C8896]">No analysed signals in this view yet.</div>
        </div>
      ) : (
        <div className="space-y-4 mb-8">
          {filtered.map(sig => {
            const isValid = sig.verdict === 'valid'
            return (
              <div key={sig.id} className="bg-[#0B0F14] border border-[#1B232C] rounded-xl overflow-hidden">
                {/* Original Pine signal row */}
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
                    <div>Entry <span className="text-white">{sig.entry.toFixed(3)}</span></div>
                    <div>SL <span className="text-[#F87171]">{sig.sl.toFixed(3)}</span> · TP <span className="text-[#34D399]">{sig.tp.toFixed(3)}</span> · R:R <span className="text-white">1:{sig.rr}</span></div>
                  </div>
                </div>

                {/* LLM verdict panel */}
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

      {/* Resolved-signals dropdown, auto-populated every 24h -- never LLM self-graded */}
      <div className="pt-6 border-t border-[#1B232C]">
        <div className="mb-3">
          <div className="font-mono text-[10px] tracking-[0.3em] text-[#F5A623] uppercase mb-1">Deterministic, Not AI-Generated</div>
          <h2 className="text-lg font-bold text-white">
            LLM-Preferred Levels — Resolved <span className="text-[#7C8896] font-normal text-sm ml-2">— checked against real price data every 24h</span>
          </h2>
        </div>
        <div className="font-mono text-[10px] text-[#7C8896] mb-4">
          {resolvedCount} of {signals.length} analysed signals resolved so far — {successCount} successful. Whether an LLM's preferred level actually won or lost is always computed from real market data, the same way the original Pine signals are, never reported by the model itself.
        </div>
        <details className="bg-[#0B0F14] border border-[#1B232C] rounded-xl">
          <summary className="cursor-pointer px-5 py-3.5 font-mono text-xs text-[#2DD4BF] uppercase tracking-wide">
            Show all resolved LLM-preferred levels ({resolvedCount})
          </summary>
          <div className="px-5 pb-4 space-y-1.5">
            {signals.filter(s => s.resolution !== 'open').map(s => (
              <div key={s.id} className="font-mono text-[11px] flex justify-between items-center py-1.5 border-t border-[#1B232C] first:border-t-0">
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