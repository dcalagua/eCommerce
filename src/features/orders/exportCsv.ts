import { toCsv } from '@/shared/lib/csv'
import type { Order } from './types'

export { downloadCsv } from '@/shared/lib/csv'

const HEADERS = [
  'order_number',
  'placed_at',
  'status',
  'customer_name',
  'customer_email',
  'customer_phone',
  'currency',
  'subtotal',
  'tax_total',
  'grand_total',
  'shipping_address',
] as const

/**
 * Exporta lo que se está viendo, con los filtros aplicados.
 *
 * Los importes salen como el texto decimal que devolvió la base, sin pasar por
 * `Intl`: un CSV con separador de miles y símbolo de moneda deja de ser un
 * número para la hoja de cálculo que lo abre.
 */
export function ordersToCsv(orders: Order[]): string {
  return toCsv(
    HEADERS,
    orders.map((order) => [
      order.order_number,
      order.placed_at,
      order.status,
      order.customer_name ?? '',
      order.customer_email,
      order.customer_phone ?? '',
      order.currency,
      order.subtotal,
      order.tax_total,
      order.grand_total,
      [order.shipping_address?.address, order.shipping_address?.reference]
        .filter(Boolean)
        .join(' — '),
    ]),
  )
}
