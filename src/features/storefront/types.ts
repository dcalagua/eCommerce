import { z } from 'zod'
import { AppError } from '@/domain/errors'
import { moneyText } from '@/shared/lib/money'

/**
 * Vitrina pública. Todo lo que hay aquí sale de las vistas
 * `public_*` de `20260827090500` + `20260827091200`: solo columnas publicables,
 * solo tienda activa, categoría activa y producto publicado.
 *
 * Nada de esto lleva `organization_id` ni `company_id`, y no por descuido: el
 * comprador anónimo no tiene por qué saber a qué cuenta del hub pertenece la
 * tienda que está mirando, y la vista tampoco se lo sirve.
 */

/**
 * Vistas del modelo de lectura público y buckets privados (la vitrina lee por
 * URL firmada, no por URL pública). Fuente única: `shared/lib/db-schema.ts`.
 */
export {
  PUBLIC_STORES_VIEW,
  PUBLIC_CATEGORIES_VIEW,
  PUBLIC_PRODUCTS_VIEW,
  PUBLIC_PRODUCT_IMAGES_VIEW,
  PRODUCT_IMAGES_BUCKET,
  STORE_ASSETS_BUCKET,
} from '@/shared/lib/db-schema'

/** Hex #RRGGBB o nada. Un valor raro se descarta y se cae al acento de suite. */
const hexColor = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/)
  .nullable()
  .catch(null)

/**
 * Referencia de branding: una URL `https://` externa (el "logo-auto" del
 * contrato §4.3) o una ruta del bucket privado `store-assets`
 * (`{organization_id}/{store_id}/branding/...`).
 *
 * Cualquier otra cosa se descarta y la vitrina cae al fallback neutral. El
 * filtro NO es cosmético: sin él, un `javascript:` o un `http://` guardado en
 * `logo_url` acabaría en el `src` de un `<img>` del dominio de la tienda.
 */
const ASSET_PATH_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/i

