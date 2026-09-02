import { z } from 'zod'
import { moneyText } from '@/shared/lib/money'
import type { PublicProduct, PublicVariant } from '../types'

/**
 * Carrito del comprador anónimo.
 *
 * Tres reglas gobiernan este archivo:
 *
 *  1. **El precio que se guarda aquí es de ESCAPARATE, no de cobro.** Sirve
 *     para pintar la línea mientras el comprador decide; el pedido lo valora la
 *     base en `create_order`. Si alguien edita `localStorage` y se pone la silla
 *     a un sol, verá un sol en su pantalla y pagará el precio real: al servidor
 *     solo viajan `product_id` y `quantity`.
 *  2. **Un carrito pertenece a UNA tienda.** La clave de `localStorage` lleva el
 *     `store_id`, el propio carrito lo repite dentro, y añadir un producto de
 *     otra tienda es un error explícito. Nada de mezclar catálogos de dos
 *     negocios en el mismo pedido.
 *  3. **Todo lo que entra por `localStorage` se valida.** Es almacenamiento del
 *     cliente: lo que sale de ahí es una entrada más, no un dato de confianza.
 */

const STORAGE_PREFIX = 'ebim.ecommerce.cart.v1'

/** Tope por línea en la vitrina. La base admite más; el comprador no necesita. */
export const MAX_LINE_QUANTITY = 99

export const cartLineSchema = z.object({
  product_id: z.string().uuid(),
  /**
   * Variante elegida (P03-SaaS). `null` para el producto simple y para el kit,
   * que se venden ellos mismos. Es parte de la IDENTIDAD de la línea: "camiseta
   * roja" y "camiseta azul" son dos líneas del mismo producto.
   */
  variant_id: z.string().uuid().nullable().default(null),
  variant_name: z.string().nullable().default(null),
  slug: z.string().min(1),
  name: z.string().min(1),
  /** Decimal como texto: el céntimo no pasa por el float del navegador. */
  unit_price: moneyText,
  currency: z.string().length(3),
  image_path: z.string().nullable().default(null),
  quantity: z.number().int().min(1).max(MAX_LINE_QUANTITY),
})
export type CartLine = z.infer<typeof cartLineSchema>

/**
 * Identidad de una línea: producto MÁS variante.
 *
 * Antes del PIM bastaba el `product_id` y las funciones del carrito lo usaban
 * como clave. Con variantes eso agruparía la talla M con la L en una sola línea
 * y el comprador recibiría la que no era. Se saca a una función para que las
 * cuatro operaciones del carrito compartan exactamente la misma definición.
 */
export function lineKey(line: Pick<CartLine, 'product_id' | 'variant_id'>): string {
  return `${line.product_id}|${line.variant_id ?? ''}`
}

export const cartSchema = z.object({
  store_id: z.string().uuid(),
  lines: z.array(cartLineSchema),
})
export type Cart = z.infer<typeof cartSchema>

/** Se intentó meter en el carrito de una tienda algo de otra. */
export class CartStoreMismatchError extends Error {
  constructor() {
    super('Ese producto es de otra tienda: no se puede mezclar en el mismo carrito.')
    this.name = 'CartStoreMismatchError'
  }
}

/**
 * Se intentó añadir una variante que no es de ese producto. No debería ocurrir
 * —la ficha solo ofrece las suyas—, y por eso si ocurre hay que verlo: el
 * servidor lo rechazaría igualmente con `VARIANTE_NO_DISPONIBLE`, pero mucho
 * más tarde y sin decir dónde se cruzaron los datos.
 */
export class CartVariantMismatchError extends Error {
  constructor() {
    super('Esa variante no pertenece a ese producto.')
    this.name = 'CartVariantMismatchError'
  }
}

export function cartStorageKey(storeId: string): string {
  return `${STORAGE_PREFIX}:${storeId}`
}

export function emptyCart(storeId: string): Cart {
  return { store_id: storeId, lines: [] }
}

/**
 * Reconstruye el carrito guardado. Cualquier desvío —JSON roto, línea sin
 * uuid, cantidad negativa, o un carrito de OTRA tienda bajo esta clave— se
 * descarta y se empieza de cero. Es preferible perder un carrito dudoso a
 * arrastrar líneas que la vitrina no sabe explicar.
 */
export function parseCart(storeId: string, raw: string | null): Cart {
  if (!raw) return emptyCart(storeId)

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return emptyCart(storeId)
  }

  const result = cartSchema.safeParse(parsed)
  if (!result.success) return emptyCart(storeId)
  if (result.data.store_id !== storeId) return emptyCart(storeId)

  return result.data
}

