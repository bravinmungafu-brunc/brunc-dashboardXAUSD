// app/(app)/backtest/page.tsx
'use client'
import { useState } from 'react'
import { DEFAULT_PARAMS } from '@/lib/backtest/engine'

// STAGE SYNC: ConfigOverrides rewritten to match the real, current
// BacktestParams shape -- targetRR, useManualEntryFilter,
// useDxyFilter, atrSLMult, orderBlockMinDispPct, dojiBodyMaxPct, and
// rejectionWickMinPct have all been removed from the actual engine
// (see backtest-engine.ts's own Stage Sync notes for why), so keeping
// them here would let you configure a variant the backend silently
// ignores. sniperRRLevels/precisionRRLevels are arrays now, not a
// single number -- left out of this simple override UI for now
// rather than half-supported; ask if you want ladder editing added.
interface ConfigOverrides {
  maxSLPoints?: number
  slBufferPointsFlat?: number
  minSLPoints?: number
  htfMidRejMinCount?: number
  confirmDisplacementPct?: number
  execCsodDisplacementPct?: number
  pullbackDispMinPct?: number
  pullbackDispMaxPct?: number
  swingPivotLen?: number
}

interface ConfigDraft {
  id: number
  name: string
  overrides: ConfigOverrides
  isQuickPreset: boolean // STAGE ADD: quick-added variants render as a minimal one-line summary, not the full checkbox card
}

interface ConfigResult {
  name: string
  params: Record<string, any>
  summary: {
    total: number; wins: number; losses: number; stillOpen: number; winRate: number | null
    netPoints: number; avgPointsPerSignal: number | null
    byType: Record<string, { total: number; wins: number; winRate: number | null }>
    byPath: Record<string, { total: number; wins: number; winRate: number | null }>
    // STAGE FIX: these three were added to the engine's own
    // BacktestSummary interface but NOT here -- this page declares
    // its own separate inline copy of the shape, so the engine
    // having them wasn't enough. That mismatch is exactly what
    // failed the TypeScript build. Kept as an inline declaration
    // (rather than importing BacktestSummary) to match how this file
    // already worked, but noting the real risk: two hand-maintained
    // copies of one shape WILL drift again -- this is the second
    // time. Worth importing the type directly if it drifts once more.
    byRRLevel: Record<string, { total: number; wins: number; winRate: number | null }>
    byGrade: Record<string, { total: number; wins: number; winRate: number | null }>
    bySession: Record<string, { total: number; wins: number; winRate: number | null }>
  }
  signals: any[]
  // STAGE ADD: remembering the lesson from the last build failure --
  // this page keeps its OWN inline copy of the response shape, so
  // anything added to the backend MUST be added here too or the
  // TypeScript build fails.
  diagnostics?: {
    totalBars: number
    barsSkippedByGuard: number
    barsEvaluated: number
    setupARawTrueCount: number
    setupBFiredStageCount: { armed: number; waitingRevert: number; waitingRealign: number }
    precisionRawTrueCount: number
  }
}

function todayISO() {
  return new Date().toISOString().slice(0, 10)
}
function daysAgoISO(n: number) {
  return new Date(Date.now() - n * 86400000).toISOString().slice(0, 10)
}

// STAGE ADD: real sample-size awareness, not just a caveat I have to
// remember to repeat -- Sniper and Precision have wildly different
// natural firing rates (historically ~75/day vs ~0.35/day), so a
// single global "small sample" threshold would either be too strict
// for Sniper or too loose for Precision. Tiers below are a reasonable
// statistical rule of thumb (variance of a win-rate estimate shrinks
// substantially past ~30), not a precise cutoff.
function sampleTier(n: number): { label: string; color: string } {
  if (n < 10) return { label: `n=${n} -- very small sample`, color: '#F87171' }
  if (n < 30) return { label: `n=${n} -- small sample`, color: '#F5A623' }
  return { label: `n=${n} -- reasonable sample`, color: '#34D399' }
}

