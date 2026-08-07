'use client'
import Link from 'next/link'
import Image from 'next/image'
import { usePathname, useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabaseClient'

const NAV = [
  { href: '/overview', label: 'Overview' },
  { href: '/signals', label: 'Signals' },
  { href: '/performance', label: 'Performance' },
  { href: '/analysis', label: 'Analysis' },
  { href: '/settings', label: 'Settings' },
]

export default function Sidebar() {
  const pathname = usePathname()
  const router = useRouter()

  async function handleLogout() {
    await supabase.auth.signOut()
    router.push('/login')
  }

  return (
    <nav className="bg-[#05070A] border-r border-[#1B232C] p-6 flex flex-row md:flex-col md:h-screen md:sticky md:top-0 md:w-[280px] items-center md:items-stretch overflow-x-auto gap-2 md:gap-0">
      <div className="hidden md:flex items-center gap-3 mb-10 px-1">
        <div className="w-10 h-10 rounded-full overflow-hidden border border-[#14625A] bg-[#0B0F14] flex-shrink-0">
          <Image src="/logo.png" alt="BRUNC" width={40} height={40} className="object-cover" />
        </div>
        <div>
          <div className="text-white font-bold text-base tracking-wide leading-none">BRUNC</div>
          <div className="font-mono text-[9px] text-[#7C8896] tracking-[2px] mt-1">SNIPER SIGNALS</div>
        </div>
      </div>

      <ul className="flex md:flex-col gap-1 flex-1">
        {NAV.map(item => {
          const active = pathname === item.href
          return (
            <li key={item.href}>
              <Link href={item.href}
                className={`flex items-center gap-2.5 px-4 py-2.5 rounded-lg text-sm whitespace-nowrap ${
                  active ? 'bg-[#14625A]/30 text-white' : 'text-[#7C8896] hover:text-white hover:bg-[#0F141A]'
                }`}>
                <span className={`w-1.5 h-1.5 rounded-full ${active ? 'bg-[#2DD4BF]' : 'bg-[#3A434D]'}`} />
                {item.label}
              </Link>
            </li>
          )
        })}
      </ul>

      <div className="hidden md:block mt-10 pt-5 border-t border-[#1B232C] font-mono text-[11px] space-y-2">
        <div className="flex justify-between"><span className="text-[#7C8896]">Signal engine</span><span className="text-[#2DD4BF]">v6 · Stage 3</span></div>
        <div className="flex justify-between"><span className="text-[#7C8896]">Data layer</span><span className="text-[#7C8896]">connected</span></div>
        <div className="flex justify-between"><span className="text-[#7C8896]">Reasoning engine</span><span className="text-[#7C8896]">pending</span></div>
        <button onClick={handleLogout} className="text-[#7C8896] underline pt-2">Sign out</button>
      </div>
    </nav>
  )
}