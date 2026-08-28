import { useQuery } from '@tanstack/react-query'
import { z } from 'zod'
import { AppError } from '@/domain/errors'
import { codeFromDbError } from '@/shared/lib/appError'
import { DASHBOARD_KPIS_RPC } from '@/shared/lib/db-schema'
import { tryGetSupabaseClient } from '@/shared/lib/supabase'

export { DASHBOARD_KPIS_RPC }

/**
 * `sales` llega como TEXTO y puede ser null. Las dos cosas son deliberadas:
 * un numeric en JSON se vuelve float en el navegador, y sin una moneda única
 * la base prefiere no dar cifra antes que sumar soles con dólares. Null aquí
 * significa "no hay un total que se pueda afirmar", no "cero".
 */
export const dashboardKpisSchema = z.object({
  products: z.number().int().nonnegative(),
  published: z.number().int().nonnegative(),
  orders: z.number().int().nonnegative(),
  sales: z.string().nullable(),
  currency: z.string().length(3).nullable(),
})

export type DashboardKpis = z.infer<typeof dashboardKpisSchema>

/**
 * KPIs del panel. La función es `SECURITY INVOKER`: cuenta exactamente lo que
 * la RLS deja ver a este usuario. No se pasa tenant — solo la tienda activa.
 */
export async function fetchDashboardKpis(storeId: string | null): Promise<DashboardKpis> {
  const supabase = tryGetSupabaseClient()
  if (!supabase) {
    throw new AppError({
      boundary: 'analytics',
      code: 'CONFIG_INCOMPLETA',
      message: 'El proyecto Supabase de eCommerce todavía no está configurado.',
    })
  }

  const { data, error } = await supabase.rpc(DASHBOARD_KPIS_RPC, { p_store_id: storeId })
  if (error) throw new AppError({ boundary: 'analytics', code: codeFromDbError(error) })
  return dashboardKpisSchema.parse(data)
}

export const dashboardKpisKey = (storeId: string | null) => ['dashboard-kpis', storeId] as const

export function useDashboardKpis(storeId: string | null) {
  return useQuery<DashboardKpis>({
    queryKey: dashboardKpisKey(storeId),
    queryFn: () => fetchDashboardKpis(storeId),
    enabled: Boolean(storeId),
    retry: false,
    staleTime: 30_000,
  })
}
