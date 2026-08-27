import { Button } from '@mui/material'
import type { ReactNode } from 'react'
import { Navigate } from 'react-router-dom'
import { useSessionContext } from '@/features/auth/session-context'
import { useI18n } from '@/shared/i18n/i18n-context'
import { ErrorState, LoadingState, UnauthorizedState } from '@/shared/ui/states'
import { useTenant } from './tenant-context'

/**
 * Guard de tenant. Cada estado tiene su salida y ninguno cae en pantalla
 * blanca ni en un listado vacío que parezca un error del usuario:
 *
 *  · `unauthorized` — hay sesión pero el token no trae la jerarquía del hub, o
 *    no la trae para esta app. No se arregla dando de alta nada: se arregla en
 *    el hub, así que la salida es cerrar sesión, no seguir.
 *  · `onboarding` — token correcto y todavía sin espacio: se crea uno.
 */
export function RequireTenant({ children }: { children: ReactNode }) {
  const { status, error, refetch } = useTenant()
  const { signOut } = useSessionContext()
  const { t } = useI18n()

  if (status === 'loading') return <LoadingState />
  if (status === 'error') return <ErrorState error={error} onRetry={refetch} />
  if (status === 'onboarding') return <Navigate to="/onboarding" replace />

  if (status === 'unauthorized') {
    return (
      <UnauthorizedState
        title={t('tenant.unauthorized.title')}
        description={t('tenant.unauthorized.body')}
        action={
          <Button variant="contained" onClick={() => void signOut()}>
            {t('nav.signOut')}
          </Button>
        }
      />
    )
  }

  return <>{children}</>
}
