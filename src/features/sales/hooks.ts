import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query'
import {
  assignCustomer,
  deactivateSalesRep,
  fetchPortfolio,
  fetchSalesReps,
  removeFromPortfolio,
  saveSalesRep,
} from './api'
import type { PortfolioRow, SalesRep } from './types'

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
