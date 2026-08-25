// lib/backtest/engine.ts
//
// A hand-ported TypeScript replica of BRUNC AI SNIPER SIGNALS (Stage 11
// Pine script), built specifically so historical price data can be
// walked through the same logic the live script uses, without needing
// TradingView to execute it.
//
// HONESTY NOTE: Pine cannot be run outside TradingView, so this is a
// manual re-implementation, not the actual script. It's been written
// to mirror the Pine source section-by-section (same names, same
// order) specifically so it can be audited against it directly. Two
// approximations are unavoidable given available historical data:
//   - Twelve Data has no native 3-minute interval -- 3m reuses 5-minute
//     bars, matching the same convention already used in resolve-signals.
//   - No native yearly interval -- 12M boxes are built by grouping
//     monthly bars into calendar years.
// ATR is computed on 15m bars as a stand-in for "chart timeframe",
// since a backtest has no single equivalent of the live chart TF Pine
// normally reads ta.atr() from.
//
// REVISION NOTE: the first draft of this file computed Setup A's
// anyExecSellBOS/anyExecBuyBOS as a bare "did a BOS happen on this bar"
// check, skipping Pine's actual requirement that the exec timeframe
// must first be ARMED by a qualifying CSOD before a BOS counts. Setup B
// structurally needs the CSOD-only half of that same tracker
// (anyExecBuyCSOD/anyExecSellCSOD to know when to realign), and porting
// it properly for Setup B surfaced the gap in Setup A -- both are now
// fixed using one correctly-shared tracker, matching f_execCsodBosTracker.
//
// Treat results as informative, not proven correct, until cross-checked
// against real signals accumulating from the live script over time.

export interface Bar {
  time: string // ISO string, bar OPEN time
  open: number
  high: number
  low: number
  close: number
}

export interface BacktestParams {
  htfMidRejMinCount: number
  confirmDisplacementPct: number
  execCsodDisplacementPct: number
  pullbackDispMinPct: number
  pullbackDispMaxPct: number
  atrLen: number
  atrSLMult: number
  atrMinSLMult: number
  atrBufferMult: number
  targetRR: number
  swingPivotLen: number
  useDxyFilter: boolean
  dxyEmaLen: number
  useManualEntryFilter: boolean
  orderBlockMinDispPct: number
  orderBlockMaxAgeBars: number
  dojiBodyMaxPct: number
  rejectionWickMinPct: number
  londonOpenStartHour: number
  londonOpenEndHour: number
  nyOpenStartHour: number
  nyOpenEndHour: number
}

export const DEFAULT_PARAMS: BacktestParams = {
  htfMidRejMinCount: 2,
  confirmDisplacementPct: 15.0,
  execCsodDisplacementPct: 15.0,
  pullbackDispMinPct: 62.5,
  pullbackDispMaxPct: 75.0,
  atrLen: 14,
  atrSLMult: 2.5,
  atrMinSLMult: 0.5,
  atrBufferMult: 0.3,
  targetRR: 2.0,
  swingPivotLen: 3,
  useDxyFilter: true,
  dxyEmaLen: 50,
  useManualEntryFilter: true,
  orderBlockMinDispPct: 20.0,
  orderBlockMaxAgeBars: 96,
  dojiBodyMaxPct: 35.0,
  rejectionWickMinPct: 50.0,
  londonOpenStartHour: 8,
  londonOpenEndHour: 9,
  nyOpenStartHour: 13,
  nyOpenEndHour: 14,
}

export type Timeframe = '1' | '3' | '5' | '15' | '60' | '240' | 'D' | 'W' | 'M' | '12M'

export interface SimulatedSignal {
  time: string
  signalType: 'precision' | 'sniper_confirmation'
  path: 'setup_a' | 'setup_b' | ''
  direction: 'buy' | 'sell'
  execTf: string
  htfRung: string
  entry: number
  sl: number
  tp: number
  gradeValue: number
  manualFilterPassed: boolean | null
  outcome: 'tp_hit' | 'stopped_out' | 'still_open'
  resolvedAt: string | null
  barsToResolve: number | null
}

export interface BacktestSummary {
  total: number
  wins: number
  losses: number
  stillOpen: number
  winRate: number | null
  byType: Record<string, { total: number; wins: number; winRate: number | null }>
  byPath: Record<string, { total: number; wins: number; winRate: number | null }>
}

export interface BoxEvent {
  time: string
  state: number
  refHigh: number
  refLow: number
  csod: boolean
  bos: boolean
  rejHighCount: number
  rejLowCount: number
  breakoutDist: number | null
}

