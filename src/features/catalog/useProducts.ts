import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  deleteProduct,
  fetchProductUsage,
  fetchProducts,
  saveProduct,
  setProductStatus,
  type ProductQuery,
  type ProductStatusFilter,
} from './api/products'
import type { Product, ProductFormValues, ProductStatus, ProductUsage } from './types'

export const CATALOG_KEY = ['catalog'] as const

export const productsKey = (storeId: string | null, status: ProductStatusFilter, search: string) =>
  [...CATALOG_KEY, 'products', storeId, status, search] as const

export const productUsageKey = (productId: string | null) =>
  [...CATALOG_KEY, 'product-usage', productId] as const

export function useProducts(query: ProductQuery) {
  return useQuery<Product[]>({
    queryKey: productsKey(query.storeId, query.status, query.search),
    queryFn: () => fetchProducts(query),
    enabled: Boolean(query.storeId),
    // Mantener la tabla anterior mientras se teclea evita el parpadeo a
    // esqueleto en cada letra del buscador.
    placeholderData: (previous) => previous,
  })
}

/** Uso real del producto, para el diálogo de eliminación segura (contrato §4.2). */
export function useProductUsage(productId: string | null) {
  return useQuery<ProductUsage>({
    queryKey: productUsageKey(productId),
    queryFn: () => fetchProductUsage(productId as string),
    enabled: Boolean(productId),
    retry: false,
    gcTime: 0,
  })
}

/** Invalida TODO el catálogo: el panel de inicio también cuenta productos. */
function useInvalidateCatalog() {
  const queryClient = useQueryClient()
  return () => {
    void queryClient.invalidateQueries({ queryKey: CATALOG_KEY })
    void queryClient.invalidateQueries({ queryKey: ['dashboard-kpis'] })
  }
}

export function useSaveProduct() {
  const invalidate = useInvalidateCatalog()
  return useMutation({
    mutationFn: (input: { productId?: string | null; storeId: string; values: ProductFormValues }) =>
      saveProduct(input),
    onSuccess: invalidate,
  })
}

export function useSetProductStatus() {
  const invalidate = useInvalidateCatalog()
  return useMutation({
    mutationFn: (input: { productId: string; status: ProductStatus }) => setProductStatus(input),
    onSuccess: invalidate,
  })
}

export function useDeleteProduct() {
  const invalidate = useInvalidateCatalog()
  return useMutation({
    mutationFn: (productId: string) => deleteProduct(productId),
    onSuccess: invalidate,
  })
}
