'use client'
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabaseClient'

// STAGE: replaced the old getSession() (which always returned SOMETHING,
// defaulting silently to 'ASIAN' for any hour not in London/NY) with
// real, named hours for every session including Asian -- verified with
// an actual hour-by-hour table before shipping this. London/NY hours
// match exactly what's already used in Performance's session breakdown
// and elsewhere, so this doesn't introduce a second, conflicting
// definition -- it only adds the missing Asian session and makes "no
// session active" a real, distinct state instead of a fallback guess.
// This produces a genuine empty gap at 22:00-00:00 UTC.
interface ActiveSession { name: string; hours: string }

function getActiveSession(): ActiveSession | null {
  const h = new Date().getUTCHours()
  const isAsian = h >= 0 && h < 9
  const isLondon = h >= 8 && h < 17
  const isNewYork = h >= 13 && h < 22
  if (isLondon && isNewYork) return { name: 'LONDON/NY OVERLAP', hours: '13:00-17:00 UTC' }
  if (isLondon) return { name: 'LONDON', hours: '08:00-17:00 UTC' }
  if (isNewYork) return { name: 'NEW YORK', hours: '13:00-22:00 UTC' }
  if (isAsian) return { name: 'ASIAN', hours: '00:00-09:00 UTC' }
  return null // genuine gap (22:00-00:00 UTC) -- no session active
}

function getKenyaTime() {
  return new Intl.DateTimeFormat('en-KE', {
    timeZone: 'Africa/Nairobi',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date())
}

function formatAgo(ms: number): string {
  const mins = Math.floor(ms / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}

function stalenessColor(ms: number | null): string {
  if (ms == null) return '#7C8896'
  const hours = ms / 3_600_000
  if (hours < 12) return '#34D399'
  if (hours < 48) return '#F59E0B'
  return '#F87171'
}

export default function Topbar() {
  const [activeSession, setActiveSession] = useState<ActiveSession | null>(null)
  const [eatTime, setEatTime] = useState('—')
  const [lastSignalMs, setLastSignalMs] = useState<number | null>(null)
  const [lastSignalKnown, setLastSignalKnown] = useState(false)
  const [newsWindowActive, setNewsWindowActive] = useState(false)
  const [newsEventLabel, setNewsEventLabel] = useState('')
  const router = useRouter()

  useEffect(() => {
    setActiveSession(getActiveSession())
    setEatTime(getKenyaTime())

    async function checkLastSignal() {
      const { data } = await supabase
        .from('signals')
        .select('created_at')
        .order('created_at', { ascending: false })
        .limit(1)
      const latest = data?.[0]?.created_at
      if (latest) {
        setLastSignalMs(Date.now() - new Date(latest).getTime())
        setLastSignalKnown(true)
      } else {
        setLastSignalKnown(true)
      }
    }
    checkLastSignal()

    // STAGE: real check now, was a stub. Same endpoint Sidebar uses.
    async function checkNewsWindow() {
      try {
        const res = await fetch('/api/news-window-status')
        const data = await res.json()
        setNewsWindowActive(!!data.active)
        setNewsEventLabel(data.event?.label ?? '')
      } catch {
        setNewsWindowActive(false)
        setNewsEventLabel('')
      }
    }
    checkNewsWindow()

    const interval = setInterval(() => {
      setActiveSession(getActiveSession())
      setEatTime(getKenyaTime())
      setLastSignalMs(prev => (prev == null ? null : prev + 30000))
      checkNewsWindow()
    }, 30000)
    return () => clearInterval(interval)
  }, [])

  async function handleLogout() {
    await supabase.auth.signOut()
    router.push('/login')
  }

  const dotColor = stalenessColor(lastSignalMs)

  return (
    <div>
      <div className="h-[3px] bg-gradient-to-r from-[#FF2E63] via-[#FF2E63] to-transparent" />
      <div className="flex items-center gap-3 md:gap-6 px-3 md:px-6 py-2.5 md:py-3 bg-[#05070A] border-b border-[#1B232C] overflow-x-auto whitespace-nowrap font-mono text-[11px] md:text-xs">
        <span className="flex items-center gap-2 text-white font-semibold flex-shrink-0">
          <span className="w-1.5 h-1.5 rounded-full bg-[#34D399] animate-pulse" /> XAUUSD
        </span>
        <span className="text-white flex-shrink-0">— live price pending</span>
        <span className="text-[#7C8896] hidden sm:inline flex-shrink-0">{eatTime} EAT</span>

        {lastSignalKnown && (
          <span className="flex items-center gap-1.5 flex-shrink-0" title="Time since the last signal was received from TradingView">
            <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: dotColor }} />
            <span className="hidden sm:inline text-[#7C8896]">Last signal:</span>
            <span style={{ color: dotColor }}>{lastSignalMs == null ? 'none yet' : formatAgo(lastSignalMs)}</span>
          </span>
        )}

        {newsWindowActive && (
          <span className="flex items-center gap-1.5 flex-shrink-0 px-2 py-1 rounded border border-[#2B8CE0]/40 bg-[#2B8CE0]/10" title={newsEventLabel}>
            <span className="w-1.5 h-1.5 rounded-full bg-[#2B8CE0] animate-pulse" />
            <span className="text-[#2B8CE0]">NEWS TIME</span>
          </span>
        )}

        {/* STAGE: only renders when a real named session is active --
            genuinely empty (nothing shown) during the 22:00-00:00 UTC
            gap, instead of the old silent 'ASIAN' fallback. Shines
            blue with the same pulsing treatment as the news indicator
            whenever any session (Asian/London/NY/Overlap) is active,
            to draw attention exactly as requested. */}
        {activeSession && (
          <span className="ml-auto flex items-center gap-1.5 flex-shrink-0 px-2 md:px-2.5 py-1 rounded border border-[#2B8CE0]/40 bg-[#2B8CE0]/10" title={activeSession.hours}>
            <span className="w-1.5 h-1.5 rounded-full bg-[#2B8CE0] animate-pulse" />
            <span className="hidden md:inline text-[#2B8CE0]">SESSION: </span>
            <span className="text-[#2B8CE0]">{activeSession.name}</span>
          </span>
        )}

        <button onClick={handleLogout} className="md:hidden flex-shrink-0 text-[#7C8896]" aria-label="Sign out">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <path d="M6 2H3.5A1.5 1.5 0 002 3.5v9A1.5 1.5 0 003.5 14H6M10.5 11l3-3-3-3M13.5 8H6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </button>
      </div>
    </div>
  )
}