/** `localStorage` puede no existir (SSR) o lanzar (Safari privado). */
function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage
  } catch {
    return null
  }
}

export function readCart(storeId: string): Cart {
  const store = storage()
  if (!store) return emptyCart(storeId)
  try {
    return parseCart(storeId, store.getItem(cartStorageKey(storeId)))
  } catch {
    return emptyCart(storeId)
  }
}

export function writeCart(cart: Cart): void {
  const store = storage()
  if (!store) return
  try {
    if (cart.lines.length === 0) {
      store.removeItem(cartStorageKey(cart.store_id))
      return
    }
    store.setItem(cartStorageKey(cart.store_id), JSON.stringify(cart))
  } catch {
    /* cuota llena o almacenamiento bloqueado: el carrito vive en memoria */
  }
}

export function clearStoredCart(storeId: string): void {
  const store = storage()
  if (!store) return
  try {
    store.removeItem(cartStorageKey(storeId))
  } catch {
    /* nada que hacer: el estado en memoria ya se vació */
  }
}

function clampQuantity(quantity: number): number {
  if (!Number.isFinite(quantity)) return 1
  return Math.min(MAX_LINE_QUANTITY, Math.max(1, Math.trunc(quantity)))
}

/**
 * Línea nueva a partir del producto publicado y —si la hay— de la variante
 * elegida. Sin totales: se derivan.
 *
 * El precio sale de la VARIANTE cuando hay variante. La vista pública ya
 * resolvió la herencia, así que aquí no se decide nada de precio; y de todas
 * formas es precio de escaparate: quien cobra es `create_order`.
 */
function lineFrom(product: PublicProduct, variant: PublicVariant | null, quantity: number): CartLine {
  return {
    product_id: product.product_id,
    variant_id: variant?.variant_id ?? null,
    variant_name: variant?.name ?? null,
    slug: product.slug,
    name: product.name,
    unit_price: variant?.price ?? product.price,
    currency: variant?.currency ?? product.currency,
    image_path: product.primary_image_path,
    quantity: clampQuantity(quantity),
  }
}

/**
 * Añade unidades. Si esa misma combinación producto+variante ya estaba, SUMA en
 * vez de duplicar la línea: dos veces "1 silla" es "2 sillas", que es lo que
 * espera cualquiera. Dos variantes distintas del mismo producto siguen siendo
 * dos líneas, que también es lo que espera cualquiera.
 *
 * Un producto de otra tienda no entra: lanza `CartStoreMismatchError`. La
 * vitrina no debería llegar a ese caso (cada tienda tiene su carrito), y
 * justamente por eso, si llega, es que algo está mal y hay que verlo.
 */
export function addToCart(
  cart: Cart,
  product: PublicProduct,
  quantity = 1,
  variant: PublicVariant | null = null,
): Cart {
  if (product.store_id !== cart.store_id) throw new CartStoreMismatchError()
  if (variant && variant.product_id !== product.product_id) throw new CartVariantMismatchError()

  const next = lineFrom(product, variant, quantity)
  const key = lineKey(next)
  const existing = cart.lines.find((line) => lineKey(line) === key)

  if (!existing) {
    return { ...cart, lines: [...cart.lines, next] }
  }

  return {
    ...cart,
    lines: cart.lines.map((line) =>
      lineKey(line) === key
        ? // El precio se refresca al del catálogo: si cambió mientras el
          // carrito dormía, el comprador ve el vigente y no el de ayer.
          lineFrom(product, variant, line.quantity + quantity)
        : line,
    ),
  }
}

/** Cantidad exacta. Cero o menos quita la línea: es lo que significa. */
export function setLineQuantity(
  cart: Cart,
  productId: string,
  quantity: number,
  variantId: string | null = null,
): Cart {
  if (!Number.isFinite(quantity) || Math.trunc(quantity) <= 0) {
    return removeFromCart(cart, productId, variantId)
  }
  const key = lineKey({ product_id: productId, variant_id: variantId })
  return {
    ...cart,
    lines: cart.lines.map((line) =>
      lineKey(line) === key ? { ...line, quantity: clampQuantity(quantity) } : line,
    ),
  }
}

export function removeFromCart(
  cart: Cart,
  productId: string,
  variantId: string | null = null,
): Cart {
  const key = lineKey({ product_id: productId, variant_id: variantId })
  return { ...cart, lines: cart.lines.filter((line) => lineKey(line) !== key) }
}

export function cartCount(cart: Cart): number {
  return cart.lines.reduce((total, line) => total + line.quantity, 0)
}

