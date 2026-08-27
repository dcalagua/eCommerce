import type { Session } from '@supabase/supabase-js'
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { tryGetSupabaseClient } from '@/shared/lib/supabase'
import { SessionContext, type SessionContextValue, type SessionStatus } from './session-context'

interface Props {
  children: ReactNode
  /** Solo para tests: arranca con una sesión ya resuelta. */
  initialSession?: Session | null
}

/**
 * Única suscripción a la sesión de Supabase de toda la app.
 *
 * Recuperación de sesión: `getSession()` lee la sesión persistida (el cliente
 * se crea con `persistSession` + `autoRefreshToken`), así que un refresco de
 * página o volver al día siguiente no obliga a entrar de nuevo. Mientras esa
 * lectura está en curso el estado es `loading`, no `anonymous`: dar por
 * anónimo a alguien que sí tiene sesión lo expulsaría al login en cada F5.
 */
export function SessionProvider({ children, initialSession }: Props) {
  const [session, setSession] = useState<Session | null>(initialSession ?? null)
  const [status, setStatus] = useState<SessionStatus>(
    initialSession === undefined ? 'loading' : initialSession ? 'authenticated' : 'anonymous',
  )
  const [error, setError] = useState<Error | null>(null)
  const [recovering, setRecovering] = useState(false)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    if (initialSession !== undefined) return

    const supabase = tryGetSupabaseClient()
    if (!supabase) {
      // Sin backend configurado no hay sesión posible. No es un error de la
      // app: es un despliegue sin conectar, y el login lo dice con claridad.
      setSession(null)
      setStatus('anonymous')
      return
    }

    let active = true
    setStatus('loading')

    void supabase.auth
      .getSession()
      .then(({ data, error: sessionError }) => {
        if (!active) return
        if (sessionError) {
          setError(sessionError)
          setStatus('error')
          return
        }
        setSession(data.session)
        setStatus(data.session ? 'authenticated' : 'anonymous')
      })
      .catch((cause: unknown) => {
        if (!active) return
        setError(cause instanceof Error ? cause : new Error(String(cause)))
        setStatus('error')
      })

    const { data: sub } = supabase.auth.onAuthStateChange((event, next) => {
      if (!active) return
      setError(null)
      if (event === 'PASSWORD_RECOVERY') setRecovering(true)
      if (event === 'SIGNED_OUT') setRecovering(false)
      setSession(next)
      setStatus(next ? 'authenticated' : 'anonymous')
    })

    return () => {
      active = false
      sub.subscription.unsubscribe()
    }
  }, [initialSession, attempt])

  const signOut = useCallback(async () => {
    setRecovering(false)
    const supabase = tryGetSupabaseClient()
    if (!supabase) {
      setSession(null)
      setStatus('anonymous')
      return
    }
    const { error: signOutError } = await supabase.auth.signOut()
    // `signOut` local siempre limpia el almacenamiento: aunque el servidor
    // responda mal, la sesión de este navegador ya no vale.
    setSession(null)
    setStatus('anonymous')
    if (signOutError) setError(signOutError)
  }, [])

  const value = useMemo<SessionContextValue>(
    () => ({
      session,
      status: recovering && status === 'authenticated' ? 'recovery' : status,
      error,
      signOut,
      clearRecovery: () => setRecovering(false),
      retry: () => setAttempt((n) => n + 1),
    }),
    [session, status, error, recovering, signOut],
  )

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
}
