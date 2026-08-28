import { useQuery, type UseQueryResult } from '@tanstack/react-query'
import { useOutletContext } from 'react-router-dom'
import type { SearchQuery, SearchResult, Suggestion } from '@/domain'
import {
  fetchGallery,
  fetchPublicCategories,
  fetchPublicProduct,
  fetchPublicProducts,
  fetchPublicStore,
  fetchPublicVariants,
  signPaths,
  signStoreAssetPaths,
} from './api'
import {
  contentAssetPaths,
  contentImagePaths,
  fetchStoreContent,
  fetchStoreNavigation,
  type StoreContent,
  type StoreNavigationItem,
} from './content'
import { createStorefrontSearch } from './search'
import type {
  CatalogQuery,
  GalleryImage,
  PublicCategory,
  PublicProduct,
  PublicStore,
  PublicVariant,
} from './types'

/**
 * Datos de la vitrina. Todo con `retry: false`: si la tienda no existe o el
 * producto no está publicado, reintentar cuatro veces solo retrasa el 404.
 */

export const storeKey = (slug: string) => ['storefront', 'store', slug] as const
export const categoriesKey = (storeId: string) => ['storefront', 'categories', storeId] as const
export const productsKey = (query: CatalogQuery) => ['storefront', 'products', query] as const
export const productKey = (storeId: string, slug: string) =>
  ['storefront', 'product', storeId, slug] as const
export const galleryKey = (productId: string) => ['storefront', 'gallery', productId] as const
export const variantsKey = (productId: string) => ['storefront', 'variants', productId] as const
export const thumbsKey = (paths: string[]) => ['storefront', 'thumbs', paths] as const

/** La marca cambia poco; el catálogo, algo más. De ahí los dos `staleTime`. */
const BRAND_STALE = 5 * 60 * 1000
const CATALOG_STALE = 60 * 1000

export function usePublicStore(slug: string | undefined): UseQueryResult<PublicStore> {
  return useQuery({
    queryKey: storeKey(slug ?? ''),
    queryFn: () => fetchPublicStore(slug as string),
    enabled: Boolean(slug),
    staleTime: BRAND_STALE,
    retry: false,
  })
}

export function usePublicCategories(storeId: string | null): UseQueryResult<PublicCategory[]> {
  return useQuery({
    queryKey: categoriesKey(storeId ?? ''),
    queryFn: () => fetchPublicCategories(storeId),
    enabled: Boolean(storeId),
    staleTime: CATALOG_STALE,
    retry: false,
  })
}

export function usePublicProducts(query: CatalogQuery): UseQueryResult<PublicProduct[]> {
  return useQuery({
    queryKey: productsKey(query),
    queryFn: () => fetchPublicProducts(query),
    enabled: Boolean(query.storeId),
    staleTime: CATALOG_STALE,
    retry: false,
  })
}

export function usePublicProduct(
  storeId: string | null,
  slug: string | undefined,
): UseQueryResult<PublicProduct> {
  return useQuery({
    queryKey: productKey(storeId ?? '', slug ?? ''),
    queryFn: () => fetchPublicProduct({ storeId, slug: slug as string }),
    enabled: Boolean(storeId && slug),
    staleTime: CATALOG_STALE,
    retry: false,
  })
}

/**
 * Variantes de la ficha. Solo se piden cuando el producto declara tenerlas: un
 * catálogo de productos simples no paga una consulta por ficha visitada.
 */
export function usePublicVariants(
  product: PublicProduct | undefined,
): UseQueryResult<PublicVariant[]> {
  const productId = product?.kind === 'variant' ? product.product_id : null
  return useQuery({
    queryKey: variantsKey(productId ?? ''),
    queryFn: () => fetchPublicVariants(productId),
    enabled: Boolean(productId),
    staleTime: CATALOG_STALE,
    retry: false,
  })
}

export function useGallery(productId: string | null): UseQueryResult<GalleryImage[]> {
  return useQuery({
    queryKey: galleryKey(productId ?? ''),
    queryFn: () => fetchGallery(productId),
    enabled: Boolean(productId),
    staleTime: CATALOG_STALE,
    retry: false,
  })
}

/**
 * Miniaturas del listado en UNA sola firma para todo el lote, en vez de una
 * petición por tarjeta. Si la firma falla, el mapa queda vacío y las tarjetas
 * caen al marcador neutral: una foto que no carga no puede dejar sin catálogo.
 */
export function useThumbnails(products: PublicProduct[]): Record<string, string> {
  return useSignedThumbnails(products.map((p) => p.primary_image_path))
}

/**
 * Firma un lote de rutas de imagen y devuelve el mapa `ruta -> URL`. Lo usan el
 * catálogo y el carrito: las rutas se deduplican y se ordenan para que la clave
 * de caché no cambie por el orden en que llegaron.
 */
export function useSignedThumbnails(paths: Array<string | null>): Record<string, string> {
  const unique = [...new Set(paths.filter((path): path is string => Boolean(path)))].sort()

  const { data } = useQuery({
    queryKey: thumbsKey(unique),
    queryFn: () => signPaths(unique),
    enabled: unique.length > 0,
    staleTime: 30 * 60 * 1000,
    retry: false,
  })

  return data ?? {}
}

