'use client'
import { useEffect, useState } from 'react'

const STORAGE_KEYS = {
  patterns: 'brunc:closed-patterns',
  patternsError: 'brunc:closed-patterns-error',
}

function readStored<T>(key: string): T | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = sessionStorage.getItem(key)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

function writeStored(key: string, value: any) {
  if (typeof window === 'undefined') return
  try {
    if (value === null || value === undefined || value === '') {
      sessionStorage.removeItem(key)
    } else {
      sessionStorage.setItem(key, JSON.stringify(value))
    }
  } catch {
    // sessionStorage unavailable (private browsing, etc) -- page still
    // works normally, just without persistence across navigation
  }
}

// ══════════════════════════════════════════════════════════
// MOCK DATA for the resolved-signals dropdown below. Real version
// reads every closed signal from Supabase, same fields resolve-signals
// already writes (final_outcome, resolved_at, time_to_resolution) --
// this section is now purely a VIEWER, since resolution itself runs
// automatically every 24h in the background rather than via a button.
// ══════════════════════════════════════════════════════════
interface ResolvedSignal {
  signal_id: string
  outcome: 'tp_hit' | 'stopped_out'
  resolved_at: string
}

const MOCK_RESOLVED: ResolvedSignal[] = [
  { signal_id: 'XAUUSD-1m-1756410900-sniper_confirmation-sell', outcome: 'tp_hit', resolved_at: new Date(Date.now() - 3 * 3600000).toISOString() },
  { signal_id: 'XAUUSD-3m-1756405400-precision-sell', outcome: 'stopped_out', resolved_at: new Date(Date.now() - 7 * 3600000).toISOString() },
]

function getSession() {
  const h = new Date().getUTCHours()
  const isLondon = h >= 8 && h < 17
  const isNewYork = h >= 13 && h < 22
  if (isLondon && isNewYork) return { name: 'London/NY Overlap', hours: '13:00–17:00' }
  if (isLondon) return { name: 'London', hours: '08:00–17:00' }
  if (isNewYork) return { name: 'New York', hours: '13:00–22:00' }
  return { name: 'Asian', hours: '22:00–08:00' }
}