const OVERRIDE_FIELDS: { key: keyof ConfigOverrides; label: string; step: number }[] = [
  { key: 'maxSLPoints', label: 'Max SL cap (points)', step: 10 },
  { key: 'slBufferPointsFlat', label: 'SL buffer (points)', step: 10 },
  { key: 'minSLPoints', label: 'Min SL (points)', step: 5 },
  { key: 'htfMidRejMinCount', label: 'HTF mid-rej min count (of 6)', step: 1 },
  { key: 'confirmDisplacementPct', label: 'Precision CSOD displacement %', step: 1 },
  { key: 'execCsodDisplacementPct', label: 'Setup A/B CSOD displacement %', step: 1 },
  { key: 'pullbackDispMinPct', label: 'Setup B pullback min %', step: 0.5 },
  { key: 'pullbackDispMaxPct', label: 'Setup B pullback max %', step: 0.5 },
  { key: 'swingPivotLen', label: 'Protected swing pivot length', step: 1 },
]

// STAGE ADD: one-click presets for the variants flagged as highest
// priority to actually test -- each button adds a fully pre-filled,
// still-editable variant directly to the list, no typing required.
// Capped to fit within the backend's 4-config-per-run limit alongside
// Baseline.
const QUICK_VARIANTS: { label: string; name: string; overrides: ConfigOverrides }[] = [
  { label: 'Wider SL cap (1000pts)', name: 'Wider SL cap (1000pts)', overrides: { maxSLPoints: 1000 } },
  { label: 'Looser Precision (1 of 6)', name: 'Looser Precision (1 of 6)', overrides: { htfMidRejMinCount: 1 } },
  { label: 'Looser Setup A/B CSOD (5%)', name: 'Looser Setup A/B CSOD (5%)', overrides: { execCsodDisplacementPct: 5 } },
  { label: 'Wider Setup B pullback', name: 'Wider Setup B pullback (50-85%)', overrides: { pullbackDispMinPct: 50, pullbackDispMaxPct: 85 } },
]

