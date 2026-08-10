'use client'
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabaseClient'

function getSession() {
  const h = new Date().getUTCHours()
  const isAsian = h >= 22 || h < 8
  const isLondon = h >= 8 && h < 17
  const isNewYork = h >= 13 && h < 22
  if (isLondon && isNewYork) return 'LONDON/NY OVERLAP'
  if (isLondon) return 'LONDON'
  if (isNewYork) return 'NEW YORK'
  return 'ASIAN'
}

function getKenyaTime() {
  return new Intl.DateTimeFormat('en-KE', {
    timeZone: 'Africa/Nairobi',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date())
}

export default function Topbar() {
  const [session, setSession] = useState('—')
  const [eatTime, setEatTime] = useState('—')
  const router = useRouter()

  useEffect(() => {
    setSession(getSession())
    setEatTime(getKenyaTime())
    const interval = setInterval(() => {
      setSession(getSession())
      setEatTime(getKenyaTime())
    }, 30000)
    return () => clearInterval(interval)
  }, [])

  async function handleLogout() {
    await supabase.auth.signOut()
    router.push('/login')
  }

  return (
    <div>
      <div className="h-[3px] bg-gradient-to-r from-[#FF2E63] via-[#FF2E63] to-transparent" />
      <div className="flex items-center gap-3 md:gap-6 px-3 md:px-6 py-2.5 md:py-3 bg-[#05070A] border-b border-[#1B232C] overflow-x-auto whitespace-nowrap font-mono text-[11px] md:text-xs">
        <span className="flex items-center gap-2 text-white font-semibold flex-shrink-0">
          <span className="w-1.5 h-1.5 rounded-full bg-[#34D399] animate-pulse" /> XAUUSD
        </span>
        <span className="text-white flex-shrink-0">— live price pending</span>
        <span className="text-[#7C8896] hidden sm:inline flex-shrink-0">{eatTime} EAT</span>
        <span className="ml-auto border border-[#1B232C] rounded px-2 md:px-2.5 py-1 text-[#2DD4BF] flex-shrink-0">
          <span className="hidden md:inline">SESSION: </span>{session}
        </span>
        <button onClick={handleLogout} className="md:hidden flex-shrink-0 text-[#7C8896]" aria-label="Sign out">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <path d="M6 2H3.5A1.5 1.5 0 002 3.5v9A1.5 1.5 0 003.5 14H6M10.5 11l3-3-3-3M13.5 8H6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </button>
      </div>
    </div>
  )
}