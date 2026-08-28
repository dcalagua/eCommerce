import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query'
import {
  addOrderExternalRef,
  addOrderNote,
  addOrderTag,
  decideOrderApproval,
  deleteOrderExternalRef,
  deleteOrderNote,
  deleteOrderTag,
  fetchOrder,
  fetchOrderEvents,
  fetchOrderExternalRefs,
  fetchOrderItems,
  fetchOrderNotes,
  fetchOrderTags,
  fetchOrders,
  transitionOrder,
  updateOrderStatus,
  type ApprovalInput,
  type ExternalRefInput,
  type TransitionInput,
  type UpdateStatusInput,
} from './api'
import type {
  Order,
  OrderEvent,
  OrderExternalRef,
  OrderItem,
  OrderNote,
  OrderTag,
  OrdersFilter,
  OrdersPage,
} from './types'

export const ordersKey = (filter: OrdersFilter) => ['orders', filter] as const
export const orderKey = (orderId: string) => ['orders', 'detail', orderId] as const
export const orderItemsKey = (orderId: string) => ['orders', 'items', orderId] as const
export const orderEventsKey = (orderId: string) => ['orders', 'events', orderId] as const
export const orderNotesKey = (orderId: string) => ['orders', 'notes', orderId] as const
export const orderTagsKey = (orderId: string) => ['orders', 'tags', orderId] as const
export const orderRefsKey = (orderId: string) => ['orders', 'refs', orderId] as const

export function useOrders(filter: OrdersFilter): UseQueryResult<OrdersPage> {
  return useQuery({
    queryKey: ordersKey(filter),
    queryFn: () => fetchOrders(filter),
    enabled: Boolean(filter.storeId),
    // Mantener la tabla anterior mientras se teclea o se cambia de página evita
    // el parpadeo a esqueleto en cada letra del buscador.
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

export function useOrderNotes(orderId: string | null): UseQueryResult<OrderNote[]> {
  return useQuery({
    queryKey: orderNotesKey(orderId ?? ''),
    queryFn: () => fetchOrderNotes(orderId),
    enabled: Boolean(orderId),
  })
}

export function useOrderTags(orderId: string | null): UseQueryResult<OrderTag[]> {
  return useQuery({
    queryKey: orderTagsKey(orderId ?? ''),
    queryFn: () => fetchOrderTags(orderId),
    enabled: Boolean(orderId),
  })
}

export function useOrderExternalRefs(
  orderId: string | null,
): UseQueryResult<OrderExternalRef[]> {
  return useQuery({
    queryKey: orderRefsKey(orderId ?? ''),
    queryFn: () => fetchOrderExternalRefs(orderId),
    enabled: Boolean(orderId),
  })
}

/**
 * Toda mutación invalida `['orders']` entero, y no una clave fina.
 *
 * Un cambio de estado mueve el pedido de pestaña, cambia su fila en el listado,
 * cambia el detalle y añade un evento que escribió un TRIGGER —no esta
 * mutación—. Invalidar quirúrgicamente obligaría a acordarse de la línea de
 * tiempo cada vez que se añada un efecto en la base, y el día que a alguien se
 * le olvide la pantalla enseñará un historial incompleto sin dar señal.
 */
function useOrdersMutation<TInput>(run: (input: TInput) => Promise<void>) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: run,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['orders'] })
    },
  })
}

/** Cambio del estado comercial por la Edge Function de P07. */
export function useUpdateOrderStatus() {
  return useOrdersMutation((input: UpdateStatusInput) => updateOrderStatus(input))
}

/** El comando de P08: mueve cualquiera de los tres ejes con su motivo. */
export function useTransitionOrder() {
  return useOrdersMutation((input: TransitionInput) => transitionOrder(input))
}

export function useDecideApproval() {
  return useOrdersMutation((input: ApprovalInput) => decideOrderApproval(input))
}

export function useAddOrderNote() {
  return useOrdersMutation((input: { orderId: string; body: string }) => addOrderNote(input))
}

export function useDeleteOrderNote() {
  return useOrdersMutation((noteId: string) => deleteOrderNote(noteId))
}

export function useAddOrderTag() {
  return useOrdersMutation((input: { orderId: string; tag: string }) => addOrderTag(input))
}

export function useDeleteOrderTag() {
  return useOrdersMutation((tagId: string) => deleteOrderTag(tagId))
}

export function useAddOrderExternalRef() {
  return useOrdersMutation((input: ExternalRefInput) => addOrderExternalRef(input))
}

export function useDeleteOrderExternalRef() {
  return useOrdersMutation((refId: string) => deleteOrderExternalRef(refId))
}
