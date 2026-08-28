/**
 * Validación del cuerpo del checkout y **el resumen de la petición**.
 *
 * El resumen (`request_hash`) es la mitad menos obvia de la idempotencia. La
 * clave sola dice «esta es la misma petición»; el hash lo *comprueba*. Sin él:
 *
 *  · un cliente con un error de programación podría reusar la clave para una
 *    compra distinta y recibir el pedido anterior como si fuera el suyo;
 *  · y quien adivinara una clave ajena obtendría el resultado guardado, que
 *    incluye el token de acceso al pedido.
 *
 * Con él, las dos cosas exigen además reproducir exactamente lo que se pidió.
 *
 * El hash tiene que ser **canónico**: el mismo carrito escrito en otro orden de
 * líneas o de claves JSON tiene que dar el mismo resumen, o el reintento del
 * navegador —que reserializa— se leería como una petición distinta y crearía el
 * segundo pedido que todo esto existe para impedir.
 */
import { badRequest } from '../errors.ts'
import { normalizeOrderItems, normalizeShippingAddress, type OrderItemInput } from '../orders.ts'
import {
  optionalText,
  rejectUnknownFields,
  requireEmail,
  requireSlug,
  requireText,
} from '../validation.ts'
import type { CheckoutRequest } from './ports.ts'

export const CHECKOUT_ALLOWED_FIELDS = [
  'store_slug',
  'idempotency_key',
  'cart_token',
  'customer_email',
  'customer_name',
  'customer_phone',
  'items',
  'shipping_address',
  'notes',
  'accept_price_changes',
] as const

/** Mismo formato que `checkout_intents_key_fmt` en la base. */
const IDEMPOTENCY_RE = /^[A-Za-z0-9_-]{24,200}$/
const TOKEN_RE = /^[a-f0-9]{64}$/i

export function requireIdempotencyKey(body: Record<string, unknown>): string {
  const raw = typeof body.idempotency_key === 'string' ? body.idempotency_key.trim() : ''
  if (!IDEMPOTENCY_RE.test(raw)) {
    throw badRequest(
      'IDEMPOTENCIA_INVALIDA',
      'Falta `idempotency_key`: un texto de 24 a 200 caracteres seguros para URL, generado al azar por el cliente',
    )
  }
  return raw
}

export function optionalCartToken(body: Record<string, unknown>): string | null {
  const raw = typeof body.cart_token === 'string' ? body.cart_token.trim() : ''
  if (raw === '') return null
  if (!TOKEN_RE.test(raw)) {
    throw badRequest('CAMPO_INVALIDO', '`cart_token` no tiene la forma de un token de carrito')
  }
  return raw.toLowerCase()
}

/**
 * Serialización CANÓNICA: claves ordenadas y líneas ordenadas por su terna.
 * Es lo que hace que el mismo carrito dé siempre el mismo resumen aunque el
 * navegador reserialice en otro orden.
 */
function canonical(value: unknown): string {
  if (value === null || value === undefined) return 'null'
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
    return `{${entries.join(',')}}`
  }
  return JSON.stringify(value)
}

function itemKey(item: OrderItemInput): string {
  return `${item.product_id}|${item.variant_id ?? ''}|${item.uom_code ?? ''}`
}

/**
 * SHA-256 en hexadecimal. `crypto.subtle` es estándar de la plataforma: existe
 * igual en Deno y en Node, así que la misma función corre en el borde y en los
 * tests sin un polyfill que pudiera calcular otra cosa.
 */
export async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

/**
 * El resumen de LO QUE SE PIDIÓ.
 *
 * Entra: tienda, líneas (ordenadas), contacto, dirección y notas. NO entra la
 * clave de idempotencia —sería circular— ni el token del carrito ni
 * `accept_price_changes`: aceptar un precio nuevo es la misma compra, y si
 * entrara en el hash, confirmar el cambio se leería como una petición distinta
 * y crearía un segundo pedido. Ese es justo el fallo que la fase pide evitar.
 */
export async function requestHash(input: {
  storeSlug: string
  items: readonly OrderItemInput[]
  customerEmail: string
  customerName: string
  customerPhone: string
  shippingAddress: Record<string, unknown>
  notes: string | null
}): Promise<string> {
  const ordered = [...input.items].sort((a, b) => (itemKey(a) < itemKey(b) ? -1 : 1))
  return await sha256Hex(
    canonical({
      store_slug: input.storeSlug.toLowerCase(),
      items: ordered.map((item) => ({
        product_id: item.product_id,
        variant_id: item.variant_id ?? null,
        uom_code: item.uom_code ?? null,
        quantity: item.quantity,
      })),
      customer_email: input.customerEmail.toLowerCase(),
      customer_name: input.customerName,
      customer_phone: input.customerPhone,
      shipping_address: input.shippingAddress,
      notes: input.notes,
    }),
  )
}

export interface ParsedCheckoutBody extends CheckoutRequest {
  readonly acceptPriceChanges: boolean
}

/**
 * El cuerpo entero, validado. Rechaza campos desconocidos ANTES de normalizar,
 * por la misma razón de siempre: descartar en silencio un intento de ponerse
 * precio es el fallo que no se quiere que pase inadvertido.
 */
export async function parseCheckoutBody(
  body: Record<string, unknown>,
): Promise<ParsedCheckoutBody> {
  rejectUnknownFields(body, CHECKOUT_ALLOWED_FIELDS)

  const storeSlug = requireSlug(body, 'store_slug')
  const items = normalizeOrderItems(body.items)
  const customerEmail = requireEmail(body, 'customer_email')
  const customerName = requireText(body, 'customer_name', { min: 2, max: 200 })
  const customerPhone = requireText(body, 'customer_phone', { min: 6, max: 40 })
  const shippingAddress = normalizeShippingAddress(body.shipping_address)
  const notes = optionalText(body, 'notes', 1000)

  const hash = await requestHash({
    storeSlug,
    items,
    customerEmail,
    customerName,
    customerPhone,
    shippingAddress: { ...shippingAddress },
    notes: notes ?? null,
  })

  return {
    storeSlug,
    idempotencyKey: requireIdempotencyKey(body),
    requestHash: hash,
    cartToken: optionalCartToken(body),
    customerName,
    customerEmail,
    customerPhone,
    shippingAddress,
    notes: notes ?? null,
    items,
    acceptPriceChanges: body.accept_price_changes === true,
  }
}
