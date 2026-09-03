import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query'
import {
  addRouteStop,
  advanceCommission,
  assignCustomer,
  checkInVisit,
  closeVisit,
  deactivateSalesRep,
  fetchCommissions,
  fetchGoals,
  fetchPortfolio,
  fetchRouteStops,
  fetchRoutes,
  fetchSalesReps,
  fetchTerritories,
  fetchVisits,
  removeFromPortfolio,
  removeRouteStop,
  saveGoal,
  saveRoute,
  saveSalesRep,
  saveTerritory,
  saveVisit,
} from './api'
import type {
  Commission,
  Goal,
  PortfolioRow,
  Route,
  RouteStop,
  SalesRep,
  Territory,
  Visit,
} from './types'

/**
 * Estado de la fuerza de ventas en el cliente.
 *
 * Todo cuelga de `SALES_KEY`, y una escritura invalida el árbol entero en vez
 * de la clave exacta. Es a propósito: la cartera, la jerarquía y el listado se
 * miran a la vez en esta pantalla, y una invalidación quirúrgica dejaría el
 * desplegable de jefes con un vendedor que se acaba de desactivar.
 */
export const SALES_KEY = ['sales'] as const
export const repsKey = () => [...SALES_KEY, 'reps'] as const
export const portfolioKey = (repId: string | null) =>
  [...SALES_KEY, 'portfolio', repId ?? 'none'] as const

function useInvalidateSales() {
  const queryClient = useQueryClient()
  return () => queryClient.invalidateQueries({ queryKey: SALES_KEY })
}

export function useSalesReps(): UseQueryResult<SalesRep[]> {
  return useQuery({
    queryKey: repsKey(),
    queryFn: fetchSalesReps,
    // Es un maestro: cambia poco y se consulta en cada pestaña de esta página.
    staleTime: 60_000,
    retry: false,
  })
}

export function usePortfolio(repId: string | null): UseQueryResult<PortfolioRow[]> {
  return useQuery({
    queryKey: portfolioKey(repId),
    queryFn: () => fetchPortfolio(repId),
    enabled: repId !== null,
    retry: false,
  })
}

export function useSaveSalesRep() {
  const invalidate = useInvalidateSales()
  return useMutation({ mutationFn: saveSalesRep, onSuccess: invalidate })
}

export function useDeactivateSalesRep() {
  const invalidate = useInvalidateSales()
  return useMutation({ mutationFn: deactivateSalesRep, onSuccess: invalidate })
}

export function useAssignCustomer() {
  const invalidate = useInvalidateSales()
  return useMutation({ mutationFn: assignCustomer, onSuccess: invalidate })
}

export function useRemoveFromPortfolio() {
  const invalidate = useInvalidateSales()
  return useMutation({ mutationFn: removeFromPortfolio, onSuccess: invalidate })
}

// ---------------------------------------------------------------------------
// Territorios, rutas, visitas, metas y comisiones
// ---------------------------------------------------------------------------

export const territoriesKey = () => [...SALES_KEY, 'territories'] as const
export const routesKey = () => [...SALES_KEY, 'routes'] as const
export const routeStopsKey = (routeId: string | null) =>
  [...SALES_KEY, 'route-stops', routeId ?? 'none'] as const
export const visitsKey = () => [...SALES_KEY, 'visits'] as const
export const goalsKey = () => [...SALES_KEY, 'goals'] as const
export const commissionsKey = () => [...SALES_KEY, 'commissions'] as const

export function useTerritories(): UseQueryResult<Territory[]> {
  return useQuery({
    queryKey: territoriesKey(),
    queryFn: fetchTerritories,
    // Otro maestro: lo consultan rutas y metas, no solo su propia pestaña.
    staleTime: 60_000,
    retry: false,
  })
}

export function useRoutes(): UseQueryResult<Route[]> {
  return useQuery({ queryKey: routesKey(), queryFn: fetchRoutes, retry: false })
}

export function useRouteStops(routeId: string | null): UseQueryResult<RouteStop[]> {
  return useQuery({
    queryKey: routeStopsKey(routeId),
    queryFn: () => fetchRouteStops(routeId),
    enabled: routeId !== null,
    retry: false,
  })
}

export function useVisits(): UseQueryResult<Visit[]> {
  return useQuery({ queryKey: visitsKey(), queryFn: fetchVisits, retry: false })
}

export function useGoals(): UseQueryResult<Goal[]> {
  return useQuery({ queryKey: goalsKey(), queryFn: fetchGoals, retry: false })
}

export function useCommissions(): UseQueryResult<Commission[]> {
  return useQuery({ queryKey: commissionsKey(), queryFn: fetchCommissions, retry: false })
}

export function useSaveTerritory() {
  const invalidate = useInvalidateSales()
  return useMutation({ mutationFn: saveTerritory, onSuccess: invalidate })
}

export function useSaveRoute() {
  const invalidate = useInvalidateSales()
  return useMutation({ mutationFn: saveRoute, onSuccess: invalidate })
}

export function useAddRouteStop() {
  const invalidate = useInvalidateSales()
  return useMutation({ mutationFn: addRouteStop, onSuccess: invalidate })
}

export function useRemoveRouteStop() {
  const invalidate = useInvalidateSales()
  return useMutation({ mutationFn: removeRouteStop, onSuccess: invalidate })
}

export function useSaveVisit() {
  const invalidate = useInvalidateSales()
  return useMutation({ mutationFn: saveVisit, onSuccess: invalidate })
}

export function useCheckInVisit() {
  const invalidate = useInvalidateSales()
  return useMutation({ mutationFn: checkInVisit, onSuccess: invalidate })
}

export function useCloseVisit() {
  const invalidate = useInvalidateSales()
  return useMutation({ mutationFn: closeVisit, onSuccess: invalidate })
}

export function useSaveGoal() {
  const invalidate = useInvalidateSales()
  return useMutation({ mutationFn: saveGoal, onSuccess: invalidate })
}

export function useAdvanceCommission() {
  const invalidate = useInvalidateSales()
  return useMutation({ mutationFn: advanceCommission, onSuccess: invalidate })
}
