import { isRouteErrorResponse, useRouteError } from 'react-router-dom'
import { NotFoundPage } from './NotFoundPage'
import { ErrorState } from '@/shared/ui/states'

/** Error boundary del router: distingue 404 de una falla real de la app. */
export function RootErrorRoute() {
  const error = useRouteError()

  if (isRouteErrorResponse(error) && error.status === 404) return <NotFoundPage />

  return <ErrorState error={error} onRetry={() => window.location.reload()} />
}
