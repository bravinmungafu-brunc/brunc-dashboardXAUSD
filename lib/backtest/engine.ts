// lib/backtest/engine.ts
//
// A hand-ported TypeScript replica of BRUVV AI SNIPER SIGNALS, built
// specifically so historical price data can be walked through the
// same logic the live script uses, without needing TradingView to
// execute it.
//
// STAGE SYNC (this rewrite) -- the engine had genuinely drifted from
// what's actually live in BRUVV, confirmed by direct comparison
// against the real Pine source before touching anything here, not
// assumed:
//   1. SL sizing: was ATR-multiple based (atrSLMult/atrMinSLMult/
//      atrBufferMult). BRUVV moved to a flat, broker-independent
//      point system at Stage 26 (maxSLPoints/slBufferPointsFlat/
//      minSLPoints), reverted to a 500pt hard cap at Stage 34/35.
//      Replaced entirely -- ATR is no longer used for exits at all.
//   2. TP sizing: was one fixed targetRR multiplier. BRUVV picks from
//      a whole ladder of allowed ratios (sniperRRLevels/
//      precisionRRLevels) based on the nearest real structural level
//      beyond entry (Stage 18's f_pickNearestRR). Replaced entirely.
//   3. Exit anchor: was two separate functions -- calcExitsHtfSourced
//      (Setup A/Precision, anchored to whichever HTF box sourced the
//      signal) and calcExitsMidpointSourced (Setup B, anchored to the
//      HTF box midpoint). BRUVV unified these into ONE f_calcSL at
//      Stage 26 -- ALWAYS anchored to the 15m box + protected swing,
//      regardless of which HTF justified the signal or which setup
//      fired. Replaced with one calcSL function, used identically by
//      all three signal types, matching Pine exactly.
//   4. Gating: Setup A, Setup B's realign stage, and Precision all
//      required DXY agreement in the old engine. Direct comparison
//      against a reference script at Stage 36 found this was an
//      extra gate BRUVV's own design never called for -- removed from
//      all three. Precision ALSO required a 5-part Manual Entry
//      Filter in the old engine; Stage 36 found BRUVV's real
//      Precision needs just 3 conditions (cycle + HTF mid-rejection +
//      exec CSOD), not 5. Both extra gates removed here to match.
//   5. Two defaults had silently drifted independent of the above:
//      execCsodDisplacementPct (was 15.0, BRUVV's real value since
//      Stage 20 is 8.0) and the London/NY session hours (were the
//      old narrow 1-hour windows, BRUVV's real values since Stage 27
//      are the wide session ranges) -- though since the Manual Entry
//      Filter no longer gates anything, session hours no longer
//      affect firing at all in the current script; kept in the
//      interface only for potential future use, not consumed by any
//      gating logic below.
//
// HONESTY NOTE: Pine cannot be run outside TradingView, so this is a
// manual re-implementation, not the actual script. Two approximations
// are unavoidable given available historical data:
//   - Twelve Data has no native 3-minute interval -- 3m reuses 5-minute
//     bars, matching the same convention used elsewhere in this project.
//   - No native yearly interval -- 12M boxes are built by grouping
//     monthly bars into calendar years.
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
  maxSLPoints: number
  slBufferPointsFlat: number
  minSLPoints: number
  sniperRRLevels: number[]
  precisionRRLevels: number[]
  swingPivotLen: number
}

export const DEFAULT_PARAMS: BacktestParams = {
  htfMidRejMinCount: 2,
  confirmDisplacementPct: 15.0,
  execCsodDisplacementPct: 8.0, // STAGE SYNC: was 15.0, BRUVV's real value since Stage 20
  pullbackDispMinPct: 62.5,
  pullbackDispMaxPct: 75.0,
  maxSLPoints: 500,             // STAGE SYNC: hard cap, matches BRUVV Stage 34/35
  slBufferPointsFlat: 150,
  minSLPoints: 50,
  sniperRRLevels: [3, 4, 5, 6, 7, 8, 9, 10],
  precisionRRLevels: [2, 3, 4],
  swingPivotLen: 3,
}

const POINT_VALUE = 0.01 // flat, matches BRUVV Stage 35's reverted pointValue

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
  rrUsed: number
  gradeValue: number
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
  netPoints: number
  avgPointsPerSignal: number | null
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

