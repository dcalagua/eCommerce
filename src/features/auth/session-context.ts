import type { Session } from '@supabase/supabase-js'
import { createContext, useContext } from 'react'

/**
 * Estados posibles de la sesión. `recovery` es propio: cuando el usuario abre
 * el enlace del correo, Supabase emite una sesión especial de recuperación. Si
 * se tratara como una sesión normal, entraría al backoffice sin haber puesto
 * contraseña nueva; por eso es un estado distinto y no un booleano suelto.
 */
export type SessionStatus = 'loading' | 'authenticated' | 'anonymous' | 'recovery' | 'error'

export interface SessionContextValue {
  session: Session | null
  status: SessionStatus
  error: Error | null
  signOut: () => Promise<void>
  /** Marca la recuperación como terminada tras fijar la contraseña nueva. */
  clearRecovery: () => void
  retry: () => void
}

export const SessionContext = createContext<SessionContextValue | null>(null)

export function useSessionContext(): SessionContextValue {
  const value = useContext(SessionContext)
  if (!value) {
    throw new Error('useSessionContext debe usarse dentro de <SessionProvider>')
  }
  return value
}
