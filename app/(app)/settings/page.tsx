'use client'

export default function SettingsPage() {
  const timeframes = [
    { label: 'Entry timeframe', sub: 'Signals fire here — execution anchor', val: '5 min' },
    { label: 'Bias timeframe', sub: 'Sets directional context', val: '1 hour' },
    { label: 'Target timeframe', sub: 'Structural target reference', val: '4 hour' },
    { label: 'Track boxes from', sub: 'Start date for box formation · 500-day lookback', val: 'Rolling 500d' },
  ]

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
    </div>
  )
}