import type { MessageKey } from '@/shared/i18n/messages'
import type { OrderStatus } from './types'

/** Etiquetas y color del estado. Una sola tabla para el listado y el detalle. */
export const STATUS_LABEL: Record<OrderStatus, MessageKey> = {
  pending: 'orders.status.pending',
  paid: 'orders.status.paid',
  fulfilled: 'orders.status.fulfilled',
  cancelled: 'orders.status.cancelled',
  refunded: 'orders.status.refunded',
}

export type StatusColor = 'default' | 'info' | 'success' | 'warning' | 'error'

export const STATUS_COLOR: Record<OrderStatus, StatusColor> = {
  pending: 'warning',
  paid: 'info',
  fulfilled: 'success',
  cancelled: 'default',
  refunded: 'error',
}
