import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  deleteProductImage,
  fetchProductImages,
  reorderProductImages,
  setPrimaryImage,
  signedImageUrls,
  uploadProductImage,
} from './api/images'
import type { ProductImage } from './types'
import { CATALOG_KEY } from './useProducts'

export const productImagesKey = (productId: string | null) =>
  [...CATALOG_KEY, 'product-images', productId] as const

export const imageUrlsKey = (paths: string[]) =>
  [...CATALOG_KEY, 'image-urls', paths.join('|')] as const

export function useProductImages(productId: string | null) {
  return useQuery<ProductImage[]>({
    queryKey: productImagesKey(productId),
    queryFn: () => fetchProductImages(productId),
    enabled: Boolean(productId),
  })
}

/**
 * URLs firmadas de las miniaturas. El bucket es privado, así que sin esto no
 * hay nada que enseñar. Se refrescan cada media hora — la firma dura una.
 */
export function useSignedImageUrls(paths: string[]) {
  return useQuery<Record<string, string>>({
    queryKey: imageUrlsKey(paths),
    queryFn: () => signedImageUrls(paths),
    enabled: paths.length > 0,
    staleTime: 30 * 60_000,
  })
}

function useInvalidateImages(productId: string | null) {
  const queryClient = useQueryClient()
  return () => {
    void queryClient.invalidateQueries({ queryKey: productImagesKey(productId) })
    void queryClient.invalidateQueries({ queryKey: CATALOG_KEY })
  }
}

export function useUploadProductImage(productId: string | null) {
  const invalidate = useInvalidateImages(productId)
  return useMutation({
    mutationFn: (input: {
      organizationId: string
      companyId: string
      storeId: string
      productId: string
      file: File
      position: number
    }) => uploadProductImage(input),
    onSuccess: invalidate,
  })
}

export function useDeleteProductImage(productId: string | null) {
  const invalidate = useInvalidateImages(productId)
  return useMutation({
    mutationFn: (image: ProductImage) => deleteProductImage(image),
    onSuccess: invalidate,
  })
}

export function useSetPrimaryImage(productId: string | null) {
  const invalidate = useInvalidateImages(productId)
  return useMutation({
    mutationFn: (imageId: string) => setPrimaryImage(imageId),
    onSuccess: invalidate,
  })
}

export function useReorderProductImages(productId: string | null) {
  const invalidate = useInvalidateImages(productId)
  return useMutation({
    mutationFn: (input: { productId: string; imageIds: string[] }) => reorderProductImages(input),
    onSuccess: invalidate,
  })
}
