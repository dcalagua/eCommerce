import { useQuery } from '@tanstack/react-query'
import { useCallback, useMemo, useState, type ReactNode } from 'react'
import { emailFromSession, tenantFromSession } from '@/features/auth/session'
import { useSessionContext } from '@/features/auth/session-context'
import { can as roleCan, type Permission } from '@/shared/lib/roles'
import { readStorePreferences, writeStorePreference } from './store-preference'
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

  /**
   * La tienda que este navegador recuerda, por sociedad.
   *
   * Se lee UNA vez: `localStorage` no cambia solo, y releerlo en cada render
   * haría que el estado del backoffice dependiera de un efecto secundario. No
   * autoriza nada — `resolveTenantSelection` la busca en las tiendas que
   * devolvió la RLS y la descarta si no está.
   */
  const [storePreferences] = useState(readStorePreferences)

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
        storePreferences,
      }),
    [
      claims,
      query.data,
      query.isPending,
      query.isError,
      companyOverride,
      storeOverride,
      storePreferences,
      userId,
    ],
  )

  const setActiveCompany = useCallback((companyId: string) => {
    // No se persiste en localStorage a propósito: la sociedad es parte de la
    // jerarquía del token (contrato §3) y un valor guardado en el navegador
    // sobreviviría a un cambio de permisos en el hub.
    setCompanyOverride(companyId)
    setStoreOverride(null)
  }, [])

  /**
   * Cambiar de tienda se recuerda; cambiar de sociedad, no.
   *
   * Es la diferencia entre una preferencia de pantalla y la jerarquía del
   * token: quien trabaja siempre en la misma tienda no puede tener que
   * elegirla otra vez en cada recarga, y quien cambia de sociedad tiene que
   * volver a pasar por lo que diga el hub.
   */
  const selectStore = useCallback(
    (storeId: string) => {
      setStoreOverride(storeId)
      writeStorePreference(selection.activeCompanyId, storeId)
    },
    [selection.activeCompanyId],
  )

  const value = useMemo<TenantContextValue>(
    () => ({
      ...selection,
      email,
      error: query.error instanceof Error ? query.error : null,
      setActiveCompany,
      setActiveStore: selectStore,
      can: (permission: Permission) => roleCan(selection.role, permission),
      refetch: () => void query.refetch(),
    }),
    [selection, email, query, setActiveCompany, selectStore],
  )

  return <TenantCtx.Provider value={value}>{children}</TenantCtx.Provider>
}
