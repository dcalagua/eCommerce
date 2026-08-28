import { useQuery } from '@tanstack/react-query'
import { useCallback, useMemo, useState, type ReactNode } from 'react'
import { emailFromSession, tenantFromSession } from '@/features/auth/session'
import { useSessionContext } from '@/features/auth/session-context'
import { can as roleCan, type Permission } from '@/shared/lib/roles'
import { TenantCtx, type TenantContextValue } from './tenant-context'
import type { Workspace } from './types'
import { fetchWorkspace, resolveTenantSelection, workspaceKey } from './workspace'

/**
 * Contexto de tenant del backoffice.
 *
 * La jerarquía viene del JWT y el resto (tenant, membresías, tiendas) de
 * consultas bajo RLS. El provider no arma ni un solo filtro de tenant: si el
 * token no autoriza, la base devuelve cero filas y el estado cae en
 * `onboarding` o `unauthorized`, nunca en "datos de alguien más".
 */
export function TenantProvider({ children }: { children: ReactNode }) {
  const { session } = useSessionContext()
  const claims = useMemo(() => tenantFromSession(session), [session])
  const email = useMemo(() => emailFromSession(session), [session])
  const userId = session?.user?.id ?? ''

  const [companyOverride, setCompanyOverride] = useState<string | null>(null)
  const [storeOverride, setStoreOverride] = useState<string | null>(null)

  const query = useQuery<Workspace>({
    queryKey: workspaceKey(claims?.organization_id ?? ''),
    queryFn: () => fetchWorkspace(userId),
    enabled: Boolean(claims && userId),
    retry: false,
    staleTime: 60_000,
  })

  const selection = useMemo(
    () =>
      resolveTenantSelection({
        claims,
        workspace: query.data,
        isLoading: query.isPending && Boolean(claims && userId),
        isError: query.isError,
        companyOverride,
        storeOverride,
      }),
    [claims, query.data, query.isPending, query.isError, companyOverride, storeOverride, userId],
  )

  const setActiveCompany = useCallback((companyId: string) => {
    // No se persiste en localStorage a propósito: la sociedad es parte de la
    // jerarquía del token (contrato §3) y un valor guardado en el navegador
    // sobreviviría a un cambio de permisos en el hub.
    setCompanyOverride(companyId)
    setStoreOverride(null)
  }, [])

  const value = useMemo<TenantContextValue>(
    () => ({
      ...selection,
      email,
      error: query.error instanceof Error ? query.error : null,
      setActiveCompany,
      setActiveStore: setStoreOverride,
      can: (permission: Permission) => roleCan(selection.role, permission),
      refetch: () => void query.refetch(),
    }),
    [selection, email, query, setActiveCompany],
  )

  return <TenantCtx.Provider value={value}>{children}</TenantCtx.Provider>
}
