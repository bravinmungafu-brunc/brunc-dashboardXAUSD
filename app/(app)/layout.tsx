'use client'
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import Sidebar from '@/components/Sidebar'
import Topbar from '@/components/Topbar'

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false)
  const router = useRouter()

  useEffect(() => {
    if (!localStorage.getItem('brunc_auth')) {
      router.replace('/login')
    } else {
      setReady(true)
    }
  }, [router])

  if (!ready) {
    return (
      <div className="min-h-screen bg-[#05070A] flex items-center justify-center">
        <div className="mono text-[#7C8896] text-xs flex items-center gap-2">
          <span className="w-3 h-3 border-2 border-[#2B8CE0]/30 border-t-[#2B8CE0] rounded-full inline-block" style={{ animation: 'spin 0.6s linear infinite' }} />
          Loading…
        </div>
        <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
      </div>
    )
  }

  return (
    <div className="flex min-h-screen bg-[#05070A]">
      <Sidebar />
      <div className="flex-1 flex flex-col min-w-0">
        <Topbar />
        <main className="flex-1 overflow-auto">
          {children}
        </main>
      </div>
    </div>
  )
}