// STAGE SYNC: replaces BOTH calcExitsHtfSourced and calcExitsMidpointSourced.
// BRUVV's Stage 26 unification: SL is ALWAYS anchored to the 15m box +
// protected swing, regardless of which HTF sourced the signal or
// which setup fired -- matches f_calcSL exactly.
function calcSL(
  direction: 'buy' | 'sell', entryPrice: number,
  h15: number, l15: number,
  protSwingHigh: number | null, protSwingLow: number | null,
  params: BacktestParams
): number {
  const price = entryPrice
  const maxSLDistance = params.maxSLPoints * POINT_VALUE
  const slBufferUnits = params.slBufferPointsFlat * POINT_VALUE

  const boxEdge = direction === 'sell' ? h15 : l15
  const swingRef = direction === 'sell' ? protSwingHigh : protSwingLow

  const rawSL = direction === 'sell'
    ? (swingRef != null && swingRef < boxEdge && swingRef > price ? swingRef : boxEdge)
    : (swingRef != null && swingRef > boxEdge && swingRef < price ? swingRef : boxEdge)

  const bufferedSL = direction === 'sell' ? rawSL + slBufferUnits : rawSL - slBufferUnits
  const slOnCorrectSide = direction === 'sell' ? bufferedSL > price : bufferedSL < price

  return direction === 'sell'
    ? (slOnCorrectSide ? Math.min(bufferedSL, price + maxSLDistance) : price + maxSLDistance)
    : (slOnCorrectSide ? Math.max(bufferedSL, price - maxSLDistance) : price - maxSLDistance)
}

// STAGE SYNC: new -- matches f_pickNearestRR exactly. Looks at every
// real structural level (HTF box edges + protected swing) that sits
// beyond entry in the trade's favor, finds the nearest one, converts
// to an R:R given this signal's actual SL distance, and snaps to
// whichever ALLOWED ratio in rrLevels is closest -- never an
// arbitrary pick. Falls back to the minimum ratio if nothing valid.
function pickNearestRR(
  direction: 'buy' | 'sell', entryPrice: number, sl: number,
  candidates: (number | null)[], rrLevels: number[]
): number {
  const riskDist = Math.abs(entryPrice - sl)
  let bestDist: number | null = null

  if (riskDist > 0) {
    for (const lvl of candidates) {
      if (lvl == null) continue
      const dist = direction === 'sell' ? entryPrice - lvl : lvl - entryPrice
      if (dist > riskDist) {
        if (bestDist == null || dist < bestDist) bestDist = dist
      }
    }
  }

  const minRR = rrLevels[0]
  if (bestDist == null || riskDist <= 0) return minRR

  const targetRRRaw = bestDist / riskDist
  let closest = minRR
  let bestGap: number | null = null
  for (const rr of rrLevels) {
    const gap = Math.abs(rr - targetRRRaw)
    if (bestGap == null || gap < bestGap) {
      bestGap = gap
      closest = rr
    }
  }
  return closest
}

