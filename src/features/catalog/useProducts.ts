import { useQuery } from '@tanstack/react-query'
import { tryGetSupabaseClient } from '@/shared/lib/supabase'
import { PRODUCTS_TABLE, productSchema, type Product } from './types'

const SELECT = 'id, organization_id, company_id, store_id, sku, name, slug, status, price, currency, stock'

/**
 * Productos de la tienda activa. No se envía `organization_id`/`company_id` en
 * la consulta: el aislamiento lo garantiza RLS a partir del JWT (contrato,
 * seguridad bloqueante). `store_id` sí se filtra, pero es alcance de pantalla,
 * no seguridad: una tienda ajena tampoco devolvería filas.
 */
export async function fetchProducts(search: string, storeId: string | null): Promise<Product[]> {
  const supabase = tryGetSupabaseClient()
  if (!supabase || !storeId) return []

  let query = supabase.from(PRODUCTS_TABLE).select(SELECT).eq('store_id', storeId).order('name')
  const term = search.trim()
  if (term) query = query.or(`name.ilike.%${term}%,sku.ilike.%${term}%`)

  const { data, error } = await query
  if (error) throw new Error(error.message)
  return productSchema.array().parse(data ?? [])
}

export function useProducts(search: string, storeId: string | null) {
  return useQuery<Product[]>({
    queryKey: ['products', storeId, search],
    queryFn: () => fetchProducts(search, storeId),
    placeholderData: (previous) => previous,
  })
}
