import { z } from 'zod'

export const ORDER_STATUSES = ['pending', 'paid', 'fulfilled', 'cancelled', 'refunded'] as const

/**
 * Pedido del tenant, con los nombres de columna reales de
 * `20260827090400_orders.sql` (`order_number`, `grand_total`, `placed_at`).
 * El aislamiento lo aplica RLS con los claims del JWT.
 */
export const orderSchema = z.object({
  id: z.string().uuid(),
  organization_id: z.string().uuid(),
  company_id: z.string().uuid(),
  store_id: z.string().uuid(),
  order_number: z.string(),
  customer_name: z.string().nullable().default(null),
  customer_email: z.string(),
  status: z.enum(ORDER_STATUSES),
  grand_total: z.number().nonnegative(),
  currency: z.string().length(3),
  placed_at: z.string(),
})

export type Order = z.infer<typeof orderSchema>
export type OrderStatus = (typeof ORDER_STATUSES)[number]

export const ORDERS_TABLE = 'orders'
