'use client'
import { useEffect, useState } from 'react'

const FADE_ENABLED_KEY = 'brunc:fadeSignalsEnabled'

export default function SettingsPage() {
  const timeframes = [
    { label: 'Entry timeframe', sub: 'Signals fire here — execution anchor', val: '5 min' },
    { label: 'Bias timeframe', sub: 'Sets directional context', val: '1 hour' },
    { label: 'Target timeframe', sub: 'Extended structural target (TP3/TP4)', val: '4 hour' },
    { label: 'Track boxes from', sub: 'Start date for box formation · 500-day lookback', val: 'Rolling 500d' },
  ]

  // Client-side only for now (Settings isn't wired to the live engine
  // yet, per the note below) -- persists across reloads via localStorage
  // so this actually toggles instead of being a static always-on pill.
  const [fadeEnabled, setFadeEnabled] = useState(true)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    const stored = localStorage.getItem(FADE_ENABLED_KEY)
    if (stored !== null) setFadeEnabled(stored === 'true')
    setLoaded(true)
  }, [])

  function toggleFade() {
    setFadeEnabled(prev => {
      const next = !prev
      localStorage.setItem(FADE_ENABLED_KEY, String(next))
      return next
    })
  }

  return (
    <div className="p-6 md:p-8">
      <div className="mb-6">
        <h1 className="text-3xl font-bold text-white">Settings <span className="text-[#3A434D] font-medium">— strategy parameters</span></h1>
        <div className="font-mono text-xs text-[#7C8896] mt-2">Mirrors the live signal engine's inputs — changes here will push through once wired</div>
      </div>

      <div className="bg-[#0B0F14] border border-[#1B232C] rounded-xl p-6 max-w-2xl mb-5">
        <div className="font-mono text-[11px] tracking-widest text-[#7C8896] uppercase mb-4">Timeframes</div>
        {timeframes.map((r, i) => (
          <div key={i} className={`flex justify-between items-center py-4 ${i !== timeframes.length-1 ? 'border-b border-[#1B232C]' : ''}`}>
            <div>
              <div className="text-sm text-white">{r.label}</div>
              <div className="font-mono text-[11px] text-[#7C8896] mt-1">{r.sub}</div>
            </div>
            <span className="font-mono text-xs text-[#2DD4BF] bg-[#0F141A] border border-[#1B232C] px-3 py-1.5 rounded">{r.val}</span>
          </div>
        ))}
      </div>

      <div className="bg-[#0B0F14] border border-[#1B232C] rounded-xl p-6 max-w-2xl">
        <div className="font-mono text-[11px] tracking-widest text-[#7C8896] uppercase mb-4">Signal Types</div>
        <div className="flex justify-between items-center py-4">
          <div>
            <div className="text-sm text-white">Fade signals</div>
            <div className="font-mono text-[11px] text-[#7C8896] mt-1">Live box break, no confirming BOS required</div>
          </div>
          <button
            onClick={toggleFade}
            disabled={!loaded}
            aria-pressed={fadeEnabled}
            className={`w-9 h-5 rounded-full relative transition-colors ${fadeEnabled ? 'bg-[#2DD4BF]' : 'bg-[#2A333D]'}`}
          >
            <div className={`w-4 h-4 rounded-full bg-[#05070A] absolute top-0.5 transition-all ${fadeEnabled ? 'right-0.5' : 'left-0.5'}`} />
          </button>
        </div>
      </div>
    </div>
  )
}