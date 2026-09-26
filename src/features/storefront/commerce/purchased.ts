import { useQuery } from '@tanstack/react-query'
import { useMemo } from 'react'
import { z } from 'zod'
import { useSessionContext } from '@/features/auth/session-context'
import { MY_PURCHASED_PRODUCTS_RPC } from '@/shared/lib/db-schema'
import { tryGetSupabaseClient } from '@/shared/lib/supabase'
import { useCommerceContext } from './context'

const VACIO: ReadonlySet<string> = new Set()

const rowsSchema = z.array(z.object({ product_id: z.string().uuid() }))

export const purchasedProductsKey = (storeSlug: string) =>
  ['storefront', 'purchased-products', storeSlug] as const

/**
 * Los productos que la cuenta de empresa del comprador YA pidió en esta tienda
 * (Resumen v2 · «Ya comprado»).
 *
 * Quien repone compra casi siempre lo mismo: marcarlo en la rejilla le ahorra
 * buscar en sus pedidos. UNA consulta para toda la rejilla, y solo con una
 * cuenta de empresa activa: el consumidor y el invitado no pagan la llamada.
 *
 * La cuenta la resuelve el servidor con el token. Si la consulta falla, el
 * conjunto queda vacío: una marca que falta no puede costar una venta.
 */
export function usePurchasedProducts(storeSlug: string): ReadonlySet<string> {
  const { status } = useSessionContext()
  const { audience, context } = useCommerceContext(storeSlug, status === 'authenticated')
  const enabled = audience !== 'consumer' && context !== null
  const query = useQuery({
    queryKey: purchasedProductsKey(storeSlug),
    queryFn: async () => {
      const supabase = tryGetSupabaseClient()
      if (!supabase) return []
      const { data, error } = await supabase.rpc(MY_PURCHASED_PRODUCTS_RPC, { p_store_slug: storeSlug })
      if (error) throw error
      return rowsSchema.parse(data ?? []).map((row) => row.product_id)
    },
    enabled,
    retry: false,
    staleTime: 5 * 60_000,
  })
  return useMemo(() => (enabled && query.data ? new Set(query.data) : VACIO), [enabled, query.data])
}
