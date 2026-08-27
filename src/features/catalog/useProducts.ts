import { useQuery } from '@tanstack/react-query'
import { tryGetSupabaseClient } from '@/shared/lib/supabase'
import { PRODUCTS_TABLE, productSchema, type Product } from './types'

const SELECT = 'id, organization_id, company_id, sku, name, slug, status, price, currency, image_url'

/**
 * Productos del tenant. No se envía `organization_id`/`company_id` en la consulta:
 * el aislamiento lo garantiza RLS a partir del JWT (contrato, seguridad bloqueante).
 */
export async function fetchProducts(search: string): Promise<Product[]> {
  const supabase = tryGetSupabaseClient()
  if (!supabase) return []

  let query = supabase.from(PRODUCTS_TABLE).select(SELECT).order('name')
  const term = search.trim()
  if (term) query = query.or(`name.ilike.%${term}%,sku.ilike.%${term}%`)

  const { data, error } = await query
  if (error) throw new Error(error.message)
  return productSchema.array().parse(data ?? [])
}

export function useProducts(search: string) {
  return useQuery<Product[]>({
    queryKey: ['products', search],
    queryFn: () => fetchProducts(search),
    placeholderData: (previous) => previous,
  })
}
