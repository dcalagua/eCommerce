import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  fetchAuditLog,
  fetchIncidents,
  fetchOpsHealth,
  fetchTrace,
  resolveIncident,
  type IncidentFilter,
} from './api'
import { isForbidden } from './errors'

/**
 * Estado de la pantalla de operación.
 *
 * `retry: false` cuando el error es de PERMISO: reintentar cuatro veces un 403
 * solo retrasa el mensaje, y aquí el 403 es una respuesta legítima —la salud
 * operativa la ven `owner` y `admin`, no cualquier miembro—.
 *
 * La única mutación es atender un incidente, y solo invalida el árbol de `ops`:
 * resolver un incidente no cambia ni una venta.
 */
export const OPS_KEY = ['ops'] as const

export const healthKey = (storeId: string | null) => [...OPS_KEY, 'health', storeId] as const
export const incidentsKey = (filter: IncidentFilter) =>
  [...OPS_KEY, 'incidents', filter.status, filter.term] as const
export const auditKey = (term: string) => [...OPS_KEY, 'audit', term] as const
export const traceKey = (correlationId: string) => [...OPS_KEY, 'trace', correlationId] as const

const noRetryOnForbidden = (count: number, error: unknown) => !isForbidden(error) && count < 1

export function useOpsHealth(storeId: string | null) {
  return useQuery({
    queryKey: healthKey(storeId),
    queryFn: () => fetchOpsHealth(storeId),
    retry: noRetryOnForbidden,
    // La salud caduca rápido a propósito: mirar una cola de hace cinco minutos
    // durante un incidente es peor que no mirarla, porque parece actual.
    staleTime: 15_000,
  })
}

export function useIncidents(filter: IncidentFilter) {
  return useQuery({
    queryKey: incidentsKey(filter),
    queryFn: () => fetchIncidents(filter),
    retry: noRetryOnForbidden,
  })
}

export function useAuditLog(term: string) {
  return useQuery({
    queryKey: auditKey(term),
    queryFn: () => fetchAuditLog(term),
    retry: noRetryOnForbidden,
  })
}

/**
 * El rastreo NO se dispara solo: `enabled` cuelga de que alguien haya pegado un
 * identificador. Una consulta automática con la caja vacía sería una llamada
 * por tecleo contra once tablas.
 */
export function useTrace(correlationId: string) {
  const clean = correlationId.trim()
  return useQuery({
    queryKey: traceKey(clean),
    queryFn: () => fetchTrace(clean),
    enabled: clean.length >= 8,
    retry: noRetryOnForbidden,
  })
}

export function useResolveIncident() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, note }: { id: string; note: string }) => resolveIncident(id, note),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: OPS_KEY })
    },
  })
}
