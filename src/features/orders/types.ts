import { z } from 'zod'
import { moneyText } from '@/shared/lib/money'

/**
 * Pedidos del backoffice.
 *
 * **Los estados son los de la base, no los del encargo.** El encargo sugería
 * `pending/confirmed/preparing/ready/completed/cancelled` «salvo definición
 * EBIM distinta», y la definición EBIM existe desde P02: el enum
 * `public.order_status` de `20260827090400_orders.sql`, con su máquina de
 * estados en trigger (`ebim.assert_order_transition`), sus policies, su
 * `create_order` y sus tests de aislamiento. Renombrarlo sería tocar la mitad
 * del esquema para no ganar nada — mismo criterio que las decisiones 14
 * (`tenant_id`) y 31 (`stock_qty`).
 */
export const ORDER_STATUSES = ['pending', 'paid', 'fulfilled', 'cancelled', 'refunded'] as const
export type OrderStatus = (typeof ORDER_STATUSES)[number]

/**
 * Copia de la máquina de estados que vive en el trigger de la base y en
 * `supabase/functions/_shared/orders.ts`.
 *
 * Existe para no ofrecer en el menú una transición que la base va a rechazar:
 * la autoridad sigue siendo el trigger. Un test compara las dos copias, igual
 * que hace `roles.test.ts` con la matriz de capacidades.
 */
export const ORDER_TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  pending: ['paid', 'cancelled'],
  paid: ['fulfilled', 'refunded', 'cancelled'],
  fulfilled: ['refunded'],
  cancelled: [],
  refunded: [],
}

/** Transiciones que el backoffice puede ofrecer desde el estado actual. */
export function nextStatuses(from: OrderStatus): readonly OrderStatus[] {
  return ORDER_TRANSITIONS[from]
}

/** Nombres reales de las tablas. Fuente unica: `shared/lib/db-schema.ts`. */
export { ORDERS_TABLE, ORDER_ITEMS_TABLE, ORDER_EVENTS_TABLE } from '@/shared/lib/db-schema'

/**
 * Dirección de entrega: exactamente las dos claves que acepta `create-order`
 * (`address` + `reference` opcional). Se valida al leer porque `jsonb` no
 * garantiza forma: un pedido antiguo con otra estructura se pinta vacío, no
 * revienta la pantalla.
 */
export const shippingAddressSchema = z
  .object({
    address: z.string().nullable().default(null),
    reference: z.string().nullable().default(null),
  })
  .partial()
  .catch({})
export type ShippingAddress = z.infer<typeof shippingAddressSchema>

/**
 * Todo el dinero llega como TEXTO (`grand_total::text` en el `select`): un
 * `numeric` en JSON se vuelve float en el primer `JSON.parse` (decisión P02
 * #19). Hasta P06 este esquema lo leía como `number` — se corrige aquí, que es
 * la primera pantalla que enseña importes de pedido.
 */
export const orderSchema = z.object({
  id: z.string().uuid(),
  organization_id: z.string().uuid(),
  company_id: z.string().uuid(),
  store_id: z.string().uuid(),
  order_number: z.string(),
  customer_name: z.string().nullable().default(null),
  customer_email: z.string(),
  customer_phone: z.string().nullable().default(null),
  status: z.enum(ORDER_STATUSES),
  currency: z.string().length(3),
  subtotal: moneyText,
  tax_total: moneyText,
  shipping_total: moneyText,
  discount_total: moneyText,
  grand_total: moneyText,
  shipping_address: shippingAddressSchema.nullable().default(null),
  notes: z.string().nullable().default(null),
  placed_at: z.string(),
  updated_at: z.string().nullable().default(null),
})
export type Order = z.infer<typeof orderSchema>

/** Línea del pedido: snapshot del producto en el momento de la compra. */
export const orderItemSchema = z.object({
  id: z.string().uuid(),
  order_id: z.string().uuid(),
  product_id: z.string().uuid().nullable().default(null),
  sku: z.string(),
  name: z.string(),
  unit_price: moneyText,
  quantity: z.number().int(),
  line_total: moneyText,
})
export type OrderItem = z.infer<typeof orderItemSchema>

/** Evento de la bitácora `order_status_events` (migración 14). */
export const orderEventSchema = z.object({
  id: z.string().uuid(),
  order_id: z.string().uuid(),
  from_status: z.enum(ORDER_STATUSES).nullable().default(null),
  to_status: z.enum(ORDER_STATUSES),
  note: z.string().nullable().default(null),
  actor_email: z.string().nullable().default(null),
  created_at: z.string(),
})
export type OrderEvent = z.infer<typeof orderEventSchema>

// ---------------------------------------------------------------------------
// Filtros del listado
// ---------------------------------------------------------------------------

/**
 * Filtro de fecha por PRESETS, no por un panel de dos calendarios.
 *
 * La regla de suite (§8) es un buscador general + tabs de estado; el encargo
 * pide además filtrar por fecha. Un `Select` con rangos cerrados cumple las dos
 * cosas: es un solo control, no un formulario de filtros escondido en un panel.
 */
export const ORDER_DATE_RANGES = ['all', 'today', 'week', 'month', 'quarter'] as const
export type OrderDateRange = (typeof ORDER_DATE_RANGES)[number]

const RANGE_DAYS: Record<Exclude<OrderDateRange, 'all' | 'today'>, number> = {
  week: 7,
  month: 30,
  quarter: 90,
}

/**
 * Inicio del rango en ISO, o `null` para «todos».
 *
 * `now` se recibe como parámetro para que el test no dependa del reloj y para
 * que la clave de react-query no cambie cada milisegundo.
 */
export function rangeStart(range: OrderDateRange, now: Date): string | null {
  if (range === 'all') return null
  const start = new Date(now)
  start.setHours(0, 0, 0, 0)
  if (range !== 'today') start.setDate(start.getDate() - RANGE_DAYS[range] + 1)
  return start.toISOString()
}

export type OrderStatusFilter = OrderStatus | 'all'

export interface OrdersFilter {
  storeId: string | null
  search: string
  status: OrderStatusFilter
  range: OrderDateRange
  /** Día de referencia (`YYYY-MM-DD`): estabiliza la clave de caché. */
  today: string
}
