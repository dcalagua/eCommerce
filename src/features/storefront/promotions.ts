import { z } from 'zod'
import { STORE_PROMOTIONS_PUBLIC_RPC } from '@/shared/lib/db-schema'
import { storefrontClient } from './api'

/**
 * Las campañas vigentes de la tienda, como DATO.
 *
 * Antes una oferta solo se veía si alguien le escribía un bloque de contenido a
 * mano; con siete campañas activas y un bloque publicado, seis descontaban en
 * el carrito sin haberse anunciado en ningún sitio. Esto lo lee del motor de
 * promociones: si está descontando, sale; si caduca, deja de salir sin que
 * nadie tenga que acordarse de borrar el cartel.
 *
 * Lo que no llega —porque el servidor no lo manda— es el código del cupón ni el
 * cupo de usos. Y las campañas que EXIGEN cupón no salen: anunciar un descuento
 * que no se aplica solo se paga en el carrito.
 */
const promotionSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1),
  description: z.string().nullable().default(null),
  kind: z.string().nullable().default(null),
  // Los importes viajan como `numeric` de Postgres: PostgREST los serializa
  // como número o como texto según el driver, y `coerce` acepta las dos formas.
  percent_off: z.coerce.number().nullable().default(null),
  amount_off: z.coerce.number().nullable().default(null),
  buy_quantity: z.coerce.number().nullable().default(null),
  free_quantity: z.coerce.number().nullable().default(null),
  min_subtotal: z.coerce.number().nullable().default(null),
  ends_at: z.string().nullable().default(null),
  priority: z.coerce.number().nullable().default(0),
  category_slug: z.string().nullable().default(null),
  brand_code: z.string().nullable().default(null),
})

const responseSchema = z.object({
  store_id: z.string().uuid().nullable().default(null),
  promotions: z.array(promotionSchema).default([]),
})

export interface StorePromotion {
  readonly id: string
  readonly name: string
  readonly description: string | null
  readonly kind: string | null
  readonly percentOff: number | null
  readonly amountOff: number | null
  readonly buyQuantity: number | null
  readonly freeQuantity: number | null
  readonly minSubtotal: number | null
  readonly endsAt: string | null
  /** A dónde lleva el botón: la categoría o la marca a la que alcanza. */
  readonly categorySlug: string | null
  readonly brandCode: string | null
}

export const promotionsKey = (storeSlug: string) =>
  ['storefront', 'promotions', storeSlug] as const

/**
 * Campañas vigentes de una tienda.
 *
 * Devuelve lista vacía ante cualquier fallo, igual que el menú del CMS: un
 * carrusel de ofertas que no carga no puede tumbar la tienda. Y esa tolerancia
 * no es teórica — mientras la función de base no esté desplegada, esto es
 * exactamente lo que pasa, y la portada tiene que seguir vendiendo.
 */
export async function fetchStorePromotions(
  storeSlug: string,
  limit = 8,
): Promise<StorePromotion[]> {
  const { data, error } = await storefrontClient().rpc(STORE_PROMOTIONS_PUBLIC_RPC, {
    p_store_slug: storeSlug,
    p_limit: limit,
  })

  if (error) return []

  const parsed = responseSchema.safeParse(data ?? {})
  if (!parsed.success) return []

  return parsed.data.promotions.map((promotion) => ({
    id: promotion.id,
    name: promotion.name,
    description: promotion.description,
    kind: promotion.kind,
    percentOff: promotion.percent_off,
    amountOff: promotion.amount_off,
    buyQuantity: promotion.buy_quantity,
    freeQuantity: promotion.free_quantity,
    minSubtotal: promotion.min_subtotal,
    endsAt: promotion.ends_at,
    categorySlug: promotion.category_slug,
    brandCode: promotion.brand_code,
  }))
}
