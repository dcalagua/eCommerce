import { useQuery, type UseQueryResult } from '@tanstack/react-query'
import { useOutletContext } from 'react-router-dom'
import {
  fetchGallery,
  fetchPublicCategories,
  fetchPublicProduct,
  fetchPublicProducts,
  fetchPublicStore,
  fetchPublicVariants,
  signPaths,
} from './api'
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
