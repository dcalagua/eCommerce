import { Outlet } from 'react-router-dom'
import { CapabilitiesProvider } from '@/features/capabilities/CapabilitiesProvider'
import { TenantProvider } from '@/features/tenant/TenantProvider'
import { RequireSession } from './RequireSession'

/**
 * Raíz de todo lo que exige identidad: backoffice y alta de espacio.
 *
 * El `TenantProvider` cuelga de aquí y no de la raíz de la app a propósito: el
 * storefront público no debe consultar `tenants` ni `tenant_members` ni cuando
 * el visitante tenga, además, sesión de backoffice abierta. El
 * `CapabilitiesProvider` va dentro por lo mismo y porque NECESITA la sociedad
 * activa: los addons se activan por sociedad (contrato §6), no por cuenta.
 */
export function ProtectedArea() {
  return (
    <RequireSession>
      <TenantProvider>
        <CapabilitiesProvider>
          <Outlet />
        </CapabilitiesProvider>
      </TenantProvider>
    </RequireSession>
  )
}
