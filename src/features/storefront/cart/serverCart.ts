import { z } from 'zod'
import { AppError } from '@/domain/errors'
import { codeFromDbError, type PostgrestLike } from '@/shared/lib/appError'
import {
  CART_ABANDON_RPC,
  CART_OPEN_RPC,
  CART_REPLACE_LINES_RPC,
} from '@/shared/lib/db-schema'
import { moneyText } from '@/shared/lib/money'
import { tryGetStorefrontClient, tryGetSupabaseClient } from '@/shared/lib/supabase'
import type { Cart } from './cart'

/**
 * El carrito del SERVIDOR (P07-SaaS).
 *
 * ## Cuándo existe, que es la decisión de diseño
 *
 * No siempre. Un invitado que curiosea el catálogo sigue comprando desde
 * `localStorage` y no deja ni una fila: crear un carrito de servidor por visita
 * sería una tabla de basura y un dato personal más que custodiar. La fila nace
 * en dos momentos, y los dos son momentos en los que hace falta de verdad:
 *
 *  1. **Al iniciar sesión**, porque a partir de ahí el carrito tiene que viajar
 *     con la persona y no con el navegador.
 *  2. **Al empezar el checkout**, porque hace falta un ancla estable a la que
 *     colgar la reserva de existencia y el intento idempotente.
 *
 * ## Qué cliente se usa, y por qué son dos
 *
 * Sin sesión, el cliente ANÓNIMO de la vitrina: el carrito de un invitado se
 * autoriza con su token y nada más. Con sesión, el cliente con JWT, porque
 * `cart_open` resuelve el carrito del usuario a partir de `ebim.user_id()` — y
 * con el cliente anónimo ese `user_id` sería nulo y se abriría un carrito de
 * invitado en vez del suyo.
 *
 * ## Qué NO se manda nunca
 *
 * Ni precio, ni total, ni moneda, ni `store_id`, ni `user_id`, ni `cart_id`.
 * La tienda sale del slug de la URL, el dueño sale de la sesión o del token, y
 * el precio lo pone el motor. El `unit_price_snapshot` que devuelve el servidor
 * es informativo por contrato: sirve para poder decir «esto subió», jamás para
 * cobrar.
 */

const TOKEN_PREFIX = 'ebim.ecommerce.cart-token.v1'

export class ServerCartError extends AppError {
  constructor(code: string) {
    super({ boundary: 'checkout', code, message: 'No se pudo sincronizar el carrito' })
    this.name = 'ServerCartError'
  }
}

function serverCartError(error: PostgrestLike): ServerCartError {
  return new ServerCartError(codeFromDbError(error))
}

// ---------------------------------------------------------------------------
// El token del invitado
// ---------------------------------------------------------------------------

export function cartTokenStorageKey(storeId: string): string {
  return `${TOKEN_PREFIX}:${storeId}`
}

/** 64 hexadecimales, exactamente como los emite la base. Otra cosa se descarta. */
const TOKEN_RE = /^[a-f0-9]{64}$/

function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage
  } catch {
    return null
  }
}

export function readCartToken(storeId: string): string | null {
  const store = storage()
  if (!store) return null
  try {
    const raw = store.getItem(cartTokenStorageKey(storeId))
    return raw && TOKEN_RE.test(raw) ? raw : null
  } catch {
    return null
  }
}

export function writeCartToken(storeId: string, token: string): void {
  const store = storage()
  if (!store || !TOKEN_RE.test(token)) return
  try {
    store.setItem(cartTokenStorageKey(storeId), token)
  } catch {
    /* cuota llena o almacenamiento bloqueado: el carrito sigue en memoria */
  }
}

export function clearCartToken(storeId: string): void {
  const store = storage()
  if (!store) return
  try {
    store.removeItem(cartTokenStorageKey(storeId))
  } catch {
    /* nada que hacer */
  }
}

// ---------------------------------------------------------------------------
// La forma de la respuesta
// ---------------------------------------------------------------------------