const assetRef = z
  .string()
  .refine((value) => /^https:\/\//i.test(value) || ASSET_PATH_RE.test(value))
  .nullable()
  .catch(null)

/**
 * Identidad de la tienda. TODO campo es opcional salvo el nombre y el slug: una
 * tienda recién creada no tiene logo ni banner y la vitrina tiene que verse
 * bien igual, con el fallback neutral de los tokens de suite.
 */
export const publicStoreSchema = z.object({
  store_id: z.string().uuid(),
  slug: z.string().min(1),
  name: z.string().min(1),
  currency: z.string().length(3),
  accent_color: hexColor,
  logo_url: assetRef,
  white_label: z.boolean().nullable().default(false),
  default_locale: z.string().nullable().default(null),
  support_email: z.string().nullable().default(null),
  banner_url: assetRef,
  hero_title: z.string().nullable().default(null),
  hero_subtitle: z.string().nullable().default(null),
  contact_phone: z.string().nullable().default(null),
  contact_address: z.string().nullable().default(null),
})
export type PublicStore = z.infer<typeof publicStoreSchema>

export const publicCategorySchema = z.object({
  category_id: z.string().uuid(),
  store_id: z.string().uuid(),
  slug: z.string().min(1),
  name: z.string().min(1),
  position: z.number().int(),
})
export type PublicCategory = z.infer<typeof publicCategorySchema>

/**
 * Producto del catálogo público.
 *
 * `in_stock` es un booleano derivado en la base (`stock > 0`), no la cantidad:
 * el comprador ve si puede comprar, no cuántas unidades quedan — eso es dato
 * de negocio del tenant y está fuera del GRANT de `anon`.
 */
export const publicProductSchema = z.object({
  product_id: z.string().uuid(),
  store_id: z.string().uuid(),
  category_id: z.string().uuid().nullable().default(null),
  slug: z.string().min(1),
  name: z.string().min(1),
  description: z.string().nullable().default(null),
  price: moneyText,
  compare_at_price: moneyText.nullable().default(null),
  currency: z.string().length(3),
  published_at: z.string().nullable().default(null),
  in_stock: z.boolean().nullable().default(false),
  category_slug: z.string().nullable().default(null),
  category_name: z.string().nullable().default(null),
  primary_image_path: z.string().nullable().default(null),
  primary_image_alt: z.string().nullable().default(null),
})
export type PublicProduct = z.infer<typeof publicProductSchema>

export const publicProductImageSchema = z.object({
  image_id: z.string().uuid(),
  product_id: z.string().uuid(),
  storage_path: z.string().min(1),
  alt: z.string().nullable().default(null),
  position: z.number().int(),
  is_primary: z.boolean().nullable().default(false),
})
export type PublicProductImage = z.infer<typeof publicProductImageSchema>

/** Imagen ya resuelta a algo que un `<img>` puede pintar. */
export interface GalleryImage extends PublicProductImage {
  url: string | null
}

/** Filtros del catálogo: uno de categoría y uno de disponibilidad. Nada más. */
export const AVAILABILITY_FILTERS = ['all', 'in-stock'] as const
export type AvailabilityFilter = (typeof AVAILABILITY_FILTERS)[number]

export const PRODUCT_SORTS = ['recent', 'price-asc', 'price-desc', 'name'] as const
export type ProductSort = (typeof PRODUCT_SORTS)[number]

export interface CatalogQuery {
  storeId: string | null
  search: string
  categorySlug: string | null
  availability: AvailabilityFilter
  sort: ProductSort
}

/** Descuento en % entero, o `null` si el precio tachado no es mayor que el real. */
export function discountPercent(product: PublicProduct): number | null {
  if (!product.compare_at_price) return null
  const before = Number(product.compare_at_price)
  const now = Number(product.price)
  if (!Number.isFinite(before) || !Number.isFinite(now) || before <= now || before <= 0) return null
  return Math.round(((before - now) / before) * 100)
}

/**
 * Relacionados «simples»: misma categoría, sin el propio producto, y si la
 * categoría no da para llenar la fila se completa con el resto del catálogo.
 * No hay motor de recomendación detrás y no se pretende que lo haya.
 */
export function pickRelated(
  all: PublicProduct[],
  current: PublicProduct,
  limit = 4,
): PublicProduct[] {
  const others = all.filter((item) => item.product_id !== current.product_id)
  const sameCategory = current.category_id
    ? others.filter((item) => item.category_id === current.category_id)
    : []
  const rest = others.filter((item) => !sameCategory.includes(item))
  return [...sameCategory, ...rest].slice(0, limit)
}

/**
 * Pedido tal y como lo ve el COMPRADOR con su token.
 *
 * No es el mismo objeto que devuelve el checkout: `order_by_token` recorta a
 * proposito lo que no necesita ver —el token, los ids de tenant, el id interno
 * del pedido— para que un enlace filtrado no sirva para pivotar a nada mas.
 */
export const trackedOrderSchema = z.object({
  order_number: z.string().min(1),
  status: z.string().min(1),
  currency: z.string().length(3),
  placed_at: z.string(),
  customer_name: z.string().nullable(),
  subtotal: z.string(),
  tax_total: z.string(),
  grand_total: z.string(),
  shipping_address: z.record(z.unknown()).default({}),
  items: z
    .array(
      z.object({
        sku: z.string(),
        name: z.string(),
        unit_price: z.string(),
        quantity: z.union([z.number(), z.string()]).transform((v) => Number(v)),
      }),
    )
    .default([]),
})
export type TrackedOrder = z.infer<typeof trackedOrderSchema>

/**
 * Un pedido no localizable. Deliberadamente SIN detalle: no se distingue si el
 * numero no existe o si el token es incorrecto, igual que hace la funcion.
 */
export class OrderNotFoundError extends AppError {
  constructor() {
    super({ boundary: 'orders', code: 'PEDIDO_NO_ENCONTRADO', message: 'ORDER_NOT_FOUND' })
    this.name = 'OrderNotFoundError'
  }
}
