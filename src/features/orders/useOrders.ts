import { useQuery } from '@tanstack/react-query'
import { tryGetSupabaseClient } from '@/shared/lib/supabase'
import { ORDERS_TABLE, orderSchema, type Order, type OrderStatus } from './types'

const SELECT =
  'id, organization_id, company_id, store_id, order_number, customer_name, customer_email, status, grand_total, currency, placed_at'

export interface OrdersFilter {
  search: string
  /** Tabs de estado: complementan al buscador general, no lo reemplazan. */
  status: OrderStatus | 'all'
  storeId: string | null
}

export async function fetchOrders({ search, status, storeId }: OrdersFilter): Promise<Order[]> {
  const supabase = tryGetSupabaseClient()
  if (!supabase || !storeId) return []

  let query = supabase
    .from(ORDERS_TABLE)
    .select(SELECT)
    .eq('store_id', storeId)
    .order('placed_at', { ascending: false })
  if (status !== 'all') query = query.eq('status', status)
  const term = search.trim()
  if (term) query = query.or(`order_number.ilike.%${term}%,customer_name.ilike.%${term}%`)

  const { data, error } = await query
  if (error) throw new Error(error.message)
  return orderSchema.array().parse(data ?? [])
}

export function useOrders(filter: OrdersFilter) {
  return useQuery<Order[]>({
    queryKey: ['orders', filter.storeId, filter.search, filter.status],
    queryFn: () => fetchOrders(filter),
    placeholderData: (previous) => previous,
  })
}
