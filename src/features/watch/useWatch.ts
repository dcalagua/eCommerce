import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTenant } from '@/features/tenant/tenant-context'
import {
  analyzeWatch,
  dismissWatchFinding,
  fetchWatchFindings,
  restoreWatchFinding,
  type WatchKey,
  type WatchResult,
} from './api'

export const watchKey = (companyId: string | null, storeId: string | null) =>
  ['watch', companyId, storeId] as const

/**
 * Los hallazgos de la tienda activa.
 *
 * Se refrescan solos cada cinco minutos y al volver a la pestaña: un panel de
 * criticidad que enseña la foto de hace una hora no vigila nada. No se consulta
 * más seguido porque cada lectura recorre pedidos, inventario y cobranza.
 */
export function useWatch(enabled = true) {
  const { activeCompanyId, activeStore } = useTenant()
  const storeId = activeStore?.id ?? null
  return useQuery<WatchResult>({
    queryKey: watchKey(activeCompanyId ?? null, storeId),
    queryFn: () => fetchWatchFindings(storeId),
    enabled: enabled && Boolean(activeCompanyId),
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
    refetchOnWindowFocus: true,
  })
}

export function useDismissWatch() {
  const { activeCompanyId, activeStore } = useTenant()
  const queryClient = useQueryClient()
  const storeId = activeStore?.id ?? null
  return useMutation({
    mutationFn: (input: { key: WatchKey; fingerprint: string }) =>
      dismissWatchFinding({ ...input, storeId }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: watchKey(activeCompanyId ?? null, storeId) })
    },
  })
}

export function useRestoreWatch() {
  const { activeCompanyId, activeStore } = useTenant()
  const queryClient = useQueryClient()
  const storeId = activeStore?.id ?? null
  return useMutation({
    mutationFn: (key: WatchKey) => restoreWatchFinding({ key, storeId }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: watchKey(activeCompanyId ?? null, storeId) })
    },
  })
}

/**
 * «Ejecutar análisis»: una consulta de IA por pulsación, nunca automática.
 *
 * El resultado no se guarda en caché de consulta porque no es un dato del
 * servidor: es la opinión de una llamada concreta sobre la lista de ese
 * momento.
 */
export function useWatchAnalysis() {
  const { activeStore } = useTenant()
  const storeId = activeStore?.id ?? null
  return useMutation({
    mutationFn: (input: { locale: 'es' | 'en' }) => analyzeWatch({ storeId, locale: input.locale }),
  })
}