export function computeBoxChain(bars: Bar[]): BoxEvent[] {
  const events: BoxEvent[] = []
  let state = 0
  let refHigh: number | null = null
  let refLow: number | null = null
  let rejHighCount = 0
  let rejLowCount = 0

  for (const bar of bars) {
    let csod = false
    let bos = false
    let breakoutDist: number | null = null

    if (refHigh == null || refLow == null) {
      refHigh = bar.high
      refLow = bar.low
      state = bar.close >= bar.open ? 1 : -1
      rejHighCount = 0
      rejLowCount = 0
    } else {
      const brokeUp = bar.close > refHigh
      const brokeDown = bar.close < refLow
      if (brokeUp || brokeDown) {
        const newState = brokeUp ? 1 : -1
        csod = newState !== state
        bos = newState === state
        breakoutDist = brokeUp ? bar.close - refHigh : refLow - bar.close
        refHigh = bar.high
        refLow = bar.low
        state = newState
        rejHighCount = 0
        rejLowCount = 0
      } else {
        if (bar.high > refHigh) rejHighCount++
        if (bar.low < refLow) rejLowCount++
      }
    }

    events.push({ time: bar.time, state, refHigh, refLow, csod, bos, rejHighCount, rejLowCount, breakoutDist })
  }
  return events
}

