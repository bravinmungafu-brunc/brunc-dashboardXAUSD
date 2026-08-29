'use client'
import { useEffect, useState } from 'react'

// ══════════════════════════════════════════════════════════
// MOCK DATA -- same principle as Analysed Signals: shaped exactly
// like the real "news_signals" table + cached calendar events this
// page will read once the backend exists. The news-window check
// itself will be a simple time comparison against a once-daily
// cached calendar fetch (see the architecture discussion) -- no
// live API call needed for "is it news time right now".
// ══════════════════════════════════════════════════════════

interface NewsEvent {
  time: string
  currency: string
  event: string
  impact: 'high' | 'medium'
}

interface NewsSignal {
  id: number
  signal_id: string
  symbol: string
  direction: 'buy' | 'sell'
  signal_type: 'sniper_confirmation' | 'precision'
  entry: number
  sl: number
  tp: number
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

// Mock "today's cached calendar" -- in the real version this list is
// fetched once per day from the calendar API and stored in Supabase,
// then every "is news time active" check anywhere in the dashboard
// just compares the current UTC time against this cached list.
const MOCK_TODAY_EVENTS: NewsEvent[] = [
  { time: '13:30', currency: 'USD', event: 'Non-Farm Payrolls', impact: 'high' },
  { time: '15:00', currency: 'USD', event: 'ISM Services PMI', impact: 'medium' },
  { time: '18:00', currency: 'USD', event: 'FOMC Member Speech', impact: 'medium' },
]

const MOCK_NEWS_SIGNALS: NewsSignal[] = [
  {
    id: 1, signal_id: 'XAUUSD-1m-1756412500-sniper_confirmation-sell', symbol: 'XAUUSD',
    direction: 'sell', signal_type: 'sniper_confirmation',
    entry: 4578.400, sl: 4583.900, tp: 4562.900,
    created_at: new Date(Date.now() - 8 * 60000).toISOString(),
    triggering_event: 'Non-Farm Payrolls (USD, High Impact)',
    news_summary: 'NFP printed well above forecast, pushing dollar strength across the board -- gold under pressure as rate-cut expectations pull back.',
    verdict: 'valid', llm_entry: null, llm_sl: null, llm_tp: null,
    reasoning: 'Sell direction aligns with the dollar-strength reaction to the beat -- technical structure and news both point the same way.',
    resolution: 'open',
  },
]

function formatKenyaTime(iso: string) {
  try {
    return new Intl.DateTimeFormat('en-KE', {
      timeZone: 'Africa/Nairobi', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(new Date(iso)) + ' EAT'
  } catch { return '—' }
}

// Placeholder window logic -- real version compares current UTC time
// against the cached MOCK_TODAY_EVENTS-equivalent, +/- a configurable
// buffer (e.g. 15 min before/after) around each high-impact event.
function useNewsWindowActive(events: NewsEvent[]) {
  const [active, setActive] = useState<NewsEvent | null>(null)
  useEffect(() => {
    // TODO: replace with real time comparison against cached calendar
    setActive(events[0] ?? null)
  }, [events])
  return active
}

export default function NewsSignalsPage() {
  const activeEvent = useNewsWindowActive(MOCK_TODAY_EVENTS)
  const [signals] = useState<NewsSignal[]>(MOCK_NEWS_SIGNALS)
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

      {/* Live news-time indicator */}
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
              <div className="font-mono text-[11px] text-[#7C8896] mt-0.5">
                {activeEvent.currency} — {activeEvent.event} ({activeEvent.impact} impact) · {activeEvent.time} UTC
              </div>
            )}
          </div>
        </div>
        {!activeEvent && MOCK_TODAY_EVENTS.length > 0 && (
          <div className="font-mono text-[10px] text-[#7C8896]">
            Next: {MOCK_TODAY_EVENTS[0].event} at {MOCK_TODAY_EVENTS[0].time} UTC
          </div>
        )}
      </div>

      {/* Today's cached calendar, for context */}
      <div className="bg-[#0B0F14] border border-[#1B232C] rounded-xl p-5 mb-6">
        <div className="font-mono text-[10px] tracking-widest text-[#7C8896] uppercase mb-3">Today's high-impact events (cached, UTC)</div>
        <div className="space-y-2">
          {MOCK_TODAY_EVENTS.map((e, i) => (
            <div key={i} className="flex items-center justify-between font-mono text-xs">
              <span className="text-[#EDEFF2]">{e.time} — {e.currency} {e.event}</span>
              <span className={`px-2 py-0.5 rounded text-[10px] ${e.impact === 'high' ? 'text-[#F87171] bg-[#F87171]/10' : 'text-[#F5A623] bg-[#F5A623]/10'}`}>
                {e.impact.toUpperCase()}
              </span>
            </div>
          ))}
        </div>
      </div>

      {!activeEvent ? (
        <div className="bg-[#0B0F14] border border-[#1B232C] border-dashed rounded-2xl p-10 text-center mb-8">
          <div className="mono text-[11px] text-[#7C8896]">
            Signals only appear here during an active news window — check back closer to a scheduled event, or watch the indicator above.
          </div>
        </div>
      ) : signals.length === 0 ? (
        <div className="bg-[#0B0F14] border border-[#1B232C] border-dashed rounded-2xl p-10 text-center mb-8">
          <div className="mono text-[11px] text-[#7C8896]">News window is active, but no signal has fired yet during it.</div>
        </div>
      ) : (
        <div className="space-y-4 mb-8">
          {signals.map(sig => {
            const isValid = sig.verdict === 'valid'
            return (
              <div key={sig.id} className="bg-[#0B0F14] border border-[#2B8CE0]/30 rounded-xl overflow-hidden">
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
                    <div>Entry <span className="text-white">{sig.entry.toFixed(3)}</span></div>
                    <div>SL <span className="text-[#F87171]">{sig.sl.toFixed(3)}</span> · TP <span className="text-[#34D399]">{sig.tp.toFixed(3)}</span></div>
                  </div>
                </div>

                <div className="p-5 bg-[#0F141A]">
                  <div className="font-mono text-[9px] text-[#7C8896] uppercase tracking-wide mb-1.5">What's happening</div>
                  <div className="text-sm text-[#EDEFF2] leading-relaxed mb-4 pb-4 border-b border-[#1B232C]">{sig.news_summary}</div>

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
            News Signals — Resolved <span className="text-[#7C8896] font-normal text-sm ml-2">— checked against real price data every 24h</span>
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