// app/api/settings/toggle-analysed-signals/route.ts
//
// Real server-side toggle, replacing the old localStorage-only switch.
// The frontend's toggle button should POST here instead of just writing
// to localStorage -- this is what actually lets the analyse-signals
// route know whether to run at all.

import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL as string,
  process.env.SUPABASE_SERVICE_KEY as string
)

export async function GET() {
  const { data } = await supabase
    .from('app_settings')
    .select('value')
    .eq('key', 'analysed_signals_enabled')
    .maybeSingle()
  const enabled = data ? data.value === true || data.value === 'true' : true
  return Response.json({ enabled })
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}))
  if (typeof body.enabled !== 'boolean') {
    return Response.json({ error: 'Request body must include a boolean "enabled" field.' }, { status: 400 })
  }

  const { error } = await supabase
    .from('app_settings')
    .upsert({ key: 'analysed_signals_enabled', value: body.enabled, updated_at: new Date().toISOString() })

  if (error) return Response.json({ error: error.message }, { status: 500 })
  return Response.json({ enabled: body.enabled })
}