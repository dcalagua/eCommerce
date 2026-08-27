import { useQuery } from '@tanstack/react-query'
import { tryGetSupabaseClient } from '@/shared/lib/supabase'
import { ORDERS_TABLE, orderSchema, type Order, type OrderStatus } from './types'

const SELECT = 'id, organization_id, company_id, number, customer_name, status, total, currency, created_at'

export interface OrdersFilter {
  search: string
  /** Tabs de estado: complementan al buscador general, no lo reemplazan. */
  status: OrderStatus | 'all'
}

export async function fetchOrders({ search, status }: OrdersFilter): Promise<Order[]> {
  const supabase = tryGetSupabaseClient()
  if (!supabase) return []

  let query = supabase.from(ORDERS_TABLE).select(SELECT).order('created_at', { ascending: false })
  if (status !== 'all') query = query.eq('status', status)
  const term = search.trim()
  if (term) query = query.or(`number.ilike.%${term}%,customer_name.ilike.%${term}%`)

  const { data, error } = await query
  if (error) throw new Error(error.message)
  return orderSchema.array().parse(data ?? [])
}

export function useOrders(filter: OrdersFilter) {
  return useQuery<Order[]>({
    queryKey: ['orders', filter.search, filter.status],
    queryFn: () => fetchOrders(filter),
    placeholderData: (previous) => previous,
  })
}