/** Céntimos enteros: sumar `0.1 + 0.2` en float es exactamente el bug a evitar. */
function toCents(amount: string): number {
  const value = Number(amount)
  return Number.isFinite(value) ? Math.round(value * 100) : 0
}

export function lineTotalCents(line: CartLine): number {
  return toCents(line.unit_price) * line.quantity
}

/** Subtotal informativo del carrito, como texto decimal con dos decimales. */
export function cartSubtotal(cart: Cart): string {
  const cents = cart.lines.reduce((total, line) => total + lineTotalCents(line), 0)
  return (cents / 100).toFixed(2)
}

/** Moneda del carrito: la de sus líneas, que es la de la tienda. */
export function cartCurrency(cart: Cart, fallback: string): string {
  return cart.lines[0]?.currency ?? fallback
}

/**
 * Lo ÚNICO que viaja al servidor. Ni precio, ni moneda, ni total, ni tienda, ni
 * factor de conversión: el importe lo pone la base y la tienda sale del slug de
 * la URL. `variant_id` sí viaja porque es QUÉ se compra, no cuánto cuesta —y el
 * servidor comprueba que esa variante es de ese producto y está activa.
 */
export function toOrderItems(
  cart: Cart,
): Array<{ product_id: string; quantity: number; variant_id?: string }> {
  return cart.lines.map((line) =>
    line.variant_id
      ? { product_id: line.product_id, quantity: line.quantity, variant_id: line.variant_id }
      : { product_id: line.product_id, quantity: line.quantity },
  )
}

/**
 * Lo que devuelve el carrito del servidor, visto desde aquí.
 *
 * Se declara de forma estructural y no importando el tipo de `serverCart.ts`
 * para que este archivo siga sin depender de la capa de datos: `cart.ts` es
 * lógica pura y sus tests no levantan nada.
 */
export interface ServerLine {
  product_id: string
  variant_id: string | null
  quantity: number
  slug: string
  name: string
  unit_price: string | null
  unit_price_snapshot: string | null
  /** P18 · Ruta de la foto principal en el bucket. `null` si el producto no tiene. */
  image_path?: string | null
}

/**
 * Aplica al carrito local lo que dice el servidor DESPUÉS de una fusión.
 *
 * El servidor manda en QUÉ hay y CUÁNTO —es él quien fusionó, quien conoce el
 * carrito del otro dispositivo y quien validó contra el catálogo—; lo local que
 * se conserva es solo presentación: la miniatura que ya estaba descargada y la
 * moneda. Si una línea del servidor no estaba en local, entra con lo que el
 * servidor sabe de ella, y su imagen se resolverá en el siguiente render.
 *
 * El precio que se guarda es el VIGENTE del servidor (`unit_price`) y no el
 * snapshot: el snapshot es lo que valía cuando se guardó, y pintar eso sería
 * enseñar un precio viejo al lado de un botón de comprar. Si el servidor no
 * pudo cotizar, se conserva el que hubiera en local — que es de escaparate y
 * está declarado como tal desde el principio de este archivo.
 *
 * **Presentaciones (UoM).** Hoy la vitrina no vende por presentación: no hay
 * selector y ninguna línea sale de aquí con `uom_code`. El modelo del servidor
 * sí la admite porque comparte la terna con `create_order`. El día que la
 * vitrina venda cajas, esta función es donde se añade — y hasta entonces no se
 * inventa un campo que ninguna pantalla puede producir ni mostrar.
 */
export function applyServerLines(cart: Cart, lines: readonly ServerLine[], fallbackCurrency: string): Cart {
  const locals = new Map(cart.lines.map((line) => [lineKey(line), line]))

  return {
    ...cart,
    lines: lines.map((line): CartLine => {
      const key = lineKey({ product_id: line.product_id, variant_id: line.variant_id })
      const local = locals.get(key)
      return {
        product_id: line.product_id,
        variant_id: line.variant_id,
        variant_name: local?.variant_name ?? null,
        slug: line.slug,
        name: line.name,
        unit_price: line.unit_price ?? local?.unit_price ?? '0.00',
        currency: local?.currency ?? fallbackCurrency,
        // Manda la del SERVIDOR. Antes solo estaba la copia local, y con sesión
        // iniciada esa copia no existe —el carrito del servidor se impone
        // entero—, así que el cajón se llenaba de cuadros grises con los
        // productos bien puestos.
        image_path: line.image_path ?? local?.image_path ?? null,
        quantity: clampQuantity(line.quantity),
      }
    }),
  }
}
