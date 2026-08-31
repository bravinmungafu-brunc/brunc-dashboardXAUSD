'use client'
import Link from 'next/link'
import Image from 'next/image'
import { usePathname, useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabaseClient'

const NAV = [
  { href: '/overview', label: 'Overview', icon: 'grid' },
  { href: '/signals', label: 'Signals', icon: 'target' },
  { href: '/analysed-signals', label: 'Analysed Signals', icon: 'check' },
  { href: '/news-signals', label: 'News Signals', icon: 'news' },
  { href: '/performance', label: 'Performance', icon: 'chart' },
  { href: '/backtest', label: 'Backtest', icon: 'clock' },
  { href: '/analysis', label: 'Analysis', icon: 'spark' },
  { href: '/settings', label: 'Settings', icon: 'gear' },
]

const STALE_OPEN_HOURS = 48
const NEWS_CHECK_INTERVAL_MS = 60000 // matches Topbar's polling cadence

function NavIcon({ type, active }: { type: string; active: boolean }) {
  const color = active ? '#2DD4BF' : '#7C8896'
  const common = { width: 20, height: 20, viewBox: '0 0 20 20', fill: 'none' }
  switch (type) {
    case 'grid':
      return <svg {...common}><rect x="2" y="2" width="7" height="7" rx="1.5" stroke={color} strokeWidth="1.5"/><rect x="11" y="2" width="7" height="7" rx="1.5" stroke={color} strokeWidth="1.5"/><rect x="2" y="11" width="7" height="7" rx="1.5" stroke={color} strokeWidth="1.5"/><rect x="11" y="11" width="7" height="7" rx="1.5" stroke={color} strokeWidth="1.5"/></svg>
    case 'target':
      return <svg {...common}><circle cx="10" cy="10" r="7" stroke={color} strokeWidth="1.5"/><circle cx="10" cy="10" r="3.5" stroke={color} strokeWidth="1.5"/><circle cx="10" cy="10" r="0.75" fill={color}/></svg>
    case 'check':
      return <svg {...common}><circle cx="10" cy="10" r="7.5" stroke={color} strokeWidth="1.5"/><path d="M6.5 10l2.2 2.2 4.8-4.8" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
    case 'news':
      return <svg {...common}><rect x="2.5" y="4" width="12" height="12" rx="1.5" stroke={color} strokeWidth="1.5"/><path d="M15.5 7v7a1.5 1.5 0 01-1.5 1.5H5" stroke={color} strokeWidth="1.5" strokeLinecap="round"/><path d="M5.5 7.5h6M5.5 10h6M5.5 12.5h3.5" stroke={color} strokeWidth="1.3" strokeLinecap="round"/></svg>
    case 'chart':
      return <svg {...common}><path d="M3 16V9M9 16V4M15 16v-6M3 16h14" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
    case 'clock':
      return <svg {...common}><circle cx="10" cy="10" r="7.5" stroke={color} strokeWidth="1.5"/><path d="M10 6v4l3 2" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
    case 'spark':
      return <svg {...common}><path d="M10 2l1.8 5.2L17 9l-5.2 1.8L10 16l-1.8-5.2L3 9l5.2-1.8L10 2z" stroke={color} strokeWidth="1.5" strokeLinejoin="round"/></svg>
    case 'gear':
      return <svg {...common}><circle cx="10" cy="10" r="2.5" stroke={color} strokeWidth="1.5"/><path d="M10 2v2M10 16v2M18 10h-2M4 10H2M15.5 4.5l-1.4 1.4M5.9 14.1l-1.4 1.4M15.5 15.5l-1.4-1.4M5.9 5.9L4.5 4.5" stroke={color} strokeWidth="1.5" strokeLinecap="round"/></svg>
    default:
      return null
  }
}

export default function Sidebar() {
  const pathname = usePathname()
  const router = useRouter()
  const [hasNewSignal, setHasNewSignal] = useState(false)
  const [hasStaleOpen, setHasStaleOpen] = useState(false)
  const [newsWindowActive, setNewsWindowActive] = useState(false)

  async function handleLogout() {
    await supabase.auth.signOut()
    router.push('/login')
  }

  useEffect(() => {
    async function checkForNew() {
      const { data } = await supabase
        .from('signals')
        .select('created_at')
        .order('created_at', { ascending: false })
        .limit(1)
      const latest = data?.[0]?.created_at
      const lastSeen = localStorage.getItem('brunc_signals_last_seen')
      if (latest && (!lastSeen || new Date(latest) > new Date(lastSeen))) {
        setHasNewSignal(true)
      }
    }
    checkForNew()

    async function checkStaleOpen() {
      const cutoff = new Date(Date.now() - STALE_OPEN_HOURS * 3_600_000).toISOString()
      const { data } = await supabase
        .from('signals')
        .select('id')
        .eq('status', 'open')
        .lt('created_at', cutoff)
        .limit(1)
      setHasStaleOpen(!!data && data.length > 0)
    }
    checkStaleOpen()

    // STAGE: real check now, was a stub always returning false. Reads
    // the same news-window-status endpoint the Topbar and News Signals
    // page use -- pure Supabase read on the backend, cheap to poll.
    async function checkNewsWindow() {
      try {
        const res = await fetch('/api/news-window-status')
        const data = await res.json()
        setNewsWindowActive(!!data.active)
      } catch {
        setNewsWindowActive(false)
      }
    }
    checkNewsWindow()
    const newsInterval = setInterval(checkNewsWindow, NEWS_CHECK_INTERVAL_MS)

    const channel = supabase.channel('sidebar-signal-watch')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'signals' }, () => {
        setHasNewSignal(true)
      })
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'signals' }, () => {
        checkStaleOpen()
      })
      .subscribe()
    return () => { supabase.removeChannel(channel); clearInterval(newsInterval) }
  }, [])

  useEffect(() => {
    if (pathname === '/signals') {
      localStorage.setItem('brunc_signals_last_seen', new Date().toISOString())
      setHasNewSignal(false)
    }
  }, [pathname])

  function renderDot(item: typeof NAV[number], mobile: boolean) {
    if (item.href === '/news-signals' && newsWindowActive) {
      const pos = mobile ? 'top-1 right-1/2 translate-x-3' : 'top-1 left-6'
      return <span className={`absolute ${pos} w-2 h-2 rounded-full bg-[#2B8CE0] animate-pulse z-10`} title="News window is active" />
    }
    const showRedDot = (item.href === '/signals' && hasNewSignal) || (item.href === '/analysis' && hasStaleOpen)
    if (!showRedDot) return null
    const pos = mobile ? 'top-1 right-1/2 translate-x-3' : 'top-1 left-6'
    return <span className={`absolute ${pos} w-2 h-2 rounded-full bg-[#F87171] z-10`} title={item.href === '/analysis' ? `Open signals older than ${STALE_OPEN_HOURS}h haven't been checked yet` : undefined} />
  }

  return (
    <>
      <nav className="hidden md:flex bg-[#05070A] border-r border-[#1B232C] p-6 flex-col md:h-screen md:sticky md:top-0 md:w-[280px]">
        <div className="flex items-center gap-3 mb-10 px-1">
          <div className="w-10 h-10 rounded-full overflow-hidden border border-[#14625A] bg-[#0B0F14] flex-shrink-0">
            <Image src="/logo.png" alt="BRUNC" width={40} height={40} className="object-cover" />
          </div>
          <div>
            <div className="text-white font-bold text-base tracking-wide leading-none">BRUNC</div>
            <div className="font-mono text-[9px] text-[#7C8896] tracking-[2px] mt-1">SNIPER SIGNALS</div>
          </div>
        </div>

        <ul className="flex flex-col gap-1 flex-1 overflow-y-auto">
          {NAV.map(item => {
            const active = pathname === item.href
            return (
              <li key={item.href} className="relative">
                {renderDot(item, false)}
                <Link href={item.href}
                  className={`flex items-center gap-2.5 px-4 py-2.5 rounded-lg text-sm whitespace-nowrap ${
                    active ? 'bg-[#14625A]/30 text-white' : 'text-[#7C8896] hover:text-white hover:bg-[#0F141A]'
                  }`}>
                  <NavIcon type={item.icon} active={active} />
                  {item.label}
                </Link>
              </li>
            )
          })}
        </ul>

        <div className="mt-10 pt-5 border-t border-[#1B232C] font-mono text-[11px] space-y-2">
          <div className="flex justify-between"><span className="text-[#7C8896]">Signal engine</span><span className="text-[#2DD4BF]">v6 · Stage 3</span></div>
          <div className="flex justify-between"><span className="text-[#7C8896]">Data layer</span><span className="text-[#7C8896]">connected</span></div>
          <div className="flex justify-between"><span className="text-[#7C8896]">Reasoning engine</span><span className="text-[#7C8896]">pending</span></div>
          <button onClick={handleLogout} className="text-[#7C8896] underline pt-2">Sign out</button>
        </div>
      </nav>

      <nav className="md:hidden fixed bottom-0 left-0 right-0 z-50 bg-[#05070A] border-t border-[#1B232C]" style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}>
        <ul className="flex items-stretch justify-between px-1 overflow-x-auto">
          {NAV.map(item => {
            const active = pathname === item.href
            return (
              <li key={item.href} className="flex-1 relative min-w-[64px]">
                {renderDot(item, true)}
                <Link href={item.href}
                  className={`flex flex-col items-center justify-center gap-1 py-2.5 text-[9px] font-mono ${
                    active ? 'text-[#2DD4BF]' : 'text-[#7C8896]'
                  }`}>
                  <NavIcon type={item.icon} active={active} />
                  {item.label}
                </Link>
              </li>
            )
          })}
        </ul>
      </nav>
    </>
  )
}