export default function AnalysisPage() {
  const session = getSession()
  const now = new Date()

  const [resolutionFilter, setResolutionFilter] = useState<'all' | 'tp_hit' | 'stopped_out'>('all')
  const [resolved] = useState<ResolvedSignal[]>(MOCK_RESOLVED)

  const [patternsLoading, setPatternsLoading] = useState(false)
  const [patternsError, setPatternsError] = useState('')
  const [patternsResult, setPatternsResult] = useState<any>(null)

  useEffect(() => {
    setPatternsResult(readStored<any>(STORAGE_KEYS.patterns))
    setPatternsError(readStored<string>(STORAGE_KEYS.patternsError) || '')
  }, [])

  async function runPatternSummary() {
    setPatternsLoading(true)
    setPatternsError('')
    setPatternsResult(null)
    try {
      const res = await fetch('/api/closed-signal-analysis')
      const data = await res.json()
      if (data.error) {
        setPatternsError(data.error)
        writeStored(STORAGE_KEYS.patternsError, data.error)
        writeStored(STORAGE_KEYS.patterns, null)
      } else {
        setPatternsResult(data)
        writeStored(STORAGE_KEYS.patterns, data)
        writeStored(STORAGE_KEYS.patternsError, null)
      }
    } catch {
      const msg = 'Could not reach the pattern analysis service.'
      setPatternsError(msg)
      writeStored(STORAGE_KEYS.patternsError, msg)
      writeStored(STORAGE_KEYS.patterns, null)
    }
    setPatternsLoading(false)
  }

  const filteredResolved = resolved.filter(r => resolutionFilter === 'all' || r.outcome === resolutionFilter)
  const successCount = resolved.filter(r => r.outcome === 'tp_hit').length

  return (
    <div className="p-6 md:p-8 max-w-3xl fade-up">
      <div className="mb-7">
        <div className="mono text-[10px] tracking-[0.3em] text-[#2B8CE0] uppercase mb-1">Outcome Resolution</div>
        <h1 className="text-2xl font-bold text-white">
          Analysis <span className="text-[#7C8896] font-normal text-base ml-2">— signal outcomes, resolved automatically</span>
        </h1>
      </div>

      <div className="bg-[#0D1218] border border-[#1C2530] rounded-2xl p-4 mb-5 flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-4">
          <div>
            <div className="mono text-[9px] tracking-widest text-[#7C8896] uppercase">Current Session</div>
            <div className="mono text-sm font-bold text-[#2B8CE0] mt-0.5">{session.name}</div>
          </div>
          <div className="w-px h-8 bg-[#1C2530]" />
          <div>
            <div className="mono text-[9px] tracking-widest text-[#7C8896] uppercase">UTC Time</div>
            <div className="mono text-sm text-white mt-0.5">
              {now.getUTCHours().toString().padStart(2,'0')}:{now.getUTCMinutes().toString().padStart(2,'0')} UTC
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className="w-1.5 h-1.5 rounded-full bg-[#34C08A] blink" />
          <span className="mono text-[10px] text-[#34C08A]">Live context</span>
        </div>
      </div>
      <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>

      <div className="mono text-[10px] text-[#7C8896] mb-3">
        Every open signal is checked against real price data automatically every 24 hours — no button needed. This section is a live view of the results, not a trigger.
      </div>

      <div className="bg-[#0D1218] border border-[#1C2530] rounded-2xl p-6 mb-4">
        <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
          <span className="mono text-[10px] text-[#2DD4BF] tracking-widest uppercase">Resolved signals</span>
          <span className="mono text-[10px] text-[#7C8896]">{resolved.length} total · {successCount} successful</span>
        </div>

        <div className="flex gap-2 mb-4 flex-wrap">
          {(['all', 'tp_hit', 'stopped_out'] as const).map(f => (
            <button key={f} onClick={() => setResolutionFilter(f)}
              className={`font-mono text-[11px] uppercase tracking-wide px-4 py-1.5 rounded ${
                resolutionFilter === f ? 'bg-[#14625A]/40 text-[#2DD4BF] border border-[#2DD4BF]' : 'border border-[#1B232C] text-[#7C8896]'
              }`}>{f === 'tp_hit' ? 'successful' : f === 'stopped_out' ? 'unsuccessful' : f}</button>
          ))}
        </div>

        <select
          className="w-full bg-[#0F141A] border border-[#1B232C] rounded-lg px-3 py-2.5 font-mono text-xs text-white outline-none focus:border-[#2DD4BF] mb-3"
          defaultValue=""
          onChange={() => {}}
        >
          <option value="" disabled>Select a resolved signal to view ({filteredResolved.length} listed)</option>
          {filteredResolved.map((r, i) => (
            <option key={i} value={r.signal_id}>
              {r.signal_id} — {r.outcome === 'tp_hit' ? 'SUCCESSFUL' : 'UNSUCCESSFUL'}
            </option>
          ))}
        </select>

        <div className="space-y-1.5">
          {filteredResolved.length === 0 ? (
            <div className="mono text-[11px] text-[#7C8896] py-2">No resolved signals in this view yet.</div>
          ) : filteredResolved.map((r, i) => (
            <div key={i} className="font-mono text-[11px] flex justify-between items-center py-1.5 border-t border-[#1B232C] first:border-t-0">
              <span className="text-[#EDEFF2]">{r.signal_id}</span>
              <span className={`px-2 py-0.5 rounded ${r.outcome === 'tp_hit' ? 'text-[#2B8CE0] bg-[#2B8CE0]/15' : 'text-[#F87171] bg-[#F87171]/15'}`}>
                {r.outcome === 'tp_hit' ? 'SUCCESSFUL' : 'UNSUCCESSFUL'}
              </span>
            </div>
          ))}
        </div>
      </div>

      <div className="mt-10 pt-8 border-t border-[#1C2530]">
        <div className="mb-5">
          <div className="mono text-[10px] tracking-[0.3em] text-[#F5A623] uppercase mb-1">Deterministic, Not AI-Generated</div>
          <h2 className="text-xl font-bold text-white">
            Closed Signal Patterns <span className="text-[#7C8896] font-normal text-sm ml-2">— real counts from your actual closed signals</span>
          </h2>
        </div>

        <div className="mono text-[10px] text-[#7C8896] mb-3">
          No AI involved in this section on purpose -- every statement below is a real, computed count with its own real sample size shown alongside it. Treat these as patterns worth a closer look, not proof, especially with small sample sizes.
        </div>

        <button onClick={runPatternSummary} disabled={patternsLoading}
          className="flex items-center gap-2.5 px-5 py-3 bg-[#F5A623] hover:bg-[#ffb84d] disabled:opacity-50 text-[#05070A] font-semibold text-sm rounded-xl transition-all mb-2">
          {patternsLoading ? (
            <>
              <span className="w-4 h-4 border-2 border-[#05070A]/30 border-t-[#05070A] rounded-full inline-block" style={{ animation: 'spin 0.7s linear infinite' }} />
              Computing patterns…
            </>
          ) : (
            <>Find Patterns in Closed Signals</>
          )}
        </button>

        {patternsError && (
          <div className="bg-[#E5555A]/10 border border-[#E5555A]/25 rounded-2xl px-5 py-4 mono text-xs text-[#E5555A] mb-4 mt-3">
            {patternsError}
          </div>
        )}

        {patternsResult && (
          <div className="bg-[#0D1218] border border-[#1C2530] rounded-2xl p-6 fade-up mt-3">
            <div className="mono text-[10px] text-[#7C8896] mb-4">
              {patternsResult.totalClosed} closed signals total — {patternsResult.totalWins} wins, {patternsResult.totalLosses} losses.
            </div>

            {patternsResult.patterns && patternsResult.patterns.length > 0 ? (
              <div className="space-y-3">
                {patternsResult.patterns.map((p: string, i: number) => (
                  <div key={i} className="flex gap-2.5 text-sm text-[#EDEFF2] leading-relaxed">
                    <span className="text-[#F5A623] flex-shrink-0">•</span>
                    <span>{p}</span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="mono text-[11px] text-[#7C8896]">{patternsResult.note}</div>
            )}
          </div>
        )}

        {!patternsResult && !patternsLoading && !patternsError && (
          <div className="bg-[#0D1218] border border-[#1C2530] border-dashed rounded-2xl p-10 text-center mt-3">
            <div className="mono text-[11px] text-[#7C8896]">
              Click &quot;Find Patterns in Closed Signals&quot; to check real closed signals for anything worth bringing back for a Pine change.
            </div>
          </div>
        )}
      </div>
    </div>
  )
}