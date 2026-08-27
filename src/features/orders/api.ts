import type { SupabaseClient } from '@supabase/supabase-js'
import { sanitizeSearchTerm } from '@/shared/lib/search'
import { tryGetSupabaseClient } from '@/shared/lib/supabase'
import { OrderError, orderErrorFromDb, orderErrorFromInvoke } from './errors'
import {
  ORDERS_TABLE,
  ORDER_EVENTS_TABLE,
  ORDER_ITEMS_TABLE,
  orderEventSchema,
  orderItemSchema,
  orderSchema,
  rangeStart,
  type Order,
  type OrderEvent,
  type OrderItem,
  type OrderStatus,
  type OrdersFilter,
} from './types'

/**
 * Acceso a datos de pedidos.
 *
 * Dos reglas gobiernan este archivo:
 *
 *  1. **Leer es una consulta bajo RLS; ESCRIBIR el estado no.** El cambio de
 *     estado pasa SIEMPRE por la Edge Function `update-order-status` (encargo
 *     P07). Aquí no existe ni un `.from('orders').update(...)`, y hay un test
 *     que lo comprueba sobre el código: la máquina de estados, el rechazo de
 *     campos y el 409 de transición imposible viven en un solo sitio.
 *  2. **Ninguna consulta lleva filtro de tenant.** `store_id` se filtra por
 *     alcance de pantalla, no por seguridad: el aislamiento lo pone la RLS con
 *     los claims del JWT.
 */

export const UPDATE_ORDER_STATUS_FUNCTION = 'update-order-status'

/** `::text` en todo el dinero: el céntimo no pasa por el float del navegador. */
const ORDER_SELECT = [
  'id',
  'organization_id',
  'company_id',
  'store_id',
  'order_number',
  'customer_name',
  'customer_email',
  'customer_phone',
  'status',
  'currency',
  'subtotal::text',
  'tax_total::text',
  'shipping_total::text',
  'discount_total::text',
  'grand_total::text',
  'shipping_address',
  'notes',
  'placed_at',
  'updated_at',
].join(', ')

const ITEM_SELECT =
  'id, order_id, product_id, sku, name, unit_price::text, quantity, line_total::text'

const EVENT_SELECT = 'id, order_id, from_status, to_status, note, actor_email, created_at'

function client(): SupabaseClient {
  const supabase = tryGetSupabaseClient()
  if (!supabase) throw new OrderError('auth.notConfigured', 'CONFIG_INCOMPLETA')
  return supabase
}

/**
 * Listado con los tres filtros del encargo: buscador general, estado y fecha.
 *
 * El término se sanea antes de entrar en el `or=`: una coma o un paréntesis no
 * son "texto que no encuentra nada" en PostgREST, son sintaxis del filtro.
 */
export async function fetchOrders(filter: OrdersFilter): Promise<Order[]> {
  if (!filter.storeId) return []

  let query = client()
    .from(ORDERS_TABLE)
    .select(ORDER_SELECT)
    .eq('store_id', filter.storeId)
    .order('placed_at', { ascending: false })

  if (filter.status !== 'all') query = query.eq('status', filter.status)

  const from = rangeStart(filter.range, new Date(`${filter.today}T00:00:00`))
  if (from) query = query.gte('placed_at', from)

  const term = sanitizeSearchTerm(filter.search)
  if (term) {
    query = query.or(
      `order_number.ilike.%${term}%,customer_name.ilike.%${term}%,customer_email.ilike.%${term}%`,
    )
  }

  const { data, error } = await query
  if (error) throw orderErrorFromDb(error)
  return orderSchema.array().parse(data ?? [])
}

/**
 * Un pedido por id. El panel de detalle NO se queda con la fila que había en el
 * listado: tras un cambio de estado esa copia miente, y la bitácora que se pinta
 * al lado sí estaría al día. Se relee del servidor y se muestran las dos cosas
 * del mismo momento.
 */
export async function fetchOrder(orderId: string | null): Promise<Order | null> {
  if (!orderId) return null
  const { data, error } = await client()
    .from(ORDERS_TABLE)
    .select(ORDER_SELECT)
    .eq('id', orderId)
    .maybeSingle()

  if (error) throw orderErrorFromDb(error)
  return data ? orderSchema.parse(data) : null
}

export async function fetchOrderItems(orderId: string | null): Promise<OrderItem[]> {
  if (!orderId) return []
  const { data, error } = await client()
    .from(ORDER_ITEMS_TABLE)
    .select(ITEM_SELECT)
    .eq('order_id', orderId)
    .order('created_at')

  if (error) throw orderErrorFromDb(error)
  return orderItemSchema.array().parse(data ?? [])
}

/**
 * Bitácora del pedido (`order_status_events`, migración 14).
 *
 * Es de solo lectura por construcción: la tabla no da INSERT a `authenticated`
 * y la escribe el trigger `ebim.log_order_status_event`. Aquí no hay ninguna
 * función que "registre" un evento — si existiera, la bitácora podría contar
 * una historia distinta de la que cuenta la columna `status`.
 */
export async function fetchOrderEvents(orderId: string | null): Promise<OrderEvent[]> {
  if (!orderId) return []
  const { data, error } = await client()
    .from(ORDER_EVENTS_TABLE)
    .select(EVENT_SELECT)
    .eq('order_id', orderId)
    .order('created_at', { ascending: true })

  if (error) throw orderErrorFromDb(error)
  return orderEventSchema.array().parse(data ?? [])
}

export interface UpdateStatusInput {
  orderId: string
  status: OrderStatus
  note?: string
}

/**
 * Cambio de estado — único camino de escritura del backoffice sobre un pedido.
 *
 * El cuerpo lleva `order_id`, `status` y la nota opcional. NO lleva tenant (lo
 * saca del token y rechaza con 400 si se declara), ni importes (el GRANT por
 * columna de `orders` ni siquiera los deja tocar), ni el estado anterior: el
 * "desde" lo lee el servidor de la base, que es quien sabe la verdad.
 */
export async function updateOrderStatus(input: UpdateStatusInput): Promise<void> {
  const note = input.note?.trim() ?? ''
  const body: Record<string, unknown> = { order_id: input.orderId, status: input.status }
  if (note) body.notes = note

  const { error } = await client().functions.invoke(UPDATE_ORDER_STATUS_FUNCTION, { body })
  if (error) throw await orderErrorFromInvoke(error)
}
