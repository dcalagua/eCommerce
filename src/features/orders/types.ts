import { z } from 'zod'

export const ORDER_STATUSES = ['pending', 'paid', 'fulfilled', 'cancelled'] as const

/** Pedido del tenant. El aislamiento lo aplica RLS con los claims del JWT. */
export const orderSchema = z.object({
  id: z.string().uuid(),
  organization_id: z.string().uuid(),
  company_id: z.string().uuid(),
  number: z.string(),
  customer_name: z.string(),
  status: z.enum(ORDER_STATUSES),
  total: z.number().nonnegative(),
  currency: z.string().length(3),
  created_at: z.string(),
})

export type Order = z.infer<typeof orderSchema>
export type OrderStatus = (typeof ORDER_STATUSES)[number]

export const ORDERS_TABLE = 'orders'