/** Contexto que el layout de la vitrina pasa a sus pantallas. */
export interface StorefrontOutlet {
  storeSlug: string
  store: PublicStore
}

export function useStorefront(): StorefrontOutlet {
  return useOutletContext<StorefrontOutlet>()
}

// ---------------------------------------------------------------------------
// Contenido administrable y búsqueda (P11-SaaS)
// ---------------------------------------------------------------------------

export const contentKey = (storeSlug: string, pageSlug: string | null) =>
  ['storefront', 'content', storeSlug, pageSlug ?? 'home'] as const
export const navigationKey = (storeSlug: string) =>
  ['storefront', 'navigation', storeSlug] as const
export const searchKey = (storeSlug: string, query: SearchQuery) =>
  ['storefront', 'search', storeSlug, query.term, query.filters, query.sort, query.offset] as const
export const suggestKey = (storeSlug: string, term: string) =>
  ['storefront', 'suggest', storeSlug, term] as const

/**
 * Contenido de una página. `pageSlug` nulo = portada.
 *
 * `retry: false` como el resto de la vitrina, y `staleTime` de marca: el
 * contenido cambia cuando el comercio lo cambia, no cada minuto. Un `cms:false`
 * —la sociedad no tiene el módulo— es una respuesta VÁLIDA y se cachea igual:
 * reintentarla no la convierte en otra cosa.
 */
export function useStoreContent(
  storeSlug: string | undefined,
  pageSlug: string | null = null,
): UseQueryResult<StoreContent> {
  return useQuery({
    queryKey: contentKey(storeSlug ?? '', pageSlug),
    queryFn: () => fetchStoreContent({ storeSlug: storeSlug as string, pageSlug }),
    enabled: Boolean(storeSlug),
    staleTime: BRAND_STALE,
    retry: false,
  })
}

export function useStoreNavigation(storeSlug: string | undefined): UseQueryResult<StoreNavigationItem[]> {
  return useQuery({
    queryKey: navigationKey(storeSlug ?? ''),
    queryFn: () => fetchStoreNavigation(storeSlug as string),
    enabled: Boolean(storeSlug),
    staleTime: BRAND_STALE,
    retry: false,
  })
}

/**
 * Firma las imágenes que el contenido necesita: las del bucket de branding
 * (hero, banner) y las del bucket de producto (colecciones).
 *
 * Dos lotes y no uno porque son dos buckets con dos policies. Una firma que
 * falle deja el hueco neutral en vez de tumbar la portada.
 */
export function useContentAssets(content: StoreContent | undefined): {
  assets: Record<string, string>
  images: Record<string, string>
} {
  const assetPaths = content ? contentAssetPaths(content) : []
  const imagePaths = content ? contentImagePaths(content) : []
  const uniqueAssets = [...new Set(assetPaths)].sort()

  const { data: assets } = useQuery({
    queryKey: ['storefront', 'content-assets', uniqueAssets] as const,
    queryFn: () => signStoreAssetPaths(uniqueAssets),
    enabled: uniqueAssets.length > 0,
    staleTime: 30 * 60 * 1000,
    retry: false,
  })

  return { assets: assets ?? {}, images: useSignedThumbnails(imagePaths) }
}

/**
 * Búsqueda del catálogo con rebote y CANCELACIÓN.
 *
 * La cancelación no es una optimización: sin ella, la respuesta de una consulta
 * anterior puede llegar después de la actual y pintar resultados que ya no
 * corresponden a lo que hay escrito en la caja. React Query pasa su `signal` al
 * puerto y el adaptador se lo da al SDK.
 *
 * `placeholderData` mantiene la página anterior mientras llega la nueva: sin
 * ella, cada tecla vacía la rejilla y la pantalla parpadea.
 */
export function useCatalogSearch(
  storeSlug: string | undefined,
  query: SearchQuery,
  enabled = true,
): UseQueryResult<SearchResult> {
  return useQuery({
    queryKey: searchKey(storeSlug ?? '', query),
    queryFn: ({ signal }) =>
      createStorefrontSearch(storeSlug as string).search({ ...query, signal }),
    enabled: Boolean(storeSlug) && enabled,
    staleTime: CATALOG_STALE,
    placeholderData: (previous) => previous,
    retry: false,
  })
}

/** Autocompletado. Solo a partir de dos caracteres: con uno, sugiere el catálogo entero. */
export function useCatalogSuggestions(
  storeSlug: string | undefined,
  term: string,
): UseQueryResult<readonly Suggestion[]> {
  const clean = term.trim()
  return useQuery({
    queryKey: suggestKey(storeSlug ?? '', clean),
    queryFn: ({ signal }) =>
      createStorefrontSearch(storeSlug as string).suggest(clean, { signal }),
    enabled: Boolean(storeSlug) && clean.length >= 2,
    staleTime: CATALOG_STALE,
    retry: false,
  })
}