function buildSingleTP(direction: 'buy' | 'sell', entryPrice: number, sl: number, rr: number): number {
  const riskDist = Math.abs(entryPrice - sl)
  return direction === 'sell' ? entryPrice - riskDist * rr : entryPrice + riskDist * rr
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

// STAGE SYNC: removed the DXY parameters and dxyOK check from the
// realign stage -- Stage 36 found BRUVV's real Setup B only requires
// realignCSOD and cycleOK at this stage, not a third DXY-agreement
// condition.
function updateSetupBTracker(
  trk: SetupBTracker,
  st: number, refHigh: number, refLow: number,
  csodX: boolean, bosX: boolean, breakoutDist: number | null, boxRange: number,
  livePrice: number, params: BacktestParams,
  anyExecBuyCSOD: boolean, anyExecSellCSOD: boolean,
  buyFadeCycleOK: boolean, sellFadeCycleOK: boolean
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
    if (realignCSOD && cycleOK) {
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

  const protSwing5 = computeProtectedSwing(barsByTF['5'], params.swingPivotLen)

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

  const minSLDistance = params.minSLPoints * POINT_VALUE

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

    const protSwing = findAtOrBefore(protSwing5, t)

    const rejTiers = [s60, s240, sD, sW, sM, s12M]
    const midRejSellCount = rejTiers.filter(ev => ev.rejHighCount >= 2).length
    const midRejBuyCount = rejTiers.filter(ev => ev.rejLowCount >= 2).length
    const anyHtfMidRejSell = midRejSellCount >= params.htfMidRejMinCount
    const anyHtfMidRejBuy = midRejBuyCount >= params.htfMidRejMinCount

    const cycleDir = precisionCycleDirAt(chains['15'], barsByTF['15'], t)

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

    // STAGE SYNC: Precision -- 3 conditions only (cycle + HTF mid-rejection
    // + exec CSOD), matching BRUVV's real Stage 36 logic. DXY and the
    // 5-part Manual Entry Filter no longer gate this at all.
    if (cycleDir === 1 && anyHtfMidRejBuy && precisionBuyCsod) {
      const sl = calcSL('buy', bar1m.close, s15.refHigh, s15.refLow, protSwing?.protHigh ?? null, protSwing?.protLow ?? null, params)
      if (Math.abs(bar1m.close - sl) >= minSLDistance) {
        const candidates = [s60.refHigh, s60.refLow, s240.refHigh, s240.refLow, sD.refHigh, sD.refLow, sW.refHigh, sW.refLow, sM.refHigh, sM.refLow, s12M.refHigh, s12M.refLow, protSwing?.protHigh ?? null, protSwing?.protLow ?? null]
        const rrUsed = pickNearestRR('buy', bar1m.close, sl, candidates, params.precisionRRLevels)
        const tp = buildSingleTP('buy', bar1m.close, sl, rrUsed)
        const { outcome, resolvedAt, barsToResolve } = walkForOutcome(bars1m, i, 'buy', sl, tp)
        signals.push({
          time: t, signalType: 'precision', path: '', direction: 'buy',
          execTf: '1', htfRung: precisionHtfRung(rejTiers, false),
          entry: bar1m.close, sl, tp, rrUsed, gradeValue: grade(1, i),
          outcome, resolvedAt, barsToResolve,
        })
      }
    }

    if (cycleDir === -1 && anyHtfMidRejSell && precisionSellCsod) {
      const sl = calcSL('sell', bar1m.close, s15.refHigh, s15.refLow, protSwing?.protHigh ?? null, protSwing?.protLow ?? null, params)
      if (Math.abs(bar1m.close - sl) >= minSLDistance) {
        const candidates = [s60.refHigh, s60.refLow, s240.refHigh, s240.refLow, sD.refHigh, sD.refLow, sW.refHigh, sW.refLow, sM.refHigh, sM.refLow, s12M.refHigh, s12M.refLow, protSwing?.protHigh ?? null, protSwing?.protLow ?? null]
        const rrUsed = pickNearestRR('sell', bar1m.close, sl, candidates, params.precisionRRLevels)
        const tp = buildSingleTP('sell', bar1m.close, sl, rrUsed)
        const { outcome, resolvedAt, barsToResolve } = walkForOutcome(bars1m, i, 'sell', sl, tp)
        signals.push({
          time: t, signalType: 'precision', path: '', direction: 'sell',
          execTf: '1', htfRung: precisionHtfRung(rejTiers, true),
          entry: bar1m.close, sl, tp, rrUsed, gradeValue: grade(-1, i),
          outcome, resolvedAt, barsToResolve,
        })
      }
    }

    const htfTiers: { ev: BoxEvent; tag: string }[] = [
      { ev: s15, tag: '15' }, { ev: s60, tag: '60' }, { ev: s240, tag: '240' },
      { ev: sD, tag: 'D' }, { ev: sW, tag: 'W' }, { ev: sM, tag: 'M' }, { ev: s12M, tag: '12M' },
    ]

    // STAGE SYNC: Setup A -- 3 conditions only (context/position + BOS
    // + 4H cycle gate). DXY agreement no longer required.
    const setupAFiredThisBar: { tag: string; dir: 'sell' | 'buy'; ev: BoxEvent }[] = []
    for (const { ev, tag } of htfTiers) {
      const trk = setupATrackers[tag]

      if (ev.csod) trk.usedSell = false
      const rawSell = ev.state === -1 && anyExecSellBOS && sellFadeCycleOK
      const firedSell = rawSell && !trk.usedSell && !trk.prevRawSell
      if (firedSell) trk.usedSell = true
      trk.prevRawSell = rawSell
      if (firedSell) setupAFiredThisBar.push({ tag, dir: 'sell', ev })

      if (ev.csod) trk.usedBuy = false
      const rawBuy = ev.state === 1 && anyExecBuyBOS && buyFadeCycleOK
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
        // STAGE SYNC: ALWAYS anchored to 15m + protected swing now,
        // never the source HTF box's own edges (that's the whole
        // point of Stage 26's unification).
        const sl = calcSL(selected.dir, bar1m.close, s15.refHigh, s15.refLow, protSwing?.protHigh ?? null, protSwing?.protLow ?? null, params)
        if (Math.abs(bar1m.close - sl) >= minSLDistance) {
          const candidates = [s60.refHigh, s60.refLow, s240.refHigh, s240.refLow, sD.refHigh, sD.refLow, sW.refHigh, sW.refLow, sM.refHigh, sM.refLow, s12M.refHigh, s12M.refLow, protSwing?.protHigh ?? null, protSwing?.protLow ?? null]
          const rrUsed = pickNearestRR(selected.dir, bar1m.close, sl, candidates, params.sniperRRLevels)
          const tp = buildSingleTP(selected.dir, bar1m.close, sl, rrUsed)
          const { outcome, resolvedAt, barsToResolve } = walkForOutcome(bars1m, i, selected.dir, sl, tp)
          signals.push({
            time: t, signalType: 'sniper_confirmation', path: 'setup_a', direction: selected.dir,
            execTf: execTfFor(s1, s3, s5, dirNum), htfRung: selected.tag,
            entry: bar1m.close, sl, tp, rrUsed, gradeValue: grade(dirNum, i),
            outcome, resolvedAt, barsToResolve,
          })
        }
      }
    }

    // STAGE SYNC: Setup B's realign stage no longer checks DXY (see
    // updateSetupBTracker above), and its exits now use the SAME
    // unified calcSL as Setup A/Precision, not a separate
    // midpoint-anchored function.
    const setupBFiredThisBar: { tag: string; dir: number; ev: BoxEvent }[] = []
    for (const { ev, tag } of htfTiers) {
      const trk = setupBTrackers[tag]
      const boxRange = ev.refHigh - ev.refLow
      const fired = updateSetupBTracker(
        trk, ev.state, ev.refHigh, ev.refLow, ev.csod, ev.bos, ev.breakoutDist, boxRange,
        bar1m.close, params, anyExecBuyCSOD, anyExecSellCSOD, buyFadeCycleOK, sellFadeCycleOK
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
        const sl = calcSL(dirTxt, bar1m.close, s15.refHigh, s15.refLow, protSwing?.protHigh ?? null, protSwing?.protLow ?? null, params)
        if (Math.abs(bar1m.close - sl) >= minSLDistance) {
          const candidates = [s60.refHigh, s60.refLow, s240.refHigh, s240.refLow, sD.refHigh, sD.refLow, sW.refHigh, sW.refLow, sM.refHigh, sM.refLow, s12M.refHigh, s12M.refLow, protSwing?.protHigh ?? null, protSwing?.protLow ?? null]
          const rrUsed = pickNearestRR(dirTxt, bar1m.close, sl, candidates, params.sniperRRLevels)
          const tp = buildSingleTP(dirTxt, bar1m.close, sl, rrUsed)
          const { outcome, resolvedAt, barsToResolve } = walkForOutcome(bars1m, i, dirTxt, sl, tp)
          signals.push({
            time: t, signalType: 'sniper_confirmation', path: 'setup_b', direction: dirTxt,
            execTf: execTfForSetupB(selectedB.dir, execTrackers), htfRung: selectedB.tag,
            entry: bar1m.close, sl, tp, rrUsed, gradeValue: grade(selectedB.dir, i),
            outcome, resolvedAt, barsToResolve,
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

  const pointsBetween = (a: number, b: number) => Math.round(Math.abs(a - b) / POINT_VALUE)
  const netPoints = resolved.reduce((sum, s) => {
    if (s.outcome === 'tp_hit') return sum + pointsBetween(s.entry, s.tp)
    if (s.outcome === 'stopped_out') return sum - pointsBetween(s.entry, s.sl)
    return sum
  }, 0)
  const avgPointsPerSignal = resolved.length ? Math.round((netPoints / resolved.length) * 10) / 10 : null

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
    netPoints,
    avgPointsPerSignal,
    byType,
    byPath,
  }
}