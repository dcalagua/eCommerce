import { Outlet } from 'react-router-dom'
import { TenantProvider } from '@/features/tenant/TenantProvider'
import { RequireSession } from './RequireSession'

/**
 * Raíz de todo lo que exige identidad: backoffice y alta de espacio.
 *
 * El `TenantProvider` cuelga de aquí y no de la raíz de la app a propósito: el
 * storefront público no debe consultar `tenants` ni `tenant_members` ni cuando
 * el visitante tenga, además, sesión de backoffice abierta.
 */
export function ProtectedArea() {
  return (
    <RequireSession>
      <TenantProvider>
        <Outlet />
      </TenantProvider>
    </RequireSession>
  )
}
