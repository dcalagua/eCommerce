import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  deleteCategory,
  fetchCategories,
  fetchCategoryUsage,
  saveCategory,
  setCategoryActive,
} from './api/categories'
import type { Category, CategoryFormValues, CategoryUsage } from './types'
import { CATALOG_KEY } from './useProducts'

export const categoriesKey = (storeId: string | null) =>
  [...CATALOG_KEY, 'categories', storeId] as const

export const categoryUsageKey = (categoryId: string | null) =>
  [...CATALOG_KEY, 'category-usage', categoryId] as const

export function useCategories(storeId: string | null) {
  return useQuery<Category[]>({
    queryKey: categoriesKey(storeId),
    queryFn: () => fetchCategories(storeId),
    enabled: Boolean(storeId),
    staleTime: 30_000,
  })
}

export function useCategoryUsage(categoryId: string | null) {
  return useQuery<CategoryUsage>({
    queryKey: categoryUsageKey(categoryId),
    queryFn: () => fetchCategoryUsage(categoryId as string),
    enabled: Boolean(categoryId),
    retry: false,
    gcTime: 0,
  })
}

function useInvalidateCategories() {
  const queryClient = useQueryClient()
  // Los productos muestran el nombre de su categoría: si cambia, la tabla de
  // productos también está desactualizada.
  return () => void queryClient.invalidateQueries({ queryKey: CATALOG_KEY })
}

export function useSaveCategory() {
  const invalidate = useInvalidateCategories()
  return useMutation({
    mutationFn: (input: {
      categoryId?: string | null
      organizationId: string
      companyId: string
      storeId: string
      values: CategoryFormValues
    }) => saveCategory(input),
    onSuccess: invalidate,
  })
}

export function useSetCategoryActive() {
  const invalidate = useInvalidateCategories()
  return useMutation({
    mutationFn: (input: { categoryId: string; isActive: boolean }) => setCategoryActive(input),
    onSuccess: invalidate,
  })
}

export function useDeleteCategory() {
  const invalidate = useInvalidateCategories()
  return useMutation({
    mutationFn: (categoryId: string) => deleteCategory(categoryId),
    onSuccess: invalidate,
  })
}
