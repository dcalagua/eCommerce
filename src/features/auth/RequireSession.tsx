import type { ReactNode } from 'react'
import { Navigate, useLocation } from 'react-router-dom'
import { LoadingState } from '@/shared/ui/states'
import { useSession } from './session'

/**
 * Guard del backoffice: exige sesión. La verificación real de membership y
 * `active_company` vive en el servidor (RLS + Edge Functions); esto es solo la
 * puerta de la UI, nunca la frontera de seguridad.
 */
export function RequireSession({ children }: { children: ReactNode }) {
  const { session, loading } = useSession()
  const location = useLocation()

  if (loading) return <LoadingState />
  if (!session) return <Navigate to="/login" replace state={{ from: location.pathname }} />
  return <>{children}</>
}
