'use client'
import { useState } from 'react'

function getSession() {
  const h = new Date().getUTCHours()
  if (h >= 0 && h < 7) return { name: 'Asian', hours: '00:00–07:00' }
  if (h >= 7 && h < 13) return { name: 'London', hours: '07:00–13:00' }
  if (h >= 13 && h < 22) return { name: 'New York', hours: '13:00–22:00' }
  return { name: 'Overlap', hours: '22:00–00:00' }
}

export default function AnalysisPage() {
  const [analysis, setAnalysis] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const session = getSession()
  const now = new Date()

  async function runAnalysis() {
    setLoading(true)
    setError('')
    setAnalysis(null)
    try {
      const res = await fetch('/api/analysis')
      const data = await res.json()
      if (data.error) setError(data.error)
      else setAnalysis(data.text)
    } catch {
      setError('Could not reach analysis service. Check your Gemini API key in .env.local')
    }
    setLoading(false)
  }

  return (
    <div className="p-6 md:p-8 max-w-3xl fade-up">
      <div className="mb-7">
        <div className="mono text-[10px] tracking-[0.3em] text-[#2B8CE0] uppercase mb-1">AI-Generated Insights</div>
        <h1 className="text-2xl font-bold text-white">
          Analysis <span className="text-[#7C8896] font-normal text-base ml-2">— pattern &amp; narrative review</span>
        </h1>
      </div>

      {/* Session context bar */}
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

      {/* Action */}
      <button onClick={runAnalysis} disabled={loading}
        className="flex items-center gap-2.5 px-5 py-3 bg-[#2B8CE0] hover:bg-[#3a9cf0] disabled:opacity-50 text-white font-semibold text-sm rounded-xl transition-all mb-5">
        {loading ? (
          <>
            <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full inline-block" style={{ animation: 'spin 0.7s linear infinite' }} />
            Analyzing market…
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

      {analysis && (
        <div className="bg-[#0D1218] border border-[#1C2530] rounded-2xl p-6 fade-up">
          <div className="flex items-center gap-2 mb-4 pb-4 border-b border-[#1C2530]">
            <div className="w-6 h-6 rounded-lg bg-[#2B8CE0]/15 border border-[#2B8CE0]/25 flex items-center justify-center">
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                <circle cx="5" cy="5" r="4" stroke="#2B8CE0" strokeWidth="1.2"/>
                <path d="M3.5 5.5l1 1 2-2" stroke="#2B8CE0" strokeWidth="1.2" strokeLinecap="round"/>
              </svg>
            </div>
            <span className="mono text-[10px] text-[#2B8CE0] tracking-widest uppercase">Gemini Analysis Output</span>
            <span className="mono text-[10px] text-[#7C8896] ml-auto">{session.name} session</span>
          </div>
          <div className="text-sm text-[#EDEFF2] leading-relaxed whitespace-pre-wrap">
            {analysis}
          </div>
        </div>
      )}

      {!analysis && !loading && !error && (
        <div className="bg-[#0D1218] border border-[#1C2530] border-dashed rounded-2xl p-10 text-center">
          <div className="mono text-[11px] text-[#7C8896]">
            Click "Run AI Analysis" to generate insights from resolved signals and current market context.
          </div>
        </div>
      )}
    </div>
  )
}