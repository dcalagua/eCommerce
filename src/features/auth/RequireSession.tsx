import type { ReactNode } from 'react'
import { Navigate, useLocation } from 'react-router-dom'
import { ErrorState, LoadingState } from '@/shared/ui/states'
import { useSessionContext } from './session-context'

/**
 * Guard del backoffice: exige sesión. La verificación real de membresía y de
 * sociedad activa vive en el servidor (RLS + Edge Functions); esto es la puerta
 * de la UI, nunca la frontera de seguridad.
 *
 * `loading` no redirige: mientras se recupera la sesión persistida no se sabe
 * todavía si hay usuario, y expulsar al login ahí rompería cada refresco.
 */
export function RequireSession({ children }: { children: ReactNode }) {
  const { status, error, retry } = useSessionContext()
  const location = useLocation()

  if (status === 'loading') return <LoadingState />
  if (status === 'error') return <ErrorState error={error} onRetry={retry} />

  // Sesión de recuperación de contraseña: sirve para poner la clave nueva y
  // para nada más. Entrar al backoffice con ella sería saltarse el paso.
  if (status === 'recovery') return <Navigate to="/nueva-clave" replace />

  if (status === 'anonymous') {
    const from = `${location.pathname}${location.search}`
    return <Navigate to="/login" replace state={{ from }} />
  }

  return <>{children}</>
}
