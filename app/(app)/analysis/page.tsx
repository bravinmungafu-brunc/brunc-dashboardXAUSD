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

  useEffect(() => {
    fetch('/api/resolve-signals')
      .then(r => r.json())
      .then(d => { if (d.used != null) setQuota({ used: d.used, limit: d.limit }) })
      .catch(() => {})
  }, [])

  const quotaExhausted = quota != null && quota.used >= quota.limit

  // Now also reads used/limit back from /api/analysis, since that route's
  // own Alpha Vantage call is tracked against the same shared quota
  // counter as resolve-signals — the badge on screen reflects both
  // buttons' usage, not just resolve-signals'.
  async function runAnalysis() {
    setLoading(true)
    setError('')
    setAssessments(null)
    try {
      const res = await fetch('/api/analysis')
      const data = await res.json()
      if (data.used != null) setQuota({ used: data.used, limit: data.limit })
      if (data.error) setError(data.error)
      else setAssessments(data.assessments)
    } catch {
      setError('Could not reach analysis service. Check your Gemini API key in .env.local')
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
      if (data.error) setResolveError(data.error)
      else setResolveResult(data)
    } catch {
      setResolveError('Could not reach the resolution service. Check your Alpha Vantage API key in .env.local')
    }
    setResolving(false)
  }

  const updates: any[] = resolveResult?.updates || []
  const successfulCount = updates.filter(u => u.outcome === 'tp_hit').length
  const unsuccessfulCount = updates.filter(u => u.outcome === 'stopped_out').length

  function outcomeStyle(outcome: string) {
    if (outcome === 'tp_hit') return { label: 'SUCCESSFUL', className: 'text-[#2B8CE0] bg-[#2B8CE0]/10' }
    if (outcome === 'stopped_out') return { label: 'UNSUCCESSFUL', className: 'text-[#F87171] bg-[#F87171]/10' }
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

      <button onClick={runAnalysis} disabled={loading}
        className="flex items-center gap-2.5 px-5 py-3 bg-[#2B8CE0] hover:bg-[#3a9cf0] disabled:opacity-50 text-white font-semibold text-sm rounded-xl transition-all mb-5">
        {loading ? (
          <>
            <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full inline-block" style={{ animation: 'spin 0.7s linear infinite' }} />
            Analyzing signals &amp; news…
          </>
        ) : (
          <>
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <path d="M7 1v2M7 11v2M1 7h2M11 7h2M2.5 2.5l1.5 1.5M10 10l1.5 1.5M2.5 11.5L4 10M10 4l1.5-1.5" stroke="white" strokeWidth="1.5" strokeLinecap="round"/>
              <circle cx="7" cy="7" r="2.5" stroke="white" strokeWidth="1.5"/>
            </svg>
            Run AI Analysis
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
            Click &quot;Run AI Analysis&quot; to generate per-signal insights from open signals and current market context.
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
              Alpha Vantage: <span className={quotaExhausted ? 'text-[#F87171]' : 'text-[#2DD4BF]'}>{quota.used}/{quota.limit}</span> today
            </span>
          )}
        </div>

        <button onClick={runCloseSignalAnalysis} disabled={resolving || quotaExhausted}
          className="flex items-center gap-2.5 px-5 py-3 bg-[#2DD4BF] hover:bg-[#4ee0cc] disabled:opacity-40 text-[#05070A] font-semibold text-sm rounded-xl transition-all mb-2">
          {resolving ? (
            <>