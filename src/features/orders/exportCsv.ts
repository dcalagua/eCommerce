import { toCsv } from '@/shared/lib/csv'
import type { Order } from './types'

export { downloadCsv } from '@/shared/lib/csv'

const HEADERS = [
  'order_number',
  'placed_at',
  'source_channel',
  'status',
  'payment_status',
  'fulfillment_status',
  'approval_status',
  'customer_name',
  'customer_email',
  'customer_phone',
  'currency',
  'subtotal',
  'tax_total',
  'discount_total',
  'grand_total',
  'shipping_address',
  'billing_address',
  'account_name',
  'tax_id',
] as const

function address(value: { address?: string | null; reference?: string | null } | null): string {
  if (!value) return ''
  return [value.address, value.reference].filter(Boolean).join(' — ')
}

/**
 * Exporta LO FILTRADO, no la página que se está viendo.
 *
 * Desde que el listado pagina (P08), exportar las filas en pantalla daría 25
 * líneas y nadie lo notaría hasta abrir el archivo. La consulta la repite
 * `fetchOrdersForExport` con los mismos filtros y sin `range`.
 *
 * **Tenant y permisos.** El tenant lo pone la RLS —la consulta no lleva
 * `organization_id`— y el permiso lo comprueba la pantalla antes de llamar: la
 * exportación de pedidos exige `orders.read`, que es lo mismo que hace falta
 * para ver el listado. Un rol que no puede ver un pedido tampoco puede
 * llevárselo en un archivo.
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
      order.source_channel,
      order.status,
      order.payment_status,
      order.fulfillment_status,
      order.approval_status,
      order.customer_name ?? '',
      order.customer_email,
      order.customer_phone ?? '',
      order.currency,
      order.subtotal,
      order.tax_total,
      order.discount_total,
      order.grand_total,
      address(order.shipping_address),
      address(order.billing_address),
      order.customer_snapshot?.account_name ?? '',
      order.customer_snapshot?.tax_id ?? '',
    ]),
  )
}
