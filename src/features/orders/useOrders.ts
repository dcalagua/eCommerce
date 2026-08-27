import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query'
import {
  fetchOrder,
  fetchOrderEvents,
  fetchOrderItems,
  fetchOrders,
  updateOrderStatus,
  type UpdateStatusInput,
} from './api'
import type { Order, OrderEvent, OrderItem, OrdersFilter } from './types'

export const ordersKey = (filter: OrdersFilter) => ['orders', filter] as const
export const orderKey = (orderId: string) => ['orders', 'detail', orderId] as const
export const orderItemsKey = (orderId: string) => ['orders', 'items', orderId] as const
export const orderEventsKey = (orderId: string) => ['orders', 'events', orderId] as const

export function useOrders(filter: OrdersFilter): UseQueryResult<Order[]> {
  return useQuery({
    queryKey: ordersKey(filter),
    queryFn: () => fetchOrders(filter),
    enabled: Boolean(filter.storeId),
    // Mantener la tabla anterior mientras se teclea evita el parpadeo a
    // esqueleto en cada letra del buscador.
    placeholderData: (previous) => previous,
  })
}

/**
 * Detalle vivo del pedido. `initialData` es la fila del listado: pinta el panel
 * al instante y se sustituye en cuanto responde el servidor.
 */
export function useOrder(orderId: string | null, initial?: Order): UseQueryResult<Order | null> {
  return useQuery({
    queryKey: orderKey(orderId ?? ''),
    queryFn: () => fetchOrder(orderId),
    enabled: Boolean(orderId),
    initialData: initial,
  })
}

export function useOrderItems(orderId: string | null): UseQueryResult<OrderItem[]> {
  return useQuery({
    queryKey: orderItemsKey(orderId ?? ''),
    queryFn: () => fetchOrderItems(orderId),
    enabled: Boolean(orderId),
  })
}

export function useOrderEvents(orderId: string | null): UseQueryResult<OrderEvent[]> {
  return useQuery({
    queryKey: orderEventsKey(orderId ?? ''),
    queryFn: () => fetchOrderEvents(orderId),
    enabled: Boolean(orderId),
  })
}

/**
 * Cambio de estado por Edge Function.
 *
 * Al terminar se invalida TODO lo que cuelga de `orders`: el listado (el pedido
 * cambia de pestaña), el detalle y la bitácora — que acaba de ganar un evento
 * escrito por el trigger, no por esta mutación.
 */
export function useUpdateOrderStatus() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: UpdateStatusInput) => updateOrderStatus(input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['orders'] })
    },
  })
}
