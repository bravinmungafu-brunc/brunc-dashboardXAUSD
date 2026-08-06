const POINT_SIZE = 0.01

export function calcPoints(priceA: number | null | undefined, priceB: number | null | undefined) {
  if (priceA == null || priceB == null) return null
  return Math.round(Math.abs(priceA - priceB) / POINT_SIZE)
}

export function signalPointsSummary(signal: any) {
  const riskPoints = calcPoints(signal.entry, signal.stop_loss)
  const ladder = Array.isArray(signal.tp_ladder) ? signal.tp_ladder : []
  const rewardPoints = ladder.map((tp: any) => ({
    ...tp,
    points: calcPoints(signal.entry, tp.price)
  }))
  const nearestReward = rewardPoints[0]?.points ?? null
  const rr = riskPoints && nearestReward ? +(nearestReward / riskPoints).toFixed(2) : null
  return { riskPoints, rewardPoints, rr }
}