export const serverCartLineSchema = z.object({
  product_id: z.string().uuid(),
  variant_id: z.string().uuid().nullable().default(null),
  uom_code: z.string().nullable().default(null),
  quantity: z.number().int().min(1),
  slug: z.string().min(1),
  name: z.string().min(1),
  unit_price_snapshot: moneyText.nullable().default(null),
  unit_price: moneyText.nullable().default(null),
  /**
   * P18 · La RUTA de la foto principal, nunca una URL.
   *
   * `default(null)` y no `optional`: una respuesta anterior al despliegue de
   * esta migración se lee como la línea sin foto que era, y el carrito sigue
   * cayendo a la copia local — que es lo que hacía antes.
   */
  image_path: z.string().nullable().default(null),
  /** El precio de catálogo cambió desde que la línea entró en el carrito. */
  price_changed: z.boolean().default(false),
  in_stock: z.boolean().default(true),
  /** «No se sabe» no es «no hay» (P06): son dos avisos distintos. */
  availability_unknown: z.boolean().default(false),
})
export type ServerCartLine = z.infer<typeof serverCartLineSchema>

export const serverCartQuoteSchema = z.object({
  currency: z.string().length(3),
  tax_inclusive: z.boolean().default(false),
  subtotal: moneyText,
  tax_total: moneyText,
  grand_total: moneyText,
})
export type ServerCartQuote = z.infer<typeof serverCartQuoteSchema>

export const serverCartSchema = z.object({
  cart_id: z.string().uuid(),
  /** Solo lo devuelve `cart_open`: es el secreto que identifica al invitado. */
  token: z.string().length(64).nullable().default(null),
  status: z.enum(['active', 'converted', 'abandoned', 'merged']),
  channel: z.string().min(1),
  currency: z.string().length(3),
  owned: z.boolean().default(false),
  expires_at: z.string().nullable().default(null),
  order_id: z.string().uuid().nullable().default(null),
  lines: z.array(serverCartLineSchema).default([]),
  quote: serverCartQuoteSchema.nullable().default(null),
  /** Código del motivo por el que no se pudo cotizar. Nunca un texto crudo. */
  quote_error: z.string().nullable().default(null),
})
export type ServerCart = z.infer<typeof serverCartSchema>

// ---------------------------------------------------------------------------
// Las tres llamadas
// ---------------------------------------------------------------------------

function client(authenticated: boolean) {
  return authenticated ? tryGetSupabaseClient() : tryGetStorefrontClient()
}

/**
 * Abre o recupera el carrito de quien llama.
 *
 * Presentar el token del invitado TENIENDO sesión es lo que dispara la fusión
 * en el servidor: es el único momento en el que fusionar significa algo.
 */
export async function openServerCart(input: {
  storeSlug: string
  token: string | null
  authenticated: boolean
}): Promise<ServerCart> {
  const supabase = client(input.authenticated)
  if (!supabase) throw new ServerCartError('CONFIG_INCOMPLETA')

  const { data, error } = await supabase.rpc(CART_OPEN_RPC, {
    p_store_slug: input.storeSlug,
    p_token: input.token,
  })
  if (error) throw serverCartError(error)
  return serverCartSchema.parse(data)
}

/**
 * Reemplaza las líneas. El servidor valida cada una contra el catálogo real
 * —publicada, del canal, con su variante— con los mismos códigos que el pedido,
 * así que un carrito que aquí pasa es un carrito que en la caja también pasa.
 */
export async function replaceServerCartLines(input: {
  storeSlug: string
  token: string
  cart: Cart
  authenticated: boolean
}): Promise<ServerCart> {
  const supabase = client(input.authenticated)
  if (!supabase) throw new ServerCartError('CONFIG_INCOMPLETA')

  const { data, error } = await supabase.rpc(CART_REPLACE_LINES_RPC, {
    p_store_slug: input.storeSlug,
    p_token: input.token,
    p_lines: input.cart.lines.map((line) => ({
      product_id: line.product_id,
      variant_id: line.variant_id,
      quantity: line.quantity,
    })),
  })
  if (error) throw serverCartError(error)
  return serverCartSchema.parse(data)
}

export async function abandonServerCart(input: {
  storeSlug: string
  token: string
  authenticated: boolean
}): Promise<void> {
  const supabase = client(input.authenticated)
  if (!supabase) return

  const { error } = await supabase.rpc(CART_ABANDON_RPC, {
    p_store_slug: input.storeSlug,
    p_token: input.token,
  })
  if (error) throw serverCartError(error)
}