export function findAtOrBefore<T extends { time: string }>(events: T[], time: string): T | null {
  let lo = 0, hi = events.length - 1, result: T | null = null
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (events[mid].time < time) {
      result = events[mid]
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return result
}

export function computeATR(bars: Bar[], length: number): { time: string; value: number }[] {
  const out: { time: string; value: number }[] = []
  let prevClose: number | null = null
  let rma: number | null = null

  for (const bar of bars) {
    const tr = prevClose == null
      ? bar.high - bar.low
      : Math.max(bar.high - bar.low, Math.abs(bar.high - prevClose), Math.abs(bar.low - prevClose))

    rma = rma == null ? tr : (rma * (length - 1) + tr) / length
    out.push({ time: bar.time, value: rma })
    prevClose = bar.close
  }
  return out
}

export function computeEMA(bars: Bar[], length: number): { time: string; value: number }[] {
  const out: { time: string; value: number }[] = []
  const k = 2 / (length + 1)
  let ema: number | null = null
  for (const bar of bars) {
    ema = ema == null ? bar.close : bar.close * k + ema * (1 - k)
    out.push({ time: bar.time, value: ema })
  }
  return out
}

export function computeProtectedSwing(bars: Bar[], len: number): { time: string; protHigh: number | null; protLow: number | null }[] {
  const out: { time: string; protHigh: number | null; protLow: number | null }[] = []
  let protHigh: number | null = null
  let protLow: number | null = null

  for (let i = 0; i < bars.length; i++) {
    const pivotIdx = i - len
    if (pivotIdx >= len) {
      const window = bars.slice(pivotIdx - len, pivotIdx + len + 1)
      const centerBar = bars[pivotIdx]
      const isHigh = window.every(b => b.high <= centerBar.high) && window.filter(b => b.high === centerBar.high).length === 1
      const isLow = window.every(b => b.low >= centerBar.low) && window.filter(b => b.low === centerBar.low).length === 1
      if (isHigh) protHigh = centerBar.high
      if (isLow) protLow = centerBar.low
    }

    const c = bars[i].close
    if (protHigh != null && c > protHigh) protHigh = null
    if (protLow != null && c < protLow) protLow = null

    out.push({ time: bars[i].time, protHigh, protLow })
  }
  return out
}

interface OBState {
  time: string
  obBuyLow: number | null
  obBuyHigh: number | null
  obBuyImpulseHigh: number | null
  obSellLow: number | null
  obSellHigh: number | null
  obSellImpulseLow: number | null
}

export function computeOrderBlocks(
  bars15m: Bar[],
  boxChain15m: BoxEvent[],
  params: BacktestParams
): OBState[] {
  const out: OBState[] = []
  let lastDownH: number | null = null, lastDownL: number | null = null
  let lastUpH: number | null = null, lastUpL: number | null = null
  let obBuyLow: number | null = null, obBuyHigh: number | null = null, obBuyImpulseHigh: number | null = null
  let obSellLow: number | null = null, obSellHigh: number | null = null, obSellImpulseLow: number | null = null
  let obBuyAge = 0, obSellAge = 0

  for (let i = 0; i < bars15m.length; i++) {
    const bar = bars15m[i]
    const box = boxChain15m[i]
    const boxRange = box.refHigh - box.refLow

    if (obBuyLow != null && bar.close < obBuyLow) { obBuyLow = null; obBuyHigh = null; obBuyImpulseHigh = null }
    if (obSellHigh != null && bar.close > obSellHigh) { obSellLow = null; obSellHigh = null; obSellImpulseLow = null }

    if (obBuyLow != null) {
      obBuyAge++
      if (obBuyAge > params.orderBlockMaxAgeBars) { obBuyLow = null; obBuyHigh = null; obBuyImpulseHigh = null }
    }
    if (obSellLow != null) {
      obSellAge++
      if (obSellAge > params.orderBlockMaxAgeBars) { obSellLow = null; obSellHigh = null; obSellImpulseLow = null }
    }

    if (obBuyLow != null) obBuyImpulseHigh = obBuyImpulseHigh == null ? bar.high : Math.max(obBuyImpulseHigh, bar.high)
    if (obSellLow != null) obSellImpulseLow = obSellImpulseLow == null ? bar.low : Math.min(obSellImpulseLow, bar.low)

    if (bar.close < bar.open) { lastDownH = bar.high; lastDownL = bar.low }
    if (bar.close > bar.open) { lastUpH = bar.high; lastUpL = bar.low }

    const minDisp = boxRange > 0 ? boxRange * params.orderBlockMinDispPct / 100 : 0
    const qualifies = (box.csod || box.bos) && box.breakoutDist != null && box.breakoutDist >= minDisp

    if (qualifies && box.state === 1 && lastDownH != null) {
      obBuyLow = lastDownL; obBuyHigh = lastDownH; obBuyImpulseHigh = bar.high; obBuyAge = 0
    }
    if (qualifies && box.state === -1 && lastUpH != null) {
      obSellLow = lastUpL; obSellHigh = lastUpH; obSellImpulseLow = bar.low; obSellAge = 0
    }

    out.push({ time: bar.time, obBuyLow, obBuyHigh, obBuyImpulseHigh, obSellLow, obSellHigh, obSellImpulseLow })
  }
  return out
}

function isDoji(bar: Bar, maxBodyPct: number): boolean {
  const range = bar.high - bar.low
  const body = Math.abs(bar.close - bar.open)
  return range > 0 && body <= range * maxBodyPct / 100
}
function isRejectionBuy(bar: Bar, minWickPct: number): boolean {
  const range = bar.high - bar.low
  const lowerWick = Math.min(bar.open, bar.close) - bar.low
  return range > 0 && lowerWick >= range * minWickPct / 100
}
function isRejectionSell(bar: Bar, minWickPct: number): boolean {
  const range = bar.high - bar.low
  const upperWick = bar.high - Math.max(bar.open, bar.close)
  return range > 0 && upperWick >= range * minWickPct / 100
}
function scanRecentBuy(bars1m: Bar[], idx: number, params: BacktestParams): boolean {
  for (let k = 1; k <= 5; k++) {
    const b = bars1m[idx - k]
    if (!b) continue
    if (isDoji(b, params.dojiBodyMaxPct) || isRejectionBuy(b, params.rejectionWickMinPct)) return true
  }
  return false
}
function scanRecentSell(bars1m: Bar[], idx: number, params: BacktestParams): boolean {
  for (let k = 1; k <= 5; k++) {
    const b = bars1m[idx - k]
    if (!b) continue
    if (isDoji(b, params.dojiBodyMaxPct) || isRejectionSell(b, params.rejectionWickMinPct)) return true
  }
  return false
}

export function walkForOutcome(
  bars1m: Bar[],
  fromIdx: number,
  direction: 'buy' | 'sell',
  sl: number,
  tp: number
): { outcome: 'tp_hit' | 'stopped_out' | 'still_open'; resolvedAt: string | null; barsToResolve: number | null } {
  for (let i = fromIdx + 1; i < bars1m.length; i++) {
    const bar = bars1m[i]
    const slTouched = direction === 'buy' ? bar.low <= sl : bar.high >= sl
    const tpTouched = direction === 'buy' ? bar.high >= tp : bar.low <= tp
    if (slTouched) return { outcome: 'stopped_out', resolvedAt: bar.time, barsToResolve: i - fromIdx }
    if (tpTouched) return { outcome: 'tp_hit', resolvedAt: bar.time, barsToResolve: i - fromIdx }
  }
  return { outcome: 'still_open', resolvedAt: null, barsToResolve: null }
}

function calcExitsHtfSourced(
  direction: 'buy' | 'sell', price: number, srcHigh: number, srcLow: number,
  protSwing: { protHigh: number | null; protLow: number | null } | null,
  atr: number, params: BacktestParams
): { sl: number; tp: number } {
  const maxSLDistance = atr * params.atrSLMult
  const slBufferUnits = atr * params.atrBufferMult
  const boxEdge = direction === 'sell' ? srcHigh : srcLow
  const swingRef = direction === 'sell' ? protSwing?.protHigh ?? null : protSwing?.protLow ?? null

  const rawSL = direction === 'sell'
    ? (swingRef != null && swingRef < boxEdge && swingRef > price ? swingRef : boxEdge)
    : (swingRef != null && swingRef > boxEdge && swingRef < price ? swingRef : boxEdge)

  const bufferedSL = direction === 'sell' ? rawSL + slBufferUnits : rawSL - slBufferUnits
  const sl = direction === 'sell'
    ? Math.min(bufferedSL, price + maxSLDistance)
    : Math.max(bufferedSL, price - maxSLDistance)

  const riskDist = Math.abs(price - sl)
  const tp = direction === 'sell' ? price - riskDist * params.targetRR : price + riskDist * params.targetRR
  return { sl, tp }
}

function calcExitsMidpointSourced(
  direction: 'buy' | 'sell', price: number, srcHigh: number, srcLow: number,
  atr: number, params: BacktestParams
): { sl: number; tp: number } {
  const maxSLDistance = atr * params.atrSLMult
  const slBufferUnits = atr * params.atrBufferMult
  const midpoint = (srcHigh + srcLow) / 2
  const rawSL = direction === 'buy' ? midpoint - slBufferUnits : midpoint + slBufferUnits
  const sl = direction === 'buy' ? Math.max(rawSL, price - maxSLDistance) : Math.min(rawSL, price + maxSLDistance)
  const riskDist = Math.abs(price - sl)
  const tp = direction === 'buy' ? price + riskDist * params.targetRR : price - riskDist * params.targetRR
  return { sl, tp }
}

interface ExecTracker { armed: boolean; bosSeen: boolean }

function updateExecTracker(trk: ExecTracker, csodDispOK: boolean, bosNow: boolean, stateNow: number, wantDir: number) {
  if (stateNow !== wantDir) { trk.armed = false; trk.bosSeen = false }
  if (csodDispOK) { trk.armed = true; trk.bosSeen = false }
  if (trk.armed && bosNow && stateNow === wantDir) trk.bosSeen = true
}

interface SetupBTracker {
  armedDir: number
  waitingRevert: boolean
  waitingRealign: boolean
  usedThisLeg: boolean
}

function updateSetupBTracker(
  trk: SetupBTracker,
  st: number, refHigh: number, refLow: number,
  csodX: boolean, bosX: boolean, breakoutDist: number | null, boxRange: number,
  livePrice: number, params: BacktestParams,
  anyExecBuyCSOD: boolean, anyExecSellCSOD: boolean,
  buyFadeCycleOK: boolean, sellFadeCycleOK: boolean,
  dxyConfirmsBuy: boolean, dxyConfirmsSell: boolean
): boolean {
  let fired = false

  if (csodX && trk.usedThisLeg && trk.armedDir !== st) {
    trk.usedThisLeg = false
    trk.armedDir = 0
    trk.waitingRevert = false
    trk.waitingRealign = false
  }

  const minDisp = boxRange > 0 ? boxRange * params.confirmDisplacementPct / 100 : 0
  const dOK = minDisp <= 0 || (breakoutDist != null && breakoutDist >= minDisp)
  if ((csodX || bosX) && dOK && !trk.usedThisLeg) {
    trk.armedDir = st
    trk.waitingRevert = true
    trk.waitingRealign = false
    trk.usedThisLeg = true
  }

  if (trk.waitingRevert && trk.armedDir !== 0) {
    const halfRange = (refHigh - refLow) / 2
    const midpoint = (refHigh + refLow) / 2
    let dPct: number | null = null
    let isValidSetup = false
    if (halfRange > 0) {
      if (trk.armedDir === 1) {
        dPct = (refHigh - livePrice) / halfRange * 100
        isValidSetup = livePrice < refHigh && livePrice > midpoint
      } else if (trk.armedDir === -1) {
        dPct = (livePrice - refLow) / halfRange * 100
        isValidSetup = livePrice > refLow && livePrice < midpoint
      }
    }
    const qualifies = isValidSetup && dPct != null && dPct >= params.pullbackDispMinPct && dPct <= params.pullbackDispMaxPct
    if (qualifies) {
      trk.waitingRevert = false
      trk.waitingRealign = true
    }
  }

  if (trk.waitingRealign && trk.armedDir !== 0) {
    const realignCSOD = trk.armedDir === 1 ? anyExecBuyCSOD : anyExecSellCSOD
    const cycleOK = trk.armedDir === 1 ? buyFadeCycleOK : trk.armedDir === -1 ? sellFadeCycleOK : true
    const dxyOK = trk.armedDir === 1 ? dxyConfirmsBuy : trk.armedDir === -1 ? dxyConfirmsSell : true
    if (realignCSOD && cycleOK && dxyOK) {
      fired = true
      trk.waitingRealign = false
    }
  }

  return fired
}

function execTfForSetupB(dir: number, trackers: Record<string, ExecTracker>): string {
  if (dir === 1) {
    if (trackers.buy1.armed) return '1'
    if (trackers.buy3.armed) return '3'
    return '5'
  }
  if (trackers.sell1.armed) return '1'
  if (trackers.sell3.armed) return '3'
  return '5'
}

export interface BarsByTF {
  '1': Bar[]
  '3': Bar[]
  '5': Bar[]
  '15': Bar[]
  '60': Bar[]
  '240': Bar[]
  'D': Bar[]
  'W': Bar[]
  'M': Bar[]
  '12M': Bar[]
  dxy60: Bar[]
}

export function runBacktest(barsByTF: BarsByTF, params: BacktestParams): SimulatedSignal[] {
  const chains: Record<Timeframe, BoxEvent[]> = {
    '1': computeBoxChain(barsByTF['1']),
    '3': computeBoxChain(barsByTF['3']),
    '5': computeBoxChain(barsByTF['5']),
    '15': computeBoxChain(barsByTF['15']),
    '60': computeBoxChain(barsByTF['60']),
    '240': computeBoxChain(barsByTF['240']),
    'D': computeBoxChain(barsByTF['D']),
    'W': computeBoxChain(barsByTF['W']),
    'M': computeBoxChain(barsByTF['M']),
    '12M': computeBoxChain(barsByTF['12M']),
  }

  const atr15 = computeATR(barsByTF['15'], params.atrLen)
  const dxyEma = computeEMA(barsByTF.dxy60, params.dxyEmaLen)
  const protSwing5 = computeProtectedSwing(barsByTF['5'], params.swingPivotLen)
  const orderBlocks = computeOrderBlocks(barsByTF['15'], chains['15'], params)

  const signals: SimulatedSignal[] = []
  const bars1m = barsByTF['1']

  function grade(dir: number, atIdx: number): number {
    const tiers: Timeframe[] = ['15', '60', '240', 'D', 'W', 'M', '12M']
    return tiers.reduce((acc, tf) => {
      const ev = findAtOrBefore(chains[tf], bars1m[atIdx].time)
      return acc + (ev && ev.state === dir ? 1 : 0)
    }, 0)
  }

  const setupATrackers: Record<string, { usedSell: boolean; usedBuy: boolean; prevRawSell: boolean; prevRawBuy: boolean }> = {}
  const setupBTrackers: Record<string, SetupBTracker> = {}
  for (const tag of ['15', '60', '240', 'D', 'W', 'M', '12M']) {
    setupATrackers[tag] = { usedSell: false, usedBuy: false, prevRawSell: false, prevRawBuy: false }
    setupBTrackers[tag] = { armedDir: 0, waitingRevert: false, waitingRealign: false, usedThisLeg: false }
  }

  const execTrackers: Record<string, ExecTracker> = {
    sell1: { armed: false, bosSeen: false }, sell3: { armed: false, bosSeen: false }, sell5: { armed: false, bosSeen: false },
    buy1: { armed: false, bosSeen: false }, buy3: { armed: false, bosSeen: false }, buy5: { armed: false, bosSeen: false },
  }

  for (let i = 0; i < bars1m.length; i++) {
    const bar1m = bars1m[i]
    const t = bar1m.time

    const s15 = findAtOrBefore(chains['15'], t)
    const s60 = findAtOrBefore(chains['60'], t)
    const s240 = findAtOrBefore(chains['240'], t)
    const sD = findAtOrBefore(chains['D'], t)
    const sW = findAtOrBefore(chains['W'], t)
    const sM = findAtOrBefore(chains['M'], t)
    const s12M = findAtOrBefore(chains['12M'], t)
    const s1 = findAtOrBefore(chains['1'], t)
    const s3 = findAtOrBefore(chains['3'], t)
    const s5 = findAtOrBefore(chains['5'], t)
    if (!s15 || !s60 || !s240 || !sD || !sW || !sM || !s12M || !s1) continue

    const atrEv = findAtOrBefore(atr15, t)
    const atrValue = atrEv?.value ?? 0
    if (atrValue <= 0) continue
    const minSLDistance = atrValue * params.atrMinSLMult

    const dxyC = findAtOrBefore(barsByTF.dxy60, t)
    const dxyEmaEv = findAtOrBefore(dxyEma, t)
    let dxyConfirmsBuy = true, dxyConfirmsSell = true
    if (params.useDxyFilter && dxyC && dxyEmaEv) {
      dxyConfirmsBuy = dxyC.close < dxyEmaEv.value
      dxyConfirmsSell = dxyC.close > dxyEmaEv.value
    }

    const rejTiers = [s60, s240, sD, sW, sM, s12M]
    const midRejSellCount = rejTiers.filter(ev => ev.rejHighCount >= 2).length
    const midRejBuyCount = rejTiers.filter(ev => ev.rejLowCount >= 2).length
    const anyHtfMidRejSell = midRejSellCount >= params.htfMidRejMinCount
    const anyHtfMidRejBuy = midRejBuyCount >= params.htfMidRejMinCount

    const cycleDir = precisionCycleDirAt(chains['15'], barsByTF['15'], t)

    const protSwing = findAtOrBefore(protSwing5, t)
    const ob = findAtOrBefore(orderBlocks, t)

    const inLondonOrNYOpen = (() => {
      const h = new Date(t).getUTCHours()
      return (h >= params.londonOpenStartHour && h < params.londonOpenEndHour) ||
             (h >= params.nyOpenStartHour && h < params.nyOpenEndHour)
    })()

    const sellFadeCycleOK = s240.state === 0 || s240.state === -1 || (s240.state === 1 && s240.rejLowCount > 0)
    const buyFadeCycleOK = s240.state === 0 || s240.state === 1 || (s240.state === -1 && s240.rejHighCount > 0)

    const box1Range = s1.refHigh - s1.refLow
    const box3Range = s3 ? s3.refHigh - s3.refLow : 0
    const box5Range = s5 ? s5.refHigh - s5.refLow : 0
    const minExecDisp1 = box1Range > 0 ? box1Range * params.execCsodDisplacementPct / 100 : 0
    const minExecDisp3 = box3Range > 0 ? box3Range * params.execCsodDisplacementPct / 100 : 0
    const minExecDisp5 = box5Range > 0 ? box5Range * params.execCsodDisplacementPct / 100 : 0

    const sellCsod1Disp = s1.csod && s1.state === -1 && (s1.breakoutDist ?? 0) >= minExecDisp1
    const sellCsod3Disp = !!s3 && s3.csod && s3.state === -1 && (s3.breakoutDist ?? 0) >= minExecDisp3
    const sellCsod5Disp = !!s5 && s5.csod && s5.state === -1 && (s5.breakoutDist ?? 0) >= minExecDisp5
    const buyCsod1Disp = s1.csod && s1.state === 1 && (s1.breakoutDist ?? 0) >= minExecDisp1
    const buyCsod3Disp = !!s3 && s3.csod && s3.state === 1 && (s3.breakoutDist ?? 0) >= minExecDisp3
    const buyCsod5Disp = !!s5 && s5.csod && s5.state === 1 && (s5.breakoutDist ?? 0) >= minExecDisp5

    updateExecTracker(execTrackers.sell1, sellCsod1Disp, s1.bos, s1.state, -1)
    updateExecTracker(execTrackers.sell3, sellCsod3Disp, s3?.bos ?? false, s3?.state ?? 0, -1)
    updateExecTracker(execTrackers.sell5, sellCsod5Disp, s5?.bos ?? false, s5?.state ?? 0, -1)
    updateExecTracker(execTrackers.buy1, buyCsod1Disp, s1.bos, s1.state, 1)
    updateExecTracker(execTrackers.buy3, buyCsod3Disp, s3?.bos ?? false, s3?.state ?? 0, 1)
    updateExecTracker(execTrackers.buy5, buyCsod5Disp, s5?.bos ?? false, s5?.state ?? 0, 1)

    const anyExecSellCSOD = execTrackers.sell1.armed || execTrackers.sell3.armed || execTrackers.sell5.armed
    const anyExecBuyCSOD = execTrackers.buy1.armed || execTrackers.buy3.armed || execTrackers.buy5.armed
    const anyExecSellBOS = execTrackers.sell1.bosSeen || execTrackers.sell3.bosSeen || execTrackers.sell5.bosSeen
    const anyExecBuyBOS = execTrackers.buy1.bosSeen || execTrackers.buy3.bosSeen || execTrackers.buy5.bosSeen

    const minPrecDisp = (box: BoxEvent) => (box.refHigh - box.refLow) * params.confirmDisplacementPct / 100
    const precisionBuyCsod = s1.csod && s1.state === 1 && (s1.breakoutDist ?? 0) >= minPrecDisp(s1)
      || (s3 && s3.csod && s3.state === 1 && (s3.breakoutDist ?? 0) >= minPrecDisp(s3))
      || (s5 && s5.csod && s5.state === 1 && (s5.breakoutDist ?? 0) >= minPrecDisp(s5))
    const precisionSellCsod = s1.csod && s1.state === -1 && (s1.breakoutDist ?? 0) >= minPrecDisp(s1)
      || (s3 && s3.csod && s3.state === -1 && (s3.breakoutDist ?? 0) >= minPrecDisp(s3))
      || (s5 && s5.csod && s5.state === -1 && (s5.breakoutDist ?? 0) >= minPrecDisp(s5))

    if (cycleDir === 1 && anyHtfMidRejBuy && dxyConfirmsBuy && precisionBuyCsod) {
      let manualOK: boolean | null = null
      if (params.useManualEntryFilter) {
        const biasOK = s60.state === 1
        const zoneOK = ob != null && ob.obBuyLow != null && ob.obBuyHigh != null && bar1m.low <= ob.obBuyHigh && bar1m.high >= ob.obBuyLow
        const fibOK = ob != null && ob.obBuyImpulseHigh != null && ob.obBuyLow != null && ob.obBuyImpulseHigh > ob.obBuyLow &&
          bar1m.close < (ob.obBuyImpulseHigh + ob.obBuyLow) / 2
        const dojiOK = scanRecentBuy(bars1m, i, params)
        manualOK = biasOK && inLondonOrNYOpen && zoneOK && fibOK && dojiOK
      }
      if (!params.useManualEntryFilter || manualOK) {
        const { sl, tp } = calcExitsHtfSourced('buy', bar1m.close, s15.refHigh, s15.refLow, protSwing, atrValue, params)
        if (Math.abs(bar1m.close - sl) >= minSLDistance) {
          const { outcome, resolvedAt, barsToResolve } = walkForOutcome(bars1m, i, 'buy', sl, tp)
          signals.push({
            time: t, signalType: 'precision', path: '', direction: 'buy',
            execTf: '1', htfRung: precisionHtfRung(rejTiers, false),
            entry: bar1m.close, sl, tp, gradeValue: grade(1, i),
            manualFilterPassed: manualOK, outcome, resolvedAt, barsToResolve,
          })
        }
      }
    }

    if (cycleDir === -1 && anyHtfMidRejSell && dxyConfirmsSell && precisionSellCsod) {
      let manualOK: boolean | null = null
      if (params.useManualEntryFilter) {
        const biasOK = s60.state === -1
        const zoneOK = ob != null && ob.obSellLow != null && ob.obSellHigh != null && bar1m.low <= ob.obSellHigh && bar1m.high >= ob.obSellLow
        const fibOK = ob != null && ob.obSellHigh != null && ob.obSellImpulseLow != null && ob.obSellHigh > ob.obSellImpulseLow &&
          bar1m.close > (ob.obSellHigh + ob.obSellImpulseLow) / 2
        const dojiOK = scanRecentSell(bars1m, i, params)
        manualOK = biasOK && inLondonOrNYOpen && zoneOK && fibOK && dojiOK
      }
      if (!params.useManualEntryFilter || manualOK) {
        const { sl, tp } = calcExitsHtfSourced('sell', bar1m.close, s15.refHigh, s15.refLow, protSwing, atrValue, params)
        if (Math.abs(bar1m.close - sl) >= minSLDistance) {
          const { outcome, resolvedAt, barsToResolve } = walkForOutcome(bars1m, i, 'sell', sl, tp)
          signals.push({
            time: t, signalType: 'precision', path: '', direction: 'sell',
            execTf: '1', htfRung: precisionHtfRung(rejTiers, true),
            entry: bar1m.close, sl, tp, gradeValue: grade(-1, i),
            manualFilterPassed: manualOK, outcome, resolvedAt, barsToResolve,
          })
        }
      }
    }

    const htfTiers: { ev: BoxEvent; tag: string }[] = [
      { ev: s15, tag: '15' }, { ev: s60, tag: '60' }, { ev: s240, tag: '240' },
      { ev: sD, tag: 'D' }, { ev: sW, tag: 'W' }, { ev: sM, tag: 'M' }, { ev: s12M, tag: '12M' },
    ]

    const setupAFiredThisBar: { tag: string; dir: 'sell' | 'buy'; ev: BoxEvent }[] = []
    for (const { ev, tag } of htfTiers) {
      const trk = setupATrackers[tag]

      if (ev.csod) trk.usedSell = false
      const rawSell = ev.state === -1 && anyExecSellBOS && sellFadeCycleOK && dxyConfirmsSell
      const firedSell = rawSell && !trk.usedSell && !trk.prevRawSell
      if (firedSell) trk.usedSell = true
      trk.prevRawSell = rawSell
      if (firedSell) setupAFiredThisBar.push({ tag, dir: 'sell', ev })

      if (ev.csod) trk.usedBuy = false
      const rawBuy = ev.state === 1 && anyExecBuyBOS && buyFadeCycleOK && dxyConfirmsBuy
      const firedBuy = rawBuy && !trk.usedBuy && !trk.prevRawBuy
      if (firedBuy) trk.usedBuy = true
      trk.prevRawBuy = rawBuy
      if (firedBuy) setupAFiredThisBar.push({ tag, dir: 'buy', ev })
    }

    if (setupAFiredThisBar.length > 0) {
      const priority: { tag: string; dir: 'sell' | 'buy' }[] = []
      for (const tag of ['15', '60', '240', 'D', 'W', 'M', '12M']) {
        priority.push({ tag, dir: 'sell' })
        priority.push({ tag, dir: 'buy' })
      }
      let selected: { tag: string; dir: 'sell' | 'buy'; ev: BoxEvent } | undefined
      for (const p of priority) {
        selected = setupAFiredThisBar.find(f => f.tag === p.tag && f.dir === p.dir)
        if (selected) break
      }

      if (selected) {
        const dirNum = selected.dir === 'sell' ? -1 : 1
        const { sl, tp } = calcExitsHtfSourced(selected.dir, bar1m.close, selected.ev.refHigh, selected.ev.refLow, protSwing, atrValue, params)
        if (Math.abs(bar1m.close - sl) >= minSLDistance) {
          const { outcome, resolvedAt, barsToResolve } = walkForOutcome(bars1m, i, selected.dir, sl, tp)
          signals.push({
            time: t, signalType: 'sniper_confirmation', path: 'setup_a', direction: selected.dir,
            execTf: execTfFor(s1, s3, s5, dirNum), htfRung: selected.tag,
            entry: bar1m.close, sl, tp, gradeValue: grade(dirNum, i),
            manualFilterPassed: null, outcome, resolvedAt, barsToResolve,
          })
        }
      }
    }

    const setupBFiredThisBar: { tag: string; dir: number; ev: BoxEvent }[] = []
    for (const { ev, tag } of htfTiers) {
      const trk = setupBTrackers[tag]
      const boxRange = ev.refHigh - ev.refLow
      const fired = updateSetupBTracker(
        trk, ev.state, ev.refHigh, ev.refLow, ev.csod, ev.bos, ev.breakoutDist, boxRange,
        bar1m.close, params, anyExecBuyCSOD, anyExecSellCSOD, buyFadeCycleOK, sellFadeCycleOK,
        dxyConfirmsBuy, dxyConfirmsSell
      )
      if (fired) setupBFiredThisBar.push({ tag, dir: trk.armedDir, ev })
    }

    if (setupBFiredThisBar.length > 0) {
      const orderTags = ['15', '60', '240', 'D', 'W', 'M', '12M']
      let selectedB: { tag: string; dir: number; ev: BoxEvent } | undefined
      for (const tag of orderTags) {
        selectedB = setupBFiredThisBar.find(f => f.tag === tag)
        if (selectedB) break
      }

      if (selectedB) {
        const dirTxt: 'buy' | 'sell' = selectedB.dir === 1 ? 'buy' : 'sell'
        const { sl, tp } = calcExitsMidpointSourced(dirTxt, bar1m.close, selectedB.ev.refHigh, selectedB.ev.refLow, atrValue, params)
        if (Math.abs(bar1m.close - sl) >= minSLDistance) {
          const { outcome, resolvedAt, barsToResolve } = walkForOutcome(bars1m, i, dirTxt, sl, tp)
          signals.push({
            time: t, signalType: 'sniper_confirmation', path: 'setup_b', direction: dirTxt,
            execTf: execTfForSetupB(selectedB.dir, execTrackers), htfRung: selectedB.tag,
            entry: bar1m.close, sl, tp, gradeValue: grade(selectedB.dir, i),
            manualFilterPassed: null, outcome, resolvedAt, barsToResolve,
          })
        }
      }
    }
  }

  return signals
}

function execTfFor(s1: BoxEvent, s3: BoxEvent | null, s5: BoxEvent | null, dir: number): string {
  if (s1.state === dir && s1.bos) return '1'
  if (s3 && s3.state === dir && s3.bos) return '3'
  if (s5 && s5.state === dir && s5.bos) return '5'
  return '1'
}

function precisionHtfRung(rejTiers: BoxEvent[], isSell: boolean): string {
  const tags = ['60', '240', 'D', 'W', 'M', '12M']
  for (let idx = 0; idx < rejTiers.length; idx++) {
    const count = isSell ? rejTiers[idx].rejHighCount : rejTiers[idx].rejLowCount
    if (count >= 2) return tags[idx]
  }
  return '12M'
}

const cycleCache = new Map<string, number>()
function precisionCycleDirAt(chain15: BoxEvent[], bars15: Bar[], t: string): number {
  const cacheKey = t
  if (cycleCache.has(cacheKey)) return cycleCache.get(cacheKey)!

  let cycleDir = 0
  let wasOutsideLow = false
  let wasOutsideHigh = false

  for (let idx = 0; idx < bars15.length; idx++) {
    const box = chain15[idx]
    if (box.time >= t) break
    if (box.csod) { cycleDir = 0; wasOutsideLow = false; wasOutsideHigh = false }

    const nowOutsideLow = box.state === 1 && bars15[idx].close < box.refLow
    const nowOutsideHigh = box.state === -1 && bars15[idx].close > box.refHigh
    const nowInside = bars15[idx].close >= box.refLow && bars15[idx].close <= box.refHigh

    if (wasOutsideLow && nowInside) cycleDir = 1
    if (wasOutsideHigh && nowInside) cycleDir = -1
    wasOutsideLow = nowOutsideLow
    wasOutsideHigh = nowOutsideHigh
  }

  cycleCache.set(cacheKey, cycleDir)
  return cycleDir
}

export function summarize(signals: SimulatedSignal[]): BacktestSummary {
  const resolved = signals.filter(s => s.outcome !== 'still_open')
  const wins = resolved.filter(s => s.outcome === 'tp_hit').length
  const losses = resolved.filter(s => s.outcome === 'stopped_out').length
  const stillOpen = signals.length - resolved.length

  const byType: BacktestSummary['byType'] = {}
  for (const key of ['precision', 'sniper_confirmation']) {
    const group = resolved.filter(s => s.signalType === key)
    const gWins = group.filter(s => s.outcome === 'tp_hit').length
    byType[key] = { total: group.length, wins: gWins, winRate: group.length ? Math.round((gWins / group.length) * 1000) / 10 : null }
  }

  const byPath: BacktestSummary['byPath'] = {}
  for (const key of ['setup_a', 'setup_b']) {
    const group = resolved.filter(s => s.path === key)
    const gWins = group.filter(s => s.outcome === 'tp_hit').length
    byPath[key] = { total: group.length, wins: gWins, winRate: group.length ? Math.round((gWins / group.length) * 1000) / 10 : null }
  }

  return {
    total: signals.length,
    wins,
    losses,
    stillOpen,
    winRate: resolved.length ? Math.round((wins / resolved.length) * 1000) / 10 : null,
    byType,
    byPath,
  }
}