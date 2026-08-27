import { useQuery, type UseQueryResult } from '@tanstack/react-query'
import { useOutletContext } from 'react-router-dom'
import {
  fetchGallery,
  fetchPublicCategories,
  fetchPublicProduct,
  fetchPublicProducts,
  fetchPublicStore,
  signPaths,
} from './api'
import type {
  CatalogQuery,
  GalleryImage,
  PublicCategory,
  PublicProduct,
  PublicStore,
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
  const paths = [
    ...new Set(products.map((p) => p.primary_image_path).filter((p): p is string => Boolean(p))),
  ].sort()

  const { data } = useQuery({
    queryKey: thumbsKey(paths),
    queryFn: () => signPaths(paths),
    enabled: paths.length > 0,
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
