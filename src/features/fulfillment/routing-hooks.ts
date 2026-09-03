import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query'
import {
  addPlanStop,
  fetchPlanStops,
  fetchPlans,
  fetchPods,
  fetchVehicles,
  recordPod,
  removePlanStop,
  savePlan,
  setPlanStatus,
} from './routing-api'
import type { Plan, PlanStop, Pod, Vehicle } from './routing-types'

/**
 * Estado del reparto propio en el cliente.
 *
 * Todo cuelga de `ROUTING_KEY` y una escritura invalida la rama entera: firmar
 * una entrega cambia lo que se ve en la hoja de ruta y en la cola, y una
 * invalidación quirúrgica dejaría una parada enseñándose como pendiente después
 * de haberla firmado — que es la forma más rápida de que alguien la firme dos
 * veces contra una tabla que no admite correcciones.
 */
export const ROUTING_KEY = ['fulfillment', 'routing'] as const
export const vehiclesKey = () => [...ROUTING_KEY, 'vehicles'] as const
export const plansKey = () => [...ROUTING_KEY, 'plans'] as const
export const planStopsKey = (planId: string | null) =>
  [...ROUTING_KEY, 'stops', planId ?? 'none'] as const
export const podsKey = () => [...ROUTING_KEY, 'pods'] as const

function useInvalidateRouting() {
  const queryClient = useQueryClient()
  return () => queryClient.invalidateQueries({ queryKey: ROUTING_KEY })
}

export function useVehicles(): UseQueryResult<Vehicle[]> {
  return useQuery({
    queryKey: vehiclesKey(),
    queryFn: fetchVehicles,
    // Un maestro: la flota cambia poco y se consulta en cada hoja de ruta.
    staleTime: 60_000,
    retry: false,
  })
}

export function usePlans(): UseQueryResult<Plan[]> {
  return useQuery({ queryKey: plansKey(), queryFn: fetchPlans, retry: false })
}

export function usePlanStops(planId: string | null): UseQueryResult<PlanStop[]> {
  return useQuery({
    queryKey: planStopsKey(planId),
    queryFn: () => fetchPlanStops(planId),
    enabled: planId !== null,
    retry: false,
  })
}

export function usePods(): UseQueryResult<Pod[]> {
  return useQuery({ queryKey: podsKey(), queryFn: fetchPods, retry: false })
}

export function useSavePlan() {
  const invalidate = useInvalidateRouting()
  return useMutation({ mutationFn: savePlan, onSuccess: invalidate })
}

export function useSetPlanStatus() {
  const invalidate = useInvalidateRouting()
  return useMutation({ mutationFn: setPlanStatus, onSuccess: invalidate })
}

export function useAddPlanStop() {
  const invalidate = useInvalidateRouting()
  return useMutation({ mutationFn: addPlanStop, onSuccess: invalidate })
}

export function useRemovePlanStop() {
  const invalidate = useInvalidateRouting()
  return useMutation({ mutationFn: removePlanStop, onSuccess: invalidate })
}

export function useRecordPod() {
  const invalidate = useInvalidateRouting()
  return useMutation({ mutationFn: recordPod, onSuccess: invalidate })
}
