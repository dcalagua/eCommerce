import type { SupabaseClient } from '@supabase/supabase-js'
import { sanitizeSearchTerm } from '@/shared/lib/search'
import { tryGetStorefrontClient } from '@/shared/lib/supabase'
import {
  PRODUCT_IMAGES_BUCKET,
  PUBLIC_CATEGORIES_VIEW,
  PUBLIC_PRODUCTS_VIEW,
  PUBLIC_PRODUCT_IMAGES_VIEW,
  PUBLIC_STORES_VIEW,
  publicCategorySchema,
  publicProductImageSchema,
  publicProductSchema,
  publicStoreSchema,
  type CatalogQuery,
  type GalleryImage,
  type PublicCategory,
  type PublicProduct,
  type PublicStore,
} from './types'

/**
 * Acceso a datos de la vitrina pública.
 *
 * Dos reglas gobiernan todo este archivo:
 *
 *  1. **El cliente es anónimo siempre** (`getStorefrontClient`), aunque el
 *     visitante tenga sesión de backoffice abierta. Las policies públicas son
 *     `to anon`; con el cliente autenticado la vitrina se vería vacía.
 *  2. **La tienda se resuelve por el slug de la URL contra `public_stores`**,
 *     que ya filtra `status = 'active'`. El `store_id` que se usa después sale
 *     de esa consulta, nunca de un parámetro que declare el cliente: quien
 *     escriba un uuid en la barra de direcciones no llega a ninguna parte.
 */

export class StorefrontNotConfiguredError extends Error {
  constructor() {
    super('El proyecto Supabase de eCommerce todavía no está conectado.')
    this.name = 'StorefrontNotConfiguredError'
  }
}

/** La tienda o el producto no existen, o existen pero no están publicados. */
export class StorefrontNotFoundError extends Error {
  constructor(what: string) {
    super(`No existe nada publicado para "${what}".`)
    this.name = 'StorefrontNotFoundError'
  }
}

function storefront(): SupabaseClient {
  const supabase = tryGetStorefrontClient()
  if (!supabase) throw new StorefrontNotConfiguredError()
  return supabase
}

const STORE_SELECT = [
  'store_id',
  'slug',
  'name',
  'currency',
  'accent_color',
  'logo_url',
  'white_label',
  'default_locale',
  'support_email',
  'banner_url',
  'hero_title',
  'hero_subtitle',
  'contact_phone',
  'contact_address',
].join(', ')

const CATEGORY_SELECT = 'category_id, store_id, slug, name, position'

/** `::text` en los importes: el céntimo no pasa por el float del navegador. */
const PRODUCT_SELECT = [
  'product_id',
  'store_id',
  'category_id',
  'slug',
  'name',
  'description',
  'price::text',
  'compare_at_price::text',
  'currency',
  'published_at',
  'in_stock',
  'category_slug',
  'category_name',
  'primary_image_path',
  'primary_image_alt',
].join(', ')

const IMAGE_SELECT = 'image_id, product_id, storage_path, alt, position, is_primary'

export async function fetchPublicStore(slug: string): Promise<PublicStore> {
  const { data, error } = await storefront()
    .from(PUBLIC_STORES_VIEW)
    .select(STORE_SELECT)
    .eq('slug', slug)
    .maybeSingle()

  if (error) throw new Error(error.message)
  if (!data) throw new StorefrontNotFoundError(slug)
  return publicStoreSchema.parse(data)
}

/** Solo categorías activas: la vista `public_categories` ya filtra `is_active`. */
export async function fetchPublicCategories(storeId: string | null): Promise<PublicCategory[]> {
  if (!storeId) return []

  const { data, error } = await storefront()
    .from(PUBLIC_CATEGORIES_VIEW)
    .select(CATEGORY_SELECT)
    .eq('store_id', storeId)
    .order('position')
    .order('name')

  if (error) throw new Error(error.message)
  return publicCategorySchema.array().parse(data ?? [])
}

/**
 * Catálogo con los filtros simples de la vitrina: buscador general, categoría y
 * disponibilidad. Nada de paneles multi-campo (regla de suite §8).
 *
 * El término se sanea antes de entrar en el `or=`: una coma o un paréntesis no
 * son "texto que no encuentra nada" en PostgREST, son sintaxis del filtro.
 */
export async function fetchPublicProducts(query: CatalogQuery): Promise<PublicProduct[]> {
  if (!query.storeId) return []

  let request = storefront()
    .from(PUBLIC_PRODUCTS_VIEW)
    .select(PRODUCT_SELECT)
    .eq('store_id', query.storeId)

  if (query.categorySlug) request = request.eq('category_slug', query.categorySlug)
  if (query.availability === 'in-stock') request = request.eq('in_stock', true)

  const term = sanitizeSearchTerm(query.search)
  if (term) {
    request = request.or(
      `name.ilike.%${term}%,description.ilike.%${term}%,category_name.ilike.%${term}%`,
    )
  }

  switch (query.sort) {
    case 'price-asc':
      request = request.order('price', { ascending: true })
      break
    case 'price-desc':
      request = request.order('price', { ascending: false })
      break
    case 'name':
      request = request.order('name', { ascending: true })
      break
    default:
      request = request.order('published_at', { ascending: false })
  }

  const { data, error } = await request
  if (error) throw new Error(error.message)
  return publicProductSchema.array().parse(data ?? [])
}

export async function fetchPublicProduct(input: {
  storeId: string | null
  slug: string
}): Promise<PublicProduct> {
  if (!input.storeId) throw new StorefrontNotFoundError(input.slug)

  const { data, error } = await storefront()
    .from(PUBLIC_PRODUCTS_VIEW)
    .select(PRODUCT_SELECT)
    .eq('store_id', input.storeId)
    .eq('slug', input.slug)
    .maybeSingle()

  if (error) throw new Error(error.message)
  if (!data) throw new StorefrontNotFoundError(input.slug)
  return publicProductSchema.parse(data)
}

/**
 * Galería de la ficha, ya resuelta a URLs pintables.
 *
 * El bucket es PRIVADO (decisión P02 #18): no hay URL pública ni para el dueño.
 * Se firman por una hora — de sobra para una visita — y quien autoriza la firma
 * es la policy `ebim_objects_select_public_product`, que solo deja pasar
 * objetos de producto publicado en tienda activa.
 */
export async function fetchGallery(productId: string | null): Promise<GalleryImage[]> {
  if (!productId) return []
  const supabase = storefront()

  const { data, error } = await supabase
    .from(PUBLIC_PRODUCT_IMAGES_VIEW)
    .select(IMAGE_SELECT)
    .eq('product_id', productId)
    .order('is_primary', { ascending: false })
    .order('position', { ascending: true })

  if (error) throw new Error(error.message)
  const images = publicProductImageSchema.array().parse(data ?? [])
  const urls = await signPaths(images.map((image) => image.storage_path))

  return images.map((image) => ({ ...image, url: urls[image.storage_path] ?? null }))
}

/**
 * Firma un lote de rutas. Una firma que falle no puede tumbar el catálogo
 * entero: el producto se sigue viendo con el marcador neutral en vez de la foto.
 */
export async function signPaths(paths: string[]): Promise<Record<string, string>> {
  const unique = [...new Set(paths.filter(Boolean))]
  if (unique.length === 0) return {}

  const { data, error } = await storefront()
    .storage.from(PRODUCT_IMAGES_BUCKET)
    .createSignedUrls(unique, 3600)

  if (error) return {}

  const map: Record<string, string> = {}
  for (const item of data ?? []) {
    if (item.path && item.signedUrl) map[item.path] = item.signedUrl
  }
  return map
}
