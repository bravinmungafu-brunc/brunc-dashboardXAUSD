// app/(app)/backtest/page.tsx
'use client'
import { useState } from 'react'

interface ConfigOverrides {
  targetRR?: number
  htfMidRejMinCount?: number
  useManualEntryFilter?: boolean
  useDxyFilter?: boolean
  orderBlockMinDispPct?: number
  dojiBodyMaxPct?: number
  rejectionWickMinPct?: number
  atrSLMult?: number
}

interface ConfigDraft {
  id: number
  name: string
  overrides: ConfigOverrides
}

interface ConfigResult {
  name: string
  params: Record<string, any>
  summary: {
    total: number; wins: number; losses: number; stillOpen: number; winRate: number | null
    byType: Record<string, { total: number; wins: number; winRate: number | null }>
  }
  signals: any[]
}

function todayISO() {
  return new Date().toISOString().slice(0, 10)
}
function daysAgoISO(n: number) {
  return new Date(Date.now() - n * 86400000).toISOString().slice(0, 10)
}

const OVERRIDE_FIELDS: { key: keyof ConfigOverrides; label: string; type: 'number' | 'bool'; step?: number }[] = [
  { key: 'targetRR', label: 'Target R:R', type: 'number', step: 0.1 },
  { key: 'htfMidRejMinCount', label: 'HTF mid-rej min count (of 6)', type: 'number', step: 1 },
  { key: 'atrSLMult', label: 'Max SL as ATR multiple', type: 'number', step: 0.1 },
  { key: 'orderBlockMinDispPct', label: 'Order block min displacement %', type: 'number', step: 1 },
  { key: 'dojiBodyMaxPct', label: 'Doji max body %', type: 'number', step: 1 },
  { key: 'rejectionWickMinPct', label: 'Rejection min wick %', type: 'number', step: 1 },
  { key: 'useManualEntryFilter', label: 'Require manual entry filter', type: 'bool' },
  { key: 'useDxyFilter', label: 'Require DXY confirmation', type: 'bool' },
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

  function addConfig() {
    setExtraConfigs(prev => [...prev, { id: Date.now(), name: `Variant ${prev.length + 1}`, overrides: {} }])
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
  function toggleOverrideEnabled(id: number, key: keyof ConfigOverrides, enabled: boolean, defaultVal: any) {
    setExtraConfigs(prev => prev.map(c => {
      if (c.id !== id) return c
      const next = { ...c.overrides }
      if (enabled) next[key] = defaultVal as any
      else delete next[key]
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
          Runs the current live Pine logic (or your own parameter variants) against real historical price data. Not the actual Pine script executing -- a hand-ported replica. Treat results as informative, not proven, until cross-checked against real signals.
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
          Longer ranges cost more Twelve Data credits (1-minute data especially) -- keep this short (a few days to ~2 weeks) unless you specifically need more history.
        </div>

        <div className="flex items-center justify-between mb-3">
          <div className="font-mono text-[11px] tracking-widest text-[#7C8896] uppercase">
            Configurations to compare
          </div>
          <button onClick={addConfig} disabled={extraConfigs.length >= 3}
            className="font-mono text-[11px] px-3 py-1.5 rounded border border-[#2DD4BF] text-[#2DD4BF] disabled:opacity-30 disabled:cursor-not-allowed">
            + Add variant
          </button>
        </div>

        <div className="bg-[#0F141A] border border-[#1B232C] rounded-lg p-3 mb-3 font-mono text-xs text-[#7C8896]">
          Baseline (current live settings) — always included, uses every default from the live script.
        </div>

        {extraConfigs.map(cfg => (
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
                      onChange={e => toggleOverrideEnabled(cfg.id, field.key, e.target.checked, field.type === 'bool' ? true : (field.step ?? 1))} />
                    <span className="font-mono text-[11px] text-[#7C8896] flex-1">{field.label}</span>
                    {field.type === 'number' ? (
                      <input type="number" step={field.step} disabled={!enabled}
                        value={enabled ? (cfg.overrides[field.key] as number) : ''}
                        onChange={e => updateConfigOverride(cfg.id, field.key, parseFloat(e.target.value))}
                        className="w-20 bg-[#0B0F14] border border-[#1B232C] rounded px-2 py-1 text-white font-mono text-xs disabled:opacity-30" />
                    ) : (
                      <select disabled={!enabled}
                        value={enabled ? String(cfg.overrides[field.key]) : 'true'}
                        onChange={e => updateConfigOverride(cfg.id, field.key, e.target.value === 'true')}
                        className="w-20 bg-[#0B0F14] border border-[#1B232C] rounded px-2 py-1 text-white font-mono text-xs disabled:opacity-30">
                        <option value="true">On</option>
                        <option value="false">Off</option>
                      </select>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        ))}

        <button onClick={run} disabled={running}
          className="mt-2 bg-[#2DD4BF] text-[#05070A] font-mono text-sm font-bold px-5 py-2.5 rounded-lg disabled:opacity-50">
          {running ? 'Running…' : 'Run Backtest'}
        </button>

        {error && <div className="mt-4 font-mono text-xs text-[#F87171]">{error}</div>}
      </div>

      {meta && (
        <div className="font-mono text-[10px] text-[#7C8896] mb-5">
          Bars fetched: 1m {meta.barsCounts['1m']} · 5m {meta.barsCounts['5m']} · 15m {meta.barsCounts['15m']} · 1h {meta.barsCounts['1h']} · 4h {meta.barsCounts['4h']} · D {meta.barsCounts['D']} · W {meta.barsCounts['W']} · M {meta.barsCounts['M']} · DXY {meta.barsCounts.dxy1h}
          <span className="ml-3">Twelve Data used: {meta.used}/{meta.limit} today ({meta.creditsUsed} this run)</span>
        </div>
      )}

      {results && (
        <div className={`grid grid-cols-1 ${results.length > 1 ? 'lg:grid-cols-2' : ''} gap-5`}>
          {results.map((r, ri) => (
            <div key={ri} className="bg-[#0B0F14] border border-[#1B232C] rounded-xl p-6">
              <div className="font-bold text-white mb-1">{r.name}</div>
              <div className="font-mono text-[10px] text-[#3A434D] mb-4">
                targetRR {r.params.targetRR} · htfMidRejMinCount {r.params.htfMidRejMinCount} · manual filter {r.params.useManualEntryFilter ? 'on' : 'off'} · DXY {r.params.useDxyFilter ? 'on' : 'off'}
              </div>

              <div className="flex items-center gap-6 mb-5">
                <div>
                  <div className="text-2xl font-bold text-[#34D399]">{r.summary.winRate !== null ? r.summary.winRate + '%' : '—'}</div>
                  <div className="font-mono text-[10px] text-[#7C8896]">win rate</div>
                </div>
                <div className="flex gap-4 font-mono text-xs">
                  <div className="text-center"><div className="text-[#34D399] font-bold">{r.summary.wins}</div><div className="text-[9px] text-[#7C8896]">wins</div></div>
                  <div className="text-center"><div className="text-[#F87171] font-bold">{r.summary.losses}</div><div className="text-[9px] text-[#7C8896]">losses</div></div>
                  <div className="text-center"><div className="text-[#7C8896] font-bold">{r.summary.stillOpen}</div><div className="text-[9px] text-[#7C8896]">open</div></div>
                </div>
              </div>

              <div className="space-y-2 mb-4">
                {Object.entries(r.summary.byType).map(([type, stats]) => (
                  <div key={type} className="flex justify-between font-mono text-xs">
                    <span className="text-[#7C8896]">{type.replace(/_/g, ' ')} <span className="text-[#3A434D]">· {stats.total}</span></span>
                    <span className="text-white">{stats.winRate !== null ? stats.winRate + '%' : '—'}</span>
                  </div>
                ))}
              </div>

              {r.summary.byPath && (r.summary.byPath.setup_a?.total > 0 || r.summary.byPath.setup_b?.total > 0) && (
                <div className="space-y-2 mb-4 pt-3 border-t border-[#1B232C]">
                  <div className="font-mono text-[9px] text-[#3A434D] uppercase mb-1">Sniper Confirmation, by path</div>
                  {Object.entries(r.summary.byPath).map(([path, stats]: [string, any]) => (
                    <div key={path} className="flex justify-between font-mono text-xs">
                      <span className="text-[#7C8896]">{path === 'setup_a' ? 'Setup A (CSOD+BOS)' : 'Setup B (realignment)'} <span className="text-[#3A434D]">· {stats.total}</span></span>
                      <span className="text-white">{stats.winRate !== null ? stats.winRate + '%' : '—'}</span>
                    </div>
                  ))}
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
                              <div>Entry {sig.entry.toFixed(2)} · SL {sig.sl.toFixed(2)} · TP {sig.tp.toFixed(2)}</div>
                              <div>Grade {sig.gradeValue}/7 · HTF rung {sig.htfRung} · exec {sig.execTf}m</div>
                              {sig.manualFilterPassed !== null && <div>Manual filter: {sig.manualFilterPassed ? 'passed' : 'failed'}</div>}
                              {sig.barsToResolve != null && <div>Resolved in {sig.barsToResolve} bars</div>}
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