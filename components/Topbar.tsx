'use client'
import { useEffect, useState } from 'react'

function getSession() {
  const hour = new Date().getUTCHours()
  if (hour >= 0 && hour < 7) return 'ASIAN'
  if (hour >= 7 && hour < 12) return 'LONDON'
  if (hour >= 12 && hour < 21) return 'NEW YORK'
  return 'LATE NY'
}

export default function Topbar() {
  const [session, setSession] = useState('—')

  useEffect(() => {
    setSession(getSession())
    const interval = setInterval(() => setSession(getSession()), 60000)
    return () => clearInterval(interval)
  }, [])

  return (
    <div>
      <div className="h-[3px] bg-gradient-to-r from-[#FF2E63] via-[#FF2E63] to-transparent" />
      <div className="flex items-center gap-6 px-6 py-3 bg-[#05070A] border-b border-[#1B232C] overflow-x-auto whitespace-nowrap font-mono text-xs">
        <span className="flex items-center gap-2 text-white font-semibold">
          <span className="w-1.5 h-1.5 rounded-full bg-[#34D399] animate-pulse" /> XAUUSD
        </span>
        <span className="text-white">— live price pending</span>
        <span className="text-[#7C8896]">15m box —</span>
        <span className="text-[#7C8896]">1H bias —</span>
        <span className="ml-auto border border-[#1B232C] rounded px-2.5 py-1 text-[#2DD4BF]">SESSION: {session}</span>
      </div>
    </div>
  )
}