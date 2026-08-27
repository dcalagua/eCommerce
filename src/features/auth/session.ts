import type { Session } from '@supabase/supabase-js'
import { useEffect, useState } from 'react'
import { isSupabaseConfigured } from '@/shared/lib/env'
import { tryGetSupabaseClient } from '@/shared/lib/supabase'
import { tenantContextSchema, type TenantContext } from '@/features/tenant/types'

export interface SessionState {
  session: Session | null
  loading: boolean
}

/** Suscripción a la sesión de Supabase. Sin backend configurado → no autenticado. */
export function useSession(): SessionState {
  const [state, setState] = useState<SessionState>({
    session: null,
    loading: isSupabaseConfigured,
  })

  useEffect(() => {
    const supabase = tryGetSupabaseClient()
    if (!supabase) {
      setState({ session: null, loading: false })
      return
    }

    let active = true
    void supabase.auth.getSession().then(({ data }) => {
      if (active) setState({ session: data.session, loading: false })
    })

    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      if (active) setState({ session, loading: false })
    })

    return () => {
      active = false
      sub.subscription.unsubscribe()
    }
  }, [])

  return state
}

/**
 * Deriva el tenant EXCLUSIVAMENTE de los claims del JWT (contrato §2.2/§8).
 * Devuelve `null` si el token no trae la jerarquía completa: sin tenant válido
 * no se consulta nada, en vez de asumir un valor por defecto.
 */
export function tenantFromSession(session: Session | null): TenantContext | null {
  if (!session) return null
  const claims = session.user.app_metadata as Record<string, unknown>
  const parsed = tenantContextSchema.safeParse({
    organization_id: claims.org_id,
    active_company: claims.active_company,
    companies: claims.companies,
    apps: claims.apps ?? [],
  })
  return parsed.success ? parsed.data : null
}
