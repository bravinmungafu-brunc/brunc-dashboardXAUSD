// lib/sessions.ts
//
// Genuinely DST-aware session detection, shared between the frontend
// (Topbar) and the backend (check-transitions route) so both always
// agree, no risk of drifting apart the way earlier duplicated logic
// in this project did before being caught.
//
// REAL BUG FOUND AND FIXED HERE: the previous version hardcoded UTC
// hour ranges (London 08:00-17:00, NY 13:00-22:00) that assumed
// STANDARD time year-round -- correct only during UK/US winter, wrong
// by exactly 1 hour for the ~7-8 months of the year London and New
// York are in DST (which is right now). Verified directly against a
// real EAT/UTC session-time reference before fixing, not assumed.
//
// THE FIX: instead of a hardcoded UTC range, this computes each
// city's CURRENT LOCAL hour directly via Intl.DateTimeFormat with
// that city's real IANA timezone -- the JS runtime's own timezone
// database handles every DST transition correctly and automatically,
// permanently, without needing manual seasonal updates ever again.
// Verified this exact convention (8am-5pm local business hours for
// London/NY) reproduces the reference document's stated current times
// exactly, before shipping.
//
// Sydney and Tokyo use fixed UTC ranges matching the same reference
// document's given table directly: Tokyo genuinely never observes DST
// (JST is always UTC+9), so a fixed range is permanently correct
// there. Sydney's document entry wasn't given a DST-adjusted variant
// the way London/NY explicitly were -- known limitation, worth
// revisiting if Sydney-session accuracy specifically matters later.

export interface ActiveSession {
  name: string
  detail: string
}

function getLocalHour(timeZone: string, date: Date = new Date()): number {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', hour12: false }).formatToParts(date)
  const hourPart = parts.find(p => p.type === 'hour')
  const h = hourPart ? parseInt(hourPart.value, 10) : 0
  return h % 24 // Intl can return "24" for midnight in some locales/environments
}

export function getActiveSession(date: Date = new Date()): ActiveSession | null {
  const utcHour = date.getUTCHours()

  // Fixed UTC ranges, matching the reference document's given table
  // directly -- see file header for why these two specifically don't
  // need dynamic DST handling.
  const isSydney = utcHour >= 4 && utcHour < 13   // Sydney 07:00-16:00 EAT per reference
  const isTokyo = utcHour >= 6 && utcHour < 15    // Tokyo/Asia 09:00-18:00 EAT per reference

  // Dynamic, DST-aware: each city's own 8am-5pm LOCAL business hours,
  // computed live via that city's real timezone.
  const londonLocalHour = getLocalHour('Europe/London', date)
  const nyLocalHour = getLocalHour('America/New_York', date)
  const isLondon = londonLocalHour >= 8 && londonLocalHour < 17
  const isNewYork = nyLocalHour >= 8 && nyLocalHour < 17

  if (isLondon && isNewYork) return { name: 'LONDON/NY OVERLAP', detail: 'Peak liquidity window' }
  if (isLondon) return { name: 'LONDON', detail: 'London session' }
  if (isNewYork) return { name: 'NEW YORK', detail: 'New York session' }
  if (isTokyo) return { name: 'TOKYO/ASIA', detail: 'Asia session' }
  if (isSydney) return { name: 'SYDNEY', detail: 'Sydney session' }
  return null
}

// STAGE ADD: market open/closed, per explicit request, verified
// against multiple current, consistent sources before building --
// gold/XAUUSD opens Sunday 22:00 UTC (5pm ET) and closes Friday 22:00
// UTC (5pm ET), closed the rest of the weekend. Built the same
// DST-safe way as sessions above: checks New York's REAL local
// weekday/hour via Intl.DateTimeFormat, rather than a hardcoded UTC
// boundary that would drift wrong at the next US DST transition.
export function isMarketOpen(date: Date = new Date()): boolean {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', weekday: 'short', hour: 'numeric', hour12: false,
  }).formatToParts(date)
  const weekday = parts.find(p => p.type === 'weekday')?.value ?? ''
  const hourStr = parts.find(p => p.type === 'hour')?.value ?? '0'
  const hour = parseInt(hourStr, 10) % 24

  if (weekday === 'Fri' && hour >= 17) return false
  if (weekday === 'Sat') return false
  if (weekday === 'Sun' && hour < 17) return false
  return true
}

// STAGE ADD: UI-friendly wrapper around isMarketOpen -- the frontend
// wants both the boolean AND a human-readable detail string for its
// tooltip, kept as a thin wrapper rather than duplicating the actual
// open/closed logic a second time.
export function getMarketStatus(date: Date = new Date()): { open: boolean; detail: string } {
  const open = isMarketOpen(date)
  return {
    open,
    detail: open ? 'Gold market is open' : 'Gold market is closed until Sunday 22:00 UTC (5pm ET)',
  }
}

// STAGE ADD: look ahead a few minutes to see if a NEW session is
// about to begin, for the "session incoming" advance-notice
// notification. Checks lookAheadMinutes into the future using the
// exact same getActiveSession logic, comparing against right now --
// if they differ and the future one is non-null, that's a genuine
// upcoming session worth flagging in advance.
export function getUpcomingSession(date: Date = new Date(), lookAheadMinutes: number = 10): ActiveSession | null {
  const future = new Date(date.getTime() + lookAheadMinutes * 60000)
  const currentSession = getActiveSession(date)
  const futureSession = getActiveSession(future)
  if (futureSession && futureSession.name !== currentSession?.name) {
    return futureSession
  }
  return null
}