import { useQuery } from '@tanstack/react-query'
import { useMemo, type ReactNode } from 'react'
import { hasCapability, type CapabilityId } from '@/domain'
import { useTenant } from '@/features/tenant/tenant-context'
import { capabilitiesKey, fetchEffectiveCapabilities } from './api'
import { CapabilitiesCtx, type CapabilitiesContextValue } from './capabilities-context'
import type { PlatformContext } from './types'

/**
 * Capacidades efectivas de la sociedad activa.
 *
 * Cuelga del `TenantProvider` y no de la raíz: la vitrina pública no gatea por
 * capacidad —gatea por lo que la vista pública expone— y hacerla consultar
 * entitlements sería darle al comprador anónimo una consulta que no necesita.
 *
 * Se reconsulta al cambiar de sociedad porque los addons se activan POR
 * SOCIEDAD (contrato §6): el mismo usuario puede tener multi-almacén en la
 * filial de un país y no en la de otro, y cachear una sola respuesta por
 * organización enseñaría módulos que esa sociedad no tiene.
 */
export function CapabilitiesProvider({ children }: { children: ReactNode }) {
  const { tenant, activeCompanyId, status: tenantStatus } = useTenant()
  const organizationId = tenant?.organization_id ?? ''
  const companyId = activeCompanyId ?? ''
  const enabled = tenantStatus === 'ready' && Boolean(organizationId && companyId)

  const query = useQuery<PlatformContext>({
    queryKey: capabilitiesKey(organizationId, companyId),
    queryFn: () => fetchEffectiveCapabilities(companyId),
    enabled,
    retry: false,
    // Un addon que el operador activa en el hub no puede tardar una sesión
    // entera en verse, pero tampoco hace falta preguntarlo en cada pantalla.
    staleTime: 5 * 60 * 1000,
  })

  const value = useMemo<CapabilitiesContextValue>(() => {
    const context = query.data ?? null
    const status = !enabled || query.isPending ? 'loading' : query.isError ? 'error' : 'ready'

    return {
      status,
      context,
      has: (capability: CapabilityId) => hasCapability(context, capability),
      error: query.error instanceof Error ? query.error : null,
      refetch: () => void query.refetch(),
    }
  }, [enabled, query])

  return <CapabilitiesCtx.Provider value={value}>{children}</CapabilitiesCtx.Provider>
}
