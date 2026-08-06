'use client'
import { useState, FormEvent } from 'react'
import { useRouter } from 'next/navigation'
import Image from 'next/image'
import { supabase } from '@/lib/supabaseClient'

export default function LoginPage() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const router = useRouter()

  async function handleLogin(e: FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError('')
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) {
      setError(error.message)
      setLoading(false)
    } else {
      router.push('/overview')
    }
  }

  return (
    <div className="min-h-screen w-full flex items-center justify-center bg-[#05070A] p-6">
      <div className="w-full max-w-[380px] relative bg-[#0B0F14] border border-[#1B232C] rounded-2xl p-9">
        <span className="absolute -top-px -left-px w-6 h-6 border-t-2 border-l-2 border-[#2DD4BF] rounded-tl-2xl" />
        <span className="absolute -top-px -right-px w-6 h-6 border-t-2 border-r-2 border-[#2DD4BF] rounded-tr-2xl" />

        <div className="flex flex-col items-center text-center mb-7">
          <div className="w-16 h-16 rounded-full overflow-hidden mb-4 border border-[#14625A] bg-[#05070A] flex items-center justify-center">
            <Image src="/logo.png" alt="BRUNC" width={64} height={64} className="object-cover" />
          </div>
          <div className="text-2xl font-bold tracking-[3px] text-white">BRUNC</div>
          <div className="font-mono text-[10px] tracking-[3px] text-[#7C8896] mt-1">AI SOLUTIONS LIMITED</div>
          <div className="mt-4 font-mono text-[11px] tracking-[2px] text-[#2DD4BF]">XAUUSD SNIPER SIGNAL DESK</div>
        </div>

        <form onSubmit={handleLogin} className="space-y-4">
          <div>
            <label className="block font-mono text-[10px] tracking-wide text-[#7C8896] uppercase mb-2">Email or Username</label>
            <input type="email" required value={email} onChange={e => setEmail(e.target.value)}
              placeholder="you@brunc.ai"
              className="w-full bg-[#0F141A] border border-[#1B232C] rounded-lg px-3 py-2.5 font-mono text-sm text-white outline-none focus:border-[#2DD4BF]" />
          </div>
          <div>
            <label className="block font-mono text-[10px] tracking-wide text-[#7C8896] uppercase mb-2">Password</label>
            <input type="password" required value={password} onChange={e => setPassword(e.target.value)}
              placeholder="••••••••"
              className="w-full bg-[#0F141A] border border-[#1B232C] rounded-lg px-3 py-2.5 font-mono text-sm text-white outline-none focus:border-[#2DD4BF]" />
          </div>
          {error && <div className="text-[#F87171] text-xs font-mono">{error}</div>}
          <button type="submit" disabled={loading}
            className="w-full py-3 rounded-lg bg-[#2DD4BF] hover:bg-[#4ee0cc] text-[#05070A] font-semibold text-sm transition">
            {loading ? 'Signing in…' : 'Log In'}
          </button>
        </form>

        <div className="text-center font-mono text-[11px] text-[#7C8896] mt-5">
          Sign in with your BRUNC account
        </div>
      </div>
    </div>
  )
}