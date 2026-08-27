/**
 * Reglas de pedido compartidas entre `create-order` y `update-order-status`.
 *
 * La máquina de estados está DUPLICADA a propósito: la versión que manda es el
 * trigger `ebim.assert_order_transition` en la base (nadie la puede saltar);
 * esta copia solo existe para devolver un 409 claro antes de ir a la base.
 * Un test verifica que las dos digan lo mismo.
 */
import { badRequest } from './errors.ts'

export const ORDER_STATUSES = [
  'pending',
  'paid',
  'fulfilled',
  'cancelled',
  'refunded',
] as const

export type OrderStatus = (typeof ORDER_STATUSES)[number]

export const ORDER_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  pending: ['paid', 'cancelled'],
  paid: ['fulfilled', 'refunded', 'cancelled'],
  fulfilled: ['refunded'],
  cancelled: [],
  refunded: [],
}

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  if (from === to) return true
  return ORDER_TRANSITIONS[from].includes(to)
}

export type OrderItemInput = { product_id: string; quantity: number }

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Campos de precio que el cliente no decide. Si vienen, la petición se cae. */
const FORBIDDEN_ITEM_FIELDS = [
  'price',
  'unit_price',
  'unitPrice',
  'line_total',
  'lineTotal',
  'subtotal',
  'total',
  'currency',
  'discount',
  'organization_id',
  'company_id',
  'tenant_id',
  'store_id',
]

/**
 * Normaliza el carrito: solo `product_id` y `quantity` sobreviven. Cualquier
 * intento de mandar un precio se rechaza explícitamente (contrato §2.6: nadie
 * que entrega un caso se autoasigna su precio).
 */
export function normalizeOrderItems(raw: unknown): OrderItemInput[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw badRequest('ITEMS_REQUERIDOS', 'El pedido necesita al menos una linea')
  }
  if (raw.length > 100) {
    throw badRequest('ITEMS_EXCESIVOS', 'Maximo 100 lineas por pedido')
  }

  const merged = new Map<string, number>()

  for (const entry of raw) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw badRequest('ITEM_INVALIDO', 'Cada linea debe ser un objeto {product_id, quantity}')
    }
    const item = entry as Record<string, unknown>

    const offenders = FORBIDDEN_ITEM_FIELDS.filter((field) => field in item)
    if (offenders.length > 0) {
      throw badRequest(
        'CAMPO_NO_PERMITIDO',
        `El precio y el tenant los decide el servidor. Campos rechazados: ${offenders.join(', ')}`,
      )
    }

    const productId = typeof item.product_id === 'string' ? item.product_id.toLowerCase() : ''
    if (!UUID_RE.test(productId)) {
      throw badRequest('ITEM_INVALIDO', '`product_id` debe ser un uuid')
    }

    const quantity = item.quantity
    if (typeof quantity !== 'number' || !Number.isInteger(quantity) || quantity <= 0) {
      throw badRequest('CANTIDAD_INVALIDA', 'La cantidad debe ser un entero mayor que cero')
    }
    if (quantity > 10000) {
      throw badRequest('CANTIDAD_INVALIDA', 'La cantidad maxima por linea es 10000')
    }

    merged.set(productId, (merged.get(productId) ?? 0) + quantity)
  }

  return [...merged.entries()].map(([product_id, quantity]) => ({ product_id, quantity }))
}

/** Lo único que la vitrina pregunta para la entrega (P06: checkout mínimo). */
export type ShippingAddress = { address: string; reference?: string }

const SHIPPING_FIELDS = ['address', 'reference']

/**
 * Dirección de entrega del checkout mínimo: calle obligatoria y referencia
 * opcional. Nada más — ni coordenadas, ni ciudad, ni país: pedir datos que
 * nadie usa es tan malo como no pedir los que sí.
 *
 * Las claves desconocidas se RECHAZAN en vez de guardarse: `shipping_address`
 * es un `jsonb` y sin esta puerta se convierte en el vertedero por el que
 * entra cualquier cosa que se le ocurra al cliente.
 */
export function normalizeShippingAddress(raw: unknown): ShippingAddress {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw badRequest('CAMPO_INVALIDO', '`shipping_address` debe ser un objeto')
  }

  const source = raw as Record<string, unknown>
  const unknown = Object.keys(source).filter((key) => !SHIPPING_FIELDS.includes(key))
  if (unknown.length > 0) {
    throw badRequest(
      'CAMPO_NO_PERMITIDO',
      `\`shipping_address\` solo admite address y reference. Campos rechazados: ${unknown.join(', ')}`,
    )
  }

  const address = typeof source.address === 'string' ? source.address.trim() : ''
  if (address.length < 3 || address.length > 300) {
    throw badRequest(
      'CAMPO_INVALIDO',
      '`shipping_address.address` debe tener entre 3 y 300 caracteres',
    )
  }

  const rawReference = source.reference
  if (rawReference !== undefined && rawReference !== null && typeof rawReference !== 'string') {
    throw badRequest('CAMPO_INVALIDO', '`shipping_address.reference` debe ser texto')
  }
  const reference = typeof rawReference === 'string' ? rawReference.trim() : ''
  if (reference.length > 200) {
    throw badRequest('CAMPO_INVALIDO', '`shipping_address.reference` supera los 200 caracteres')
  }

  return reference ? { address, reference } : { address }
}