export default function BacktestPage() {
  const [startDate, setStartDate] = useState(daysAgoISO(5))
  const [endDate, setEndDate] = useState(todayISO())
  const [extraConfigs, setExtraConfigs] = useState<ConfigDraft[]>([])
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [results, setResults] = useState<ConfigResult[] | null>(null)
  const [meta, setMeta] = useState<any>(null)
  const [expandedSignals, setExpandedSignals] = useState<Set<number>>(new Set())

  const atVariantCap = extraConfigs.length >= 3

  function addConfig() {
    setExtraConfigs(prev => [...prev, { id: Date.now(), name: `Variant ${prev.length + 1}`, overrides: {}, isQuickPreset: false }])
  }
  // STAGE ADD: adds a fully pre-filled preset in one click, per the
  // explicit request -- not just an empty form, the actual override
  // values land immediately, still editable afterward like any other
  // variant.
  function addQuickVariant(preset: { name: string; overrides: ConfigOverrides }) {
    setExtraConfigs(prev => [...prev, { id: Date.now(), name: preset.name, overrides: { ...preset.overrides }, isQuickPreset: true }])
  }
  function removeConfig(id: number) {
    setExtraConfigs(prev => prev.filter(c => c.id !== id))
  }
  function updateConfigName(id: number, name: string) {
    setExtraConfigs(prev => prev.map(c => c.id === id ? { ...c, name } : c))
  }
  function updateConfigOverride(id: number, key: keyof ConfigOverrides, value: any) {
    setExtraConfigs(prev => prev.map(c => c.id === id ? { ...c, overrides: { ...c.overrides, [key]: value } } : c))
  }
  function toggleOverrideEnabled(id: number, key: keyof ConfigOverrides) {
    setExtraConfigs(prev => prev.map(c => {
      if (c.id !== id) return c
      const next = { ...c.overrides }
      const isEnabled = key in c.overrides
      if (!isEnabled) {
        // STAGE FIX: real bug found from live output -- this used to
        // fill a newly-checked box with the number input's STEP size
        // (e.g. 0.5 for pullback min/max), not a sensible value. A
        // step of 0.5 became an almost-impossible-to-satisfy 0.5-0.5%
        // pullback window, which is exactly what silently zeroed out
        // every non-Baseline result. Now pulls the REAL backend
        // default straight from DEFAULT_PARAMS (imported directly
        // from the engine, so this can't drift out of sync again).
        next[key] = DEFAULT_PARAMS[key] as number
      } else {
        delete next[key]
      }
      return { ...c, overrides: next }
    }))
  }

  async function run() {
    setRunning(true)
    setError(null)
    setResults(null)
    try {
      const configs = [
        { name: 'Baseline (current live settings)', params: {} },
        ...extraConfigs.map(c => ({ name: c.name, params: c.overrides })),
      ]
      const res = await fetch('/api/backtest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ startDate, endDate, configs }),
      })
      const data = await res.json()
      if (data.error) {
        setError(data.error)
      } else {
        setResults(data.results)
        setMeta(data.meta)
      }
    } catch (e: any) {
      setError(e?.message ?? 'Request failed.')
    } finally {
      setRunning(false)
    }
  }

  function toggleSignal(idx: number) {
    setExpandedSignals(prev => {
      const next = new Set(prev)
      if (next.has(idx)) next.delete(idx)
      else next.add(idx)
      return next
    })
  }

  return (
    <div className="p-6 md:p-8">
      <div className="mb-6">
        <h1 className="text-3xl font-bold text-white">Backtest <span className="text-[#3A434D] font-medium">— historical simulation</span></h1>
        <div className="font-mono text-xs text-[#7C8896] mt-2">
          Runs the current live Pine logic (or your own parameter variants) against real historical price data. Not the actual Pine script executing -- a hand-ported replica, kept in sync with the live BRUVV script. Treat results as informative, not proven, until cross-checked against real signals.
        </div>
      </div>

      <div className="bg-[#0B0F14] border border-[#1B232C] rounded-xl p-6 mb-5">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-5">
          <div>
            <div className="text-[9px] text-[#7C8896] uppercase tracking-wide mb-1.5 font-mono">Start date</div>
            <input type="date" value={startDate} onChange={e => setStartDate(e.target.value)}
              className="w-full bg-[#0F141A] border border-[#1B232C] rounded-lg px-3 py-2 text-white font-mono text-sm" />
          </div>
          <div>
            <div className="text-[9px] text-[#7C8896] uppercase tracking-wide mb-1.5 font-mono">End date</div>
            <input type="date" value={endDate} onChange={e => setEndDate(e.target.value)}
              className="w-full bg-[#0F141A] border border-[#1B232C] rounded-lg px-3 py-2 text-white font-mono text-sm" />
          </div>
        </div>
        <div className="font-mono text-[10px] text-[#7C8896] mb-5">
          Longer ranges cost more Twelve Data credits (1-minute data especially) -- keep this short (a few days to ~2 weeks) unless you specifically need more history. Also worth knowing: TradingView's Bar Replay on a 1-minute chart typically only reaches back a handful of days regardless of plan -- for verifying an older flagged signal, you may need to check it on a coarser timeframe instead.
        </div>

        <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
          <div className="font-mono text-[11px] tracking-widest text-[#7C8896] uppercase">
            Configurations to compare
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            {QUICK_VARIANTS.map(preset => (
              <button key={preset.label} onClick={() => addQuickVariant(preset)} disabled={atVariantCap}
                title="Adds this variant, pre-filled, directly to the list below -- still editable after"
                className="font-mono text-[10px] px-2.5 py-1.5 rounded border border-[#2B8CE0] text-[#2B8CE0] disabled:opacity-30 disabled:cursor-not-allowed hover:bg-[#2B8CE0]/10">
                + {preset.label}
              </button>
            ))}
            <button onClick={addConfig} disabled={atVariantCap}
              className="font-mono text-[11px] px-3 py-1.5 rounded border border-[#2DD4BF] text-[#2DD4BF] disabled:opacity-30 disabled:cursor-not-allowed">
              + Add blank variant
            </button>
          </div>
        </div>

        <div className="bg-[#0F141A] border border-[#1B232C] rounded-lg p-3 mb-3 font-mono text-xs text-[#7C8896]">
          Baseline (current live settings) — always included, uses every default from the live script.
        </div>

        {extraConfigs.map(cfg => {
          if (cfg.isQuickPreset) {
            // STAGE ADD: minimal display for quick-added presets --
            // just the name and what it actually changes, no
            // checkbox panel. Per explicit request: "click button,
            // get variant, done" -- the full card was clutter for a
            // preset that's already fully configured.
            const summary = Object.entries(cfg.overrides)
              .map(([k, v]) => `${OVERRIDE_FIELDS.find(f => f.key === k)?.label ?? k}: ${v}`)
              .join(' · ')
            return (
              <div key={cfg.id} className="bg-[#0F141A] border border-[#1B232C] rounded-lg px-4 py-3 mb-3 flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-white font-mono text-sm truncate">{cfg.name}</div>
                  <div className="text-[#7C8896] font-mono text-[10px] truncate">{summary}</div>
                </div>
                <div className="flex items-center gap-3 flex-shrink-0">
                  <button
                    onClick={() => setExtraConfigs(prev => prev.map(c => c.id === cfg.id ? { ...c, isQuickPreset: false } : c))}
                    className="text-[#2B8CE0] font-mono text-[10px]" title="Expand to add more settings to this variant">
                    customize further
                  </button>
                  <button onClick={() => removeConfig(cfg.id)} className="text-[#F87171] font-mono text-xs">✕</button>
                </div>
              </div>
            )
          }

          return (
            <div key={cfg.id} className="bg-[#0F141A] border border-[#1B232C] rounded-lg p-4 mb-3">
              <div className="flex items-center justify-between mb-3">
                <input value={cfg.name} onChange={e => updateConfigName(cfg.id, e.target.value)}
                  className="bg-transparent text-white font-mono text-sm border-b border-[#1B232C] focus:outline-none focus:border-[#2DD4BF] flex-1 mr-3" />
                <button onClick={() => removeConfig(cfg.id)} className="text-[#F87171] font-mono text-xs">✕ remove</button>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {OVERRIDE_FIELDS.map(field => {
                  const enabled = field.key in cfg.overrides
                  return (
                    <div key={field.key} className="flex items-center gap-2">
                      <input type="checkbox" checked={enabled}
                        onChange={() => toggleOverrideEnabled(cfg.id, field.key)} />
                      <span className="font-mono text-[11px] text-[#7C8896] flex-1">{field.label}</span>
                      <input type="number" step={field.step} disabled={!enabled}
                        value={enabled ? (cfg.overrides[field.key] as number) : ''}
                        onChange={e => updateConfigOverride(cfg.id, field.key, parseFloat(e.target.value))}
                        className="w-20 bg-[#0B0F14] border border-[#1B232C] rounded px-2 py-1 text-white font-mono text-xs disabled:opacity-30" />
                    </div>
                  )
                })}
              </div>
            </div>
          )
        })}

        <button onClick={run} disabled={running}
          className="mt-2 bg-[#2DD4BF] text-[#05070A] font-mono text-sm font-bold px-5 py-2.5 rounded-lg disabled:opacity-50">
          {running ? 'Running…' : 'Run Backtest'}
        </button>

        {error && <div className="mt-4 font-mono text-xs text-[#F87171]">{error}</div>}
      </div>

      {meta && (
        <div className="font-mono text-[10px] text-[#7C8896] mb-5">
          Bars fetched: 1m {meta.barsCounts['1m']} · 5m {meta.barsCounts['5m']} · 15m {meta.barsCounts['15m']} · 1h {meta.barsCounts['1h']} · 4h {meta.barsCounts['4h']} · D {meta.barsCounts['D']} · W {meta.barsCounts['W']} · M {meta.barsCounts['M']}
          <span className="ml-3">Twelve Data used: {meta.used}/{meta.limit} today ({meta.creditsUsed} this run)</span>
          {meta.oneMinuteRangeActuallyFetched && (
            <div className="mt-1 text-[#F5A623]">
              1m data actually covers: {meta.oneMinuteRangeActuallyFetched.earliest} to {meta.oneMinuteRangeActuallyFetched.latest} -- compare against your requested start/end date above.
            </div>
          )}
        </div>
      )}

      {results && (
        <div className={`grid grid-cols-1 ${results.length > 1 ? 'lg:grid-cols-2' : ''} gap-5`}>
          {results.map((r, ri) => (
            <div key={ri} className="bg-[#0B0F14] border border-[#1B232C] rounded-xl p-6">
              <div className="font-bold text-white mb-1">{r.name}</div>
              <div className="font-mono text-[10px] text-[#3A434D] mb-4">
                SL cap {r.params.maxSLPoints}pts · HTF mid-rej {r.params.htfMidRejMinCount}/6 · Setup A/B CSOD {r.params.execCsodDisplacementPct}% · pullback {r.params.pullbackDispMinPct}-{r.params.pullbackDispMaxPct}%
              </div>

              <div className="flex items-center gap-6 mb-2 flex-wrap">
                <div>
                  <div className="text-2xl font-bold text-[#34D399]">{r.summary.winRate !== null ? r.summary.winRate + '%' : '—'}</div>
                  <div className="font-mono text-[10px] text-[#7C8896]">win rate</div>
                </div>
                <div>
                  <div className={`text-2xl font-bold ${r.summary.netPoints > 0 ? 'text-[#34D399]' : r.summary.netPoints < 0 ? 'text-[#F87171]' : 'text-white'}`}>
                    {r.summary.netPoints > 0 ? '+' : ''}{r.summary.netPoints}
                  </div>
                  <div className="font-mono text-[10px] text-[#7C8896]">net points</div>
                </div>
                <div>
                  <div className={`text-2xl font-bold ${r.summary.avgPointsPerSignal !== null && r.summary.avgPointsPerSignal > 0 ? 'text-[#34D399]' : r.summary.avgPointsPerSignal !== null && r.summary.avgPointsPerSignal < 0 ? 'text-[#F87171]' : 'text-white'}`}>
                    {r.summary.avgPointsPerSignal !== null ? (r.summary.avgPointsPerSignal > 0 ? '+' : '') + r.summary.avgPointsPerSignal : '—'}
                  </div>
                  <div className="font-mono text-[10px] text-[#7C8896]">avg pts / signal</div>
                </div>
                <div className="flex gap-4 font-mono text-xs">
                  <div className="text-center"><div className="text-[#34D399] font-bold">{r.summary.wins}</div><div className="text-[9px] text-[#7C8896]">wins</div></div>
                  <div className="text-center"><div className="text-[#F87171] font-bold">{r.summary.losses}</div><div className="text-[9px] text-[#7C8896]">losses</div></div>
                  <div className="text-center"><div className="text-[#7C8896] font-bold">{r.summary.stillOpen}</div><div className="text-[9px] text-[#7C8896]">open</div></div>
                </div>
              </div>

              {(() => {
                const overallN = r.summary.wins + r.summary.losses
                const tier = sampleTier(overallN)
                return (
                  <div className="font-mono text-[10px] mb-5" style={{ color: tier.color }}>
                    Sample size: {tier.label}
                  </div>
                )
              })()}

              <div className="space-y-2 mb-4">
                {Object.entries(r.summary.byType).map(([type, stats]) => {
                  const n = stats.total
                  const tier = sampleTier(n)
                  return (
                    <div key={type} className="font-mono text-xs">
                      <div className="flex justify-between">
                        <span className="text-[#7C8896]">{type.replace(/_/g, ' ')} <span className="text-[#3A434D]">· {stats.total}</span></span>
                        <span className="text-white">{stats.winRate !== null ? stats.winRate + '%' : '—'}</span>
                      </div>
                      {n > 0 && <div className="text-[9px] mt-0.5" style={{ color: tier.color }}>{tier.label}</div>}
                    </div>
                  )
                })}
              </div>

              {r.summary.byPath && (r.summary.byPath.setup_a?.total > 0 || r.summary.byPath.setup_b?.total > 0) && (
                <div className="space-y-2 mb-4 pt-3 border-t border-[#1B232C]">
                  <div className="font-mono text-[9px] text-[#3A434D] uppercase mb-1">Sniper Confirmation, by path</div>
                  {Object.entries(r.summary.byPath).map(([path, stats]: [string, any]) => {
                    const n = stats.total
                    const tier = sampleTier(n)
                    return (
                      <div key={path} className="font-mono text-xs">
                        <div className="flex justify-between">
                          <span className="text-[#7C8896]">{path === 'setup_a' ? 'Setup A (CSOD+BOS)' : 'Setup B (realignment)'} <span className="text-[#3A434D]">· {stats.total}</span></span>
                          <span className="text-white">{stats.winRate !== null ? stats.winRate + '%' : '—'}</span>
                        </div>
                        {n > 0 && <div className="text-[9px] mt-0.5" style={{ color: tier.color }}>{tier.label}</div>}
                      </div>
                    )
                  })}
                </div>
              )}

              {/* STAGE ADD: three new breakdowns, per explicit request
                  to make Backtest surface output that actually helps
                  improve Pine, not just an overall number. */}
              {/* STAGE ADD: the piece that turns a zero-signal run
                  from an opaque mystery into a real answer -- shows
                  exactly where the funnel collapsed. Rendered
                  prominently (amber) when zero signals fired, since
                  that's precisely when it matters most. */}
              {r.diagnostics && (
                <div className={`rounded-lg p-3 mb-4 font-mono text-[10px] ${r.summary.total === 0 ? 'bg-[#F5A623]/10 border border-[#F5A623]/30 text-[#F5A623]' : 'bg-[#0F141A] text-[#7C8896]'}`}>
                  <div className="uppercase tracking-wide mb-1.5 font-bold">Why this result (signal funnel)</div>
                  <div>Bars loaded: {r.diagnostics.totalBars} · evaluated: {r.diagnostics.barsEvaluated} · skipped (missing 15m/1m box data): {r.diagnostics.barsSkippedByGuard}</div>
                  <div className="mt-1">Setup A raw condition ever true: {r.diagnostics.setupARawTrueCount} bars</div>
                  <div>Setup B stages -- armed: {r.diagnostics.setupBFiredStageCount.armed} · awaiting pullback: {r.diagnostics.setupBFiredStageCount.waitingRevert} · awaiting realign: {r.diagnostics.setupBFiredStageCount.waitingRealign}</div>
                  <div>Precision raw condition ever true: {r.diagnostics.precisionRawTrueCount} bars</div>
                  {r.summary.total === 0 && (
                    <div className="mt-2 pt-2 border-t border-[#F5A623]/20">
                      {r.diagnostics.barsEvaluated === 0
                        ? 'All bars were skipped -- the 15m or 1m box chain has no data for this range. Try a longer date range so the box logic has enough history to establish state.'
                        : r.diagnostics.setupARawTrueCount === 0 && r.diagnostics.precisionRawTrueCount === 0
                          ? 'Bars evaluated fine, but no setup condition was ever met in this window -- the gates genuinely never aligned here, not a data problem. A longer or different range would tell you more.'
                          : 'Conditions were met on some bars but no signal fired -- likely the one-shot latch or edge-detection blocking repeats. Worth investigating if this persists.'}
                    </div>
                  )}
                </div>
              )}

              {r.summary.byRRLevel && Object.keys(r.summary.byRRLevel).length > 0 && (
                <div className="space-y-2 mb-4 pt-3 border-t border-[#1B232C]">
                  <div className="font-mono text-[9px] text-[#3A434D] uppercase mb-1">Win rate by R:R level used</div>
                  {Object.entries(r.summary.byRRLevel).map(([rr, stats]: [string, any]) => {
                    const n = stats.total
                    const tier = sampleTier(n)
                    return (
                      <div key={rr} className="font-mono text-xs">
                        <div className="flex justify-between">
                          <span className="text-[#7C8896]">{rr} <span className="text-[#3A434D]">· {stats.total}</span></span>
                          <span className="text-white">{stats.winRate !== null ? stats.winRate + '%' : '—'}</span>
                        </div>
                        {n > 0 && <div className="text-[9px] mt-0.5" style={{ color: tier.color }}>{tier.label}</div>}
                      </div>
                    )
                  })}
                </div>
              )}

              {r.summary.byGrade && Object.keys(r.summary.byGrade).length > 0 && (
                <div className="space-y-2 mb-4 pt-3 border-t border-[#1B232C]">
                  <div className="font-mono text-[9px] text-[#3A434D] uppercase mb-1">Win rate by grade band</div>
                  {Object.entries(r.summary.byGrade).map(([band, stats]: [string, any]) => {
                    const n = stats.total
                    const tier = sampleTier(n)
                    return (
                      <div key={band} className="font-mono text-xs">
                        <div className="flex justify-between">
                          <span className="text-[#7C8896]">{band} <span className="text-[#3A434D]">· {stats.total}</span></span>
                          <span className="text-white">{stats.winRate !== null ? stats.winRate + '%' : '—'}</span>
                        </div>
                        {n > 0 && <div className="text-[9px] mt-0.5" style={{ color: tier.color }}>{tier.label}</div>}
                      </div>
                    )
                  })}
                </div>
              )}

              {r.summary.bySession && Object.keys(r.summary.bySession).length > 0 && (
                <div className="space-y-2 mb-4 pt-3 border-t border-[#1B232C]">
                  <div className="font-mono text-[9px] text-[#3A434D] uppercase mb-1">Win rate by session</div>
                  {Object.entries(r.summary.bySession).map(([session, stats]: [string, any]) => {
                    const n = stats.total
                    const tier = sampleTier(n)
                    return (
                      <div key={session} className="font-mono text-xs">
                        <div className="flex justify-between">
                          <span className="text-[#7C8896]">{session} <span className="text-[#3A434D]">· {stats.total}</span></span>
                          <span className="text-white">{stats.winRate !== null ? stats.winRate + '%' : '—'}</span>
                        </div>
                        {n > 0 && <div className="text-[9px] mt-0.5" style={{ color: tier.color }}>{tier.label}</div>}
                      </div>
                    )
                  })}
                </div>
              )}

              {r.signals.length > 0 && (
                <div className="border-t border-[#1B232C] pt-3 mt-3">
                  <div className="font-mono text-[10px] text-[#7C8896] uppercase mb-2">Individual signals ({r.signals.length})</div>
                  <div className="space-y-1.5 max-h-96 overflow-y-auto">
                    {r.signals.map((sig, si) => {
                      const key = ri * 10000 + si
                      const isExp = expandedSignals.has(key)
                      const isWin = sig.outcome === 'tp_hit'
                      return (
                        <div key={si} className="bg-[#0F141A] rounded p-2 font-mono text-[10px]">
                          <div className="flex justify-between items-center cursor-pointer" onClick={() => toggleSignal(key)}>
                            <span className="text-[#7C8896]">
                              {sig.time.slice(0, 16).replace('T', ' ')} · {sig.direction.toUpperCase()} · {sig.signalType}{sig.path ? ` (${sig.path})` : ''}
                            </span>
                            <span className={isWin ? 'text-[#34D399]' : sig.outcome === 'stopped_out' ? 'text-[#F87171]' : 'text-[#7C8896]'}>
                              {sig.outcome.replace(/_/g, ' ')}
                            </span>
                          </div>
                          {isExp && (
                            <div className="mt-1.5 pt-1.5 border-t border-[#1B232C] text-[#7C8896] space-y-0.5">
                              <div>Entry {sig.entry.toFixed(2)} · SL {sig.sl.toFixed(2)} · TP {sig.tp.toFixed(2)} · R:R 1:{sig.rrUsed}</div>
                              <div>Grade {sig.gradeValue}/7 · HTF rung {sig.htfRung} · exec {sig.execTf}m</div>
                              {sig.barsToResolve != null && <div>Resolved in {sig.barsToResolve} bars</div>}
                              <div className="text-[#2DD4BF] pt-1">
                                Bar Replay: jump to {new Date(sig.time).toISOString().replace('T', ' ').slice(0, 16)} UTC on the {sig.execTf}m chart to verify this against the real chart.
                              </div>
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}