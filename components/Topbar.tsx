'use client'
import { useEffect, useState, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabaseClient'
import { getActiveSession, type ActiveSession } from '@/lib/sessions'

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

// STAGE ADD: EAT-based Today/Yesterday formatting for notifications,
// per explicit request. Deliberately computes the calendar-day
// boundary IN EAT specifically (via Intl.DateTimeFormat's en-CA
// YYYY-MM-DD trick), not the browser's arbitrary local timezone --
// avoids a notification near EAT midnight being mislabeled if the
// viewer's own browser timezone differs from EAT.
function getEatDateString(date: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Nairobi' }).format(date)
}

function formatNotificationTime(iso: string): string {
  const date = new Date(iso)
  const now = new Date()
  const dateStr = getEatDateString(date)
  const todayStr = getEatDateString(now)
  const yesterdayStr = getEatDateString(new Date(now.getTime() - 86400000))

  const timeStr = new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Nairobi', hour: '2-digit', minute: '2-digit', hour12: false }).format(date)

  if (dateStr === todayStr) return `Today, ${timeStr} EAT`
  if (dateStr === yesterdayStr) return `Yesterday, ${timeStr} EAT`
  const dateFmt = new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Nairobi', day: '2-digit', month: 'short' }).format(date)
  return `${dateFmt}, ${timeStr} EAT`
}

interface Notification {
  id: number
  type: string
  message: string
  created_at: string
}

// STAGE ADD: shared "bright glow" style, used for the news indicator,
// the session indicator, and the last-signal dot -- per explicit
// request to make these genuinely more attention-grabbing, not just
// the existing subtle pulse. Real box-shadow glow, not just opacity.
function glowStyle(color: string) {
  return { boxShadow: `0 0 10px 2px ${color}, 0 0 3px 1px ${color}` }
}

export default function Topbar() {
  const [activeSession, setActiveSession] = useState<ActiveSession | null>(null)
  const [eatTime, setEatTime] = useState('—')
  const [lastSignalMs, setLastSignalMs] = useState<number | null>(null)
  const [lastSignalKnown, setLastSignalKnown] = useState(false)
  const [newsWindowActive, setNewsWindowActive] = useState(false)
  const [newsEventLabel, setNewsEventLabel] = useState('')
  const [notifications, setNotifications] = useState<Notification[]>([])
  const [showNotifications, setShowNotifications] = useState(false)
  const [lastSeenNotifId, setLastSeenNotifId] = useState<number | null>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const router = useRouter()

  const loadNotifications = async () => {
    const { data } = await supabase
      .from('notifications')
      .select('id, type, message, created_at')
      .order('created_at', { ascending: false })
      .limit(20)
    setNotifications(data ?? [])
  }

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
    loadNotifications()

    const interval = setInterval(() => {
      setActiveSession(getActiveSession())
      setEatTime(getKenyaTime())
      setLastSignalMs(prev => (prev == null ? null : prev + 30000))
      checkNewsWindow()
      loadNotifications()
    }, 30000)

    const channel = supabase.channel('notifications-live')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'notifications' }, loadNotifications)
      .subscribe()

    function handleClickOutside(e: MouseEvent) {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        setShowNotifications(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)

    return () => {
      clearInterval(interval)
      supabase.removeChannel(channel)
      document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [])

  async function handleLogout() {
    await supabase.auth.signOut()
    router.push('/login')
  }

  function toggleNotifications() {
    setShowNotifications(prev => {
      const next = !prev
      if (next && notifications.length > 0) setLastSeenNotifId(notifications[0].id)
      return next
    })
  }

  const dotColor = stalenessColor(lastSignalMs)
  const hasUnseenNotification = notifications.length > 0 && (lastSeenNotifId === null || notifications[0].id > lastSeenNotifId)

  return (
    <div>
      <div className="h-[3px] bg-gradient-to-r from-[#FF2E63] via-[#FF2E63] to-transparent" />
      <div className="flex items-center gap-3 md:gap-6 px-3 md:px-6 py-2.5 md:py-3 bg-[#05070A] border-b border-[#1B232C] overflow-x-auto whitespace-nowrap font-mono text-[11px] md:text-xs relative">
        <span className="flex items-center gap-2 text-white font-semibold flex-shrink-0">
          <span className="w-1.5 h-1.5 rounded-full bg-[#34D399] animate-pulse" /> XAUUSD
        </span>
        <span className="text-white flex-shrink-0">— live price pending</span>
        <span className="text-[#7C8896] hidden sm:inline flex-shrink-0">{eatTime} EAT</span>

        {/* STAGE: brighter -- larger dot, real glow, matching the
            explicit request to make this more attention-grabbing */}
        {lastSignalKnown && (
          <span className="flex items-center gap-2 flex-shrink-0" title="Time since the last signal was received from TradingView">
            <span className="w-2.5 h-2.5 rounded-full animate-pulse" style={{ backgroundColor: dotColor, ...glowStyle(dotColor) }} />
            <span className="hidden sm:inline text-[#7C8896]">Last signal:</span>
            <span style={{ color: dotColor }} className="font-bold">{lastSignalMs == null ? 'none yet' : formatAgo(lastSignalMs)}</span>
          </span>
        )}

        {/* STAGE: brighter news indicator -- larger dot, glow, bolder
            background/border, per explicit "shine like an alarm" request */}
        {newsWindowActive && (
          <span className="flex items-center gap-2 flex-shrink-0 px-2.5 py-1.5 rounded border-2 border-[#2B8CE0] bg-[#2B8CE0]/20" title={newsEventLabel}>
            <span className="w-2.5 h-2.5 rounded-full bg-[#2B8CE0] animate-pulse" style={glowStyle('#2B8CE0')} />
            <span className="text-[#2B8CE0] font-bold">NEWS TIME</span>
          </span>
        )}

        {/* STAGE: brighter session indicator, same treatment, plus now
            genuinely DST-aware via the shared lib/sessions module */}
        {activeSession && (
          <span className="ml-auto flex items-center gap-2 flex-shrink-0 px-2.5 md:px-3 py-1.5 rounded border-2 border-[#2DD4BF] bg-[#2DD4BF]/20" title={activeSession.detail}>
            <span className="w-2.5 h-2.5 rounded-full bg-[#2DD4BF] animate-pulse" style={glowStyle('#2DD4BF')} />
            <span className="hidden md:inline text-[#2DD4BF] font-bold">SESSION: </span>
            <span className="text-[#2DD4BF] font-bold">{activeSession.name}</span>
          </span>
        )}

        {/* STAGE ADD: notification bell -- new. Shows a red dot when
            there's a notification newer than the last time the panel
            was opened. Click to open a dropdown of recent
            session-change / news-live events, each with an
            EAT-based Today/Yesterday-aware timestamp. */}
        <div className="relative flex-shrink-0" ref={panelRef}>
          <button onClick={toggleNotifications} className="relative p-1.5 text-[#7C8896] hover:text-white" aria-label="Notifications">
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
              <path d="M9 2.5c-2.2 0-4 1.8-4 4v2.3c0 .5-.2 1-.5 1.4L3 12h12l-1.5-1.8c-.3-.4-.5-.9-.5-1.4V6.5c0-2.2-1.8-4-4-4z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round"/>
              <path d="M7.3 14.5a1.7 1.7 0 003.4 0" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
            </svg>
            {hasUnseenNotification && (
              <span className="absolute top-0.5 right-0.5 w-2 h-2 rounded-full bg-[#F87171] animate-pulse" style={glowStyle('#F87171')} />
            )}
          </button>

          {showNotifications && (
            <div className="absolute right-0 top-full mt-2 w-80 max-h-96 overflow-y-auto bg-[#0B0F14] border border-[#1B232C] rounded-xl shadow-2xl z-50">
              <div className="px-4 py-3 border-b border-[#1B232C] font-mono text-[10px] tracking-widest text-[#7C8896] uppercase">
                Notifications
              </div>
              {notifications.length === 0 ? (
                <div className="px-4 py-6 text-center font-mono text-[11px] text-[#7C8896]">Nothing yet.</div>
              ) : (
                <div className="divide-y divide-[#1B232C]">
                  {notifications.map(n => (
                    <div key={n.id} className="px-4 py-3">
                      <div className="flex items-start gap-2">
                        <span className={`w-1.5 h-1.5 rounded-full mt-1.5 flex-shrink-0 ${n.type === 'news_live' ? 'bg-[#2B8CE0]' : 'bg-[#2DD4BF]'}`} />
                        <div className="min-w-0">
                          <div className="text-white text-xs leading-snug">{n.message}</div>
                          <div className="text-[#7C8896] font-mono text-[10px] mt-1">{formatNotificationTime(n.created_at)}</div>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        <button onClick={handleLogout} className="md:hidden flex-shrink-0 text-[#7C8896]" aria-label="Sign out">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <path d="M6 2H3.5A1.5 1.5 0 002 3.5v9A1.5 1.5 0 003.5 14H6M10.5 11l3-3-3-3M13.5 8H6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </button>
      </div>
    </div>
  )
}