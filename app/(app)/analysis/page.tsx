'use client'
import { useState, useEffect } from 'react'

function getSession() {
  const h = new Date().getUTCHours()
  const isLondon = h >= 8 && h < 17
  const isNewYork = h >= 13 && h < 22
  if (isLondon && isNewYork) return { name: 'London/NY Overlap', hours: '13:00–17:00' }
  if (isLondon) return { name: 'London', hours: '08:00–17:00' }
  if (isNewYork) return { name: 'New York', hours: '13:00–22:00' }
  return { name: 'Asian', hours: '22:00–08:00' }
}

type Assessment = {
  signal_id: string
  validity: 'valid' | 'caution' | 'invalid'
  reasoning: string
  recommendation: string
}

const VALIDITY_STYLE: Record<string, { color: string; label: string }> = {
  valid:   { color: '#2B8CE0', label: 'VALID' },
  caution: { color: '#F5A623', label: 'CAUTION' },
  invalid: { color: '#F87171', label: 'INVALID' },
}

const STORAGE_KEYS = {
  assessments: 'brunc:analysis-assessments',
  error: 'brunc:analysis-error',
  resolveResult: 'brunc:resolve-result',
  resolveError: 'brunc:resolve-error',
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

export default function AnalysisPage() {
  const [assessments, setAssessments] = useState<Assessment[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const session = getSession()
  const now = new Date()

  const [resolving, setResolving] = useState(false)
  const [resolveError, setResolveError] = useState('')
  const [resolveResult, setResolveResult] = useState<any>(null)
  const [quota, setQuota] = useState<{ used: number; limit: number } | null>(null)

  const [patternsLoading, setPatternsLoading] = useState(false)
  const [patternsError, setPatternsError] = useState('')
  const [patternsResult, setPatternsResult] = useState<any>(null)

  useEffect(() => {
    setAssessments(readStored<Assessment[]>(STORAGE_KEYS.assessments))
    setError(readStored<string>(STORAGE_KEYS.error) || '')
    setResolveResult(readStored<any>(STORAGE_KEYS.resolveResult))
    setResolveError(readStored<string>(STORAGE_KEYS.resolveError) || '')
    setPatternsResult(readStored<any>(STORAGE_KEYS.patterns))
    setPatternsError(readStored<string>(STORAGE_KEYS.patternsError) || '')
  }, [])

  useEffect(() => {
    fetch('/api/resolve-signals')
      .then(r => r.json())
      .then(d => { if (d.used != null) setQuota({ used: d.used, limit: d.limit }) })
      .catch(() => {})
  }, [])

  const quotaExhausted = quota != null && quota.used >= quota.limit

  async function runValidityCheck() {
    setLoading(true)
    setError('')
    setAssessments(null)
    try {
      const res = await fetch('/api/analysis')
      const data = await res.json()
      if (data.used != null) setQuota({ used: data.used, limit: data.limit })
      if (data.error) {
        setError(data.error)
        writeStored(STORAGE_KEYS.error, data.error)
        writeStored(STORAGE_KEYS.assessments, null)
      } else {
        setAssessments(data.assessments)
        writeStored(STORAGE_KEYS.assessments, data.assessments)
        writeStored(STORAGE_KEYS.error, null)
      }
    } catch {
      const msg = 'Could not reach analysis service. Check your Groq API key in .env.local'
      setError(msg)
      writeStored(STORAGE_KEYS.error, msg)
      writeStored(STORAGE_KEYS.assessments, null)
    }
    setLoading(false)
  }

  async function runCloseSignalAnalysis() {
    setResolving(true)
    setResolveError('')
    setResolveResult(null)
    try {
      const res = await fetch('/api/resolve-signals', { method: 'POST' })
      const data = await res.json()
      if (data.used != null) setQuota({ used: data.used, limit: data.limit })
      if (data.error) {
        setResolveError(data.error)
        writeStored(STORAGE_KEYS.resolveError, data.error)
        writeStored(STORAGE_KEYS.resolveResult, null)
      } else {
        setResolveResult(data)
        writeStored(STORAGE_KEYS.resolveResult, data)
        writeStored(STORAGE_KEYS.resolveError, null)
      }
    } catch {
      const msg = 'Could not reach the resolution service. Check your Twelve Data API key in .env.local'
      setResolveError(msg)
      writeStored(STORAGE_KEYS.resolveError, msg)
      writeStored(STORAGE_KEYS.resolveResult, null)
    }
    setResolving(false)
  }

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

  const updates: any[] = resolveResult?.updates || []
  const successfulCount = updates.filter(u => u.outcome === 'tp_hit').length
  const unsuccessfulCount = updates.filter(u => u.outcome === 'stopped_out').length
  const deferredCount: number = resolveResult?.deferred ?? 0
  const malformedCount: number = resolveResult?.malformed ?? 0

  function outcomeStyle(outcome: string) {
    if (outcome === 'tp_hit') return { label: 'SUCCESSFUL', className: 'text-[#2B8CE0] bg-[#2B8CE0]/10' }
    if (outcome === 'stopped_out') return { label: 'UNSUCCESSFUL', className: 'text-[#F87171] bg-[#F87171]/10' }
    if (outcome === 'no_data') return { label: 'NO DATA', className: 'text-[#7C8896] bg-[#7C8896]/10' }
    if (outcome === 'quota_exceeded') return { label: 'QUOTA REACHED', className: 'text-[#F5A623] bg-[#F5A623]/10' }
    if (outcome === 'malformed_exits') return { label: 'MISSING SL/TP', className: 'text-[#F5A623] bg-[#F5A623]/10' }
    return { label: 'OPEN', className: 'text-[#7C8896] bg-[#7C8896]/10' }
  }

  return (
    <div className="p-6 md:p-8 max-w-3xl fade-up">
      <div className="mb-7">
        <div className="mono text-[10px] tracking-[0.3em] text-[#2B8CE0] uppercase mb-1">AI-Generated Insights</div>
        <h1 className="text-2xl font-bold text-white">
          Analysis <span className="text-[#7C8896] font-normal text-base ml-2">— pattern &amp; narrative review</span>
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
          <div className="w-px h-8 bg-[#1C2530]" />
          <div>
            <div className="mono text-[9px] tracking-widest text-[#7C8896] uppercase">Session Hours</div>
            <div className="mono text-sm text-white mt-0.5">{session.hours} UTC</div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className="w-1.5 h-1.5 rounded-full bg-[#34C08A] blink" />
          <span className="mono text-[10px] text-[#34C08A]">Live context</span>
        </div>
      </div>

      <div className="mono text-[10px] text-[#7C8896] mb-3">
        Checks whether your currently OPEN signals still look valid given live market conditions and news -- doesn't determine win/loss (that's ANALYSE, further down).
      </div>

      <button onClick={runValidityCheck} disabled={loading}
        className="flex items-center gap-2.5 px-5 py-3 bg-[#2B8CE0] hover:bg-[#3a9cf0] disabled:opacity-50 text-white font-semibold text-sm rounded-xl transition-all mb-5">
        {loading ? (
          <>
            <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full inline-block" style={{ animation: 'spin 0.7s linear infinite' }} />
            Checking signals &amp; news…
          </>
        ) : (
          <>
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <path d="M7 1v2M7 11v2M1 7h2M11 7h2M2.5 2.5l1.5 1.5M10 10l1.5 1.5M2.5 11.5L4 10M10 4l1.5-1.5" stroke="white" strokeWidth="1.5" strokeLinecap="round"/>
              <circle cx="7" cy="7" r="2.5" stroke="white" strokeWidth="1.5"/>
            </svg>
            Check Open Signal Validity
          </>
        )}
      </button>
      <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>

      {error && (
        <div className="bg-[#E5555A]/10 border border-[#E5555A]/25 rounded-2xl px-5 py-4 mono text-xs text-[#E5555A] mb-4">
          {error}
        </div>
      )}

      {assessments && assessments.length > 0 && (
        <div className="space-y-3 mb-4 fade-up">
          {assessments.map((a, i) => {
            const style = VALIDITY_STYLE[a.validity] || VALIDITY_STYLE.caution
            return (
              <div key={i} className="bg-[#0D1218] border border-[#1C2530] rounded-2xl p-5">
                <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
                  <span className="mono text-xs text-white font-semibold">{a.signal_id}</span>
                  <span className="mono text-[10px] px-2.5 py-1 rounded border" style={{ color: style.color, borderColor: style.color }}>
                    {style.label}
                  </span>
                </div>
                <div className="text-sm text-[#EDEFF2] leading-relaxed mb-2">{a.reasoning}</div>
                <div className="mono text-[11px] text-[#7C8896]">
                  <span className="text-[#2DD4BF]">Suggests:</span> {a.recommendation}
                </div>
              </div>
            )
          })}
        </div>
      )}

      {!assessments && !loading && !error && (
        <div className="bg-[#0D1218] border border-[#1C2530] border-dashed rounded-2xl p-10 text-center">
          <div className="mono text-[11px] text-[#7C8896]">
            Click &quot;Check Open Signal Validity&quot; to generate per-signal insights from open signals and current market context.
          </div>
        </div>
      )}

      <div className="mt-10 pt-8 border-t border-[#1C2530]">
        <div className="mb-5 flex items-center justify-between flex-wrap gap-2">
          <div>
            <div className="mono text-[10px] tracking-[0.3em] text-[#2DD4BF] uppercase mb-1">Outcome Resolution</div>
            <h2 className="text-xl font-bold text-white">
              Closed Signal Analysis <span className="text-[#7C8896] font-normal text-sm ml-2">— compares logged signals against live market data</span>
            </h2>
          </div>
          {quota && (
            <span className="mono text-[10px] text-[#7C8896]">
              Twelve Data: <span className={quotaExhausted ? 'text-[#F87171]' : 'text-[#2DD4BF]'}>{quota.used}/{quota.limit}</span> today
            </span>
          )}
        </div>

        <div className="mono text-[10px] text-[#7C8896] mb-3">
          Walks price bar-by-bar from each signal's creation time to determine whether SL or TP was hit first, continuing forward across multiple data pages for older signals rather than stopping after the first ~3.5 days -- this costs one credit per page checked, not one credit total, so a run may only process some open signals and pick up the rest next time.
        </div>

        <button onClick={runCloseSignalAnalysis} disabled={resolving || quotaExhausted}
          className="flex items-center gap-2.5 px-5 py-3 bg-[#2DD4BF] hover:bg-[#4ee0cc] disabled:opacity-40 text-[#05070A] font-semibold text-sm rounded-xl transition-all mb-2">
          {resolving ? (
            <>
              <span className="w-4 h-4 border-2 border-[#05070A]/30 border-t-[#05070A] rounded-full inline-block" style={{ animation: 'spin 0.7s linear infinite' }} />
              Analysing closed signals…
            </>
          ) : quotaExhausted ? (
            <>DAILY LIMIT REACHED</>
          ) : (
            <>ANALYSE</>
          )}
        </button>
        {quotaExhausted && (
          <div className="mono text-[10px] text-[#7C8896] mb-3">Resets at 00:00 UTC.</div>
        )}

        {resolveError && (
          <div className="bg-[#E5555A]/10 border border-[#E5555A]/25 rounded-2xl px-5 py-4 mono text-xs text-[#E5555A] mb-4 mt-3">
            {resolveError}
          </div>
        )}

        {resolveResult && (
          <div className="bg-[#0D1218] border border-[#1C2530] rounded-2xl p-6 fade-up mt-3">
            <div className="flex items-center gap-2 mb-4 pb-4 border-b border-[#1C2530]">
              <span className="mono text-[10px] text-[#2DD4BF] tracking-widest uppercase">Resolution Summary</span>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-6 gap-4 mb-4">
              <div>
                <div className="mono text-[9px] text-[#7C8896] uppercase tracking-wide mb-1">Successful</div>
                <div className="text-2xl font-bold text-[#2B8CE0]">{successfulCount}</div>
              </div>
              <div>
                <div className="mono text-[9px] text-[#7C8896] uppercase tracking-wide mb-1">Unsuccessful</div>
                <div className="text-2xl font-bold text-[#F87171]">{unsuccessfulCount}</div>
              </div>
              <div>
                <div className="mono text-[9px] text-[#7C8896] uppercase tracking-wide mb-1">Closed</div>
                <div className="text-2xl font-bold text-white">{resolveResult.resolved ?? 0}</div>
              </div>
              <div>
                <div className="mono text-[9px] text-[#7C8896] uppercase tracking-wide mb-1">Open</div>
                <div className="text-2xl font-bold text-[#7C8896]">{resolveResult.stillOpen ?? 0}</div>
              </div>
              <div>
                <div className="mono text-[9px] text-[#7C8896] uppercase tracking-wide mb-1">Deferred</div>
                <div className={`text-2xl font-bold ${deferredCount > 0 ? 'text-[#F5A623]' : 'text-[#7C8896]'}`}>{deferredCount}</div>
              </div>
              <div>
                <div className="mono text-[9px] text-[#7C8896] uppercase tracking-wide mb-1">Missing SL/TP</div>
                <div className={`text-2xl font-bold ${malformedCount > 0 ? 'text-[#F5A623]' : 'text-[#7C8896]'}`}>{malformedCount}</div>
              </div>
            </div>

            {deferredCount > 0 && (
              <div className="mono text-[10px] text-[#F5A623] mb-4 pb-4 border-b border-[#1C2530]">
                {deferredCount} open signal{deferredCount === 1 ? '' : 's'} weren't checked this run to stay within a reasonable per-run credit cost — click ANALYSE again to pick up the rest.
              </div>
            )}

            {malformedCount > 0 && (
              <div className="mono text-[10px] text-[#F5A623] mb-4 pb-4 border-b border-[#1C2530]">
                {malformedCount} open signal{malformedCount === 1 ? '' : 's'} had no SL or TP recorded at all -- these can never be resolved and are worth checking directly in Supabase.
              </div>
            )}

            {updates.length > 0 ? (
              <div className="space-y-1.5 pt-3 border-t border-[#1C2530]">
                {updates.map((u: any, i: number) => {
                  const style = outcomeStyle(u.outcome)
                  return (
                    <div key={i} className="font-mono text-[11px] flex justify-between items-center py-1">
                      <span className="text-[#EDEFF2]">{u.signal_id}</span>
                      <span className={`px-2 py-0.5 rounded ${style.className}`}>{style.label}</span>
                    </div>
                  )
                })}
              </div>
            ) : (
              <div className="mono text-[11px] text-[#7C8896] pt-3 border-t border-[#1C2530]">
                No open signals were checked on this run.
              </div>
            )}
          </div>
        )}

        {!resolveResult && !resolving && !resolveError && (
          <div className="bg-[#0D1218] border border-[#1C2530] border-dashed rounded-2xl p-10 text-center mt-3">
            <div className="mono text-[11px] text-[#7C8896]">
              Click &quot;ANALYSE&quot; to pull live market data from Twelve Data and mark each closed-window signal as a win or loss. Results feed the Performance page.
            </div>
          </div>
        )}
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