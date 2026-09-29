import { useQuery } from '@tanstack/react-query'
import { z } from 'zod'
import { AppError } from '@/domain/errors'
import { codeFromDbError } from '@/shared/lib/appError'
import { DASHBOARD_SALES_TREND_RPC } from '@/shared/lib/db-schema'
import { tryGetSupabaseClient } from '@/shared/lib/supabase'

export const SALES_PERIODS = ['7d', '30d', '12m'] as const
export type SalesPeriod = (typeof SALES_PERIODS)[number]
export const DEFAULT_SALES_PERIOD: SalesPeriod = '30d'

/**
 * Rendimiento de ventas de un periodo contra el anterior.
 *
 * Mismo contrato de dinero que `dashboard_kpis`: texto y nullable. Null NO es
 * cero; es «no hay una cifra que se pueda afirmar» (monedas mezcladas, o una
 * tienda que el usuario no ve). Cero sí llega como `'0.00'` cuando la tienda
 * de verdad no vendió.
 */
export const salesTrendSchema = z.object({
  period: z.enum(SALES_PERIODS),
  unit: z.enum(['day', 'month']),
  currency: z.string().length(3).nullable(),
  sales: z.string().nullable(),
  previous_sales: z.string().nullable(),
  orders: z.number().int().nonnegative(),
  avg_ticket: z.string().nullable(),
  series: z.array(z.object({ date: z.string(), sales: z.string() })).default([]),
  best: z.object({ date: z.string(), sales: z.string() }).nullable(),
})

export type SalesTrend = z.infer<typeof salesTrendSchema>

/** La zona de quien mira: el «hoy» de Lima no es el de UTC. */
function viewerTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

export async function fetchSalesTrend(storeId: string | null, period: SalesPeriod): Promise<SalesTrend> {
  const supabase = tryGetSupabaseClient()
  if (!supabase) {
    throw new AppError({
      boundary: 'analytics',
      code: 'CONFIG_INCOMPLETA',
      message: 'El proyecto Supabase de eCommerce todavía no está configurado.',
    })
  }

  const { data, error } = await supabase.rpc(DASHBOARD_SALES_TREND_RPC, {
    p_store_id: storeId,
    p_period: period,
    p_tz: viewerTimeZone(),
  })
  if (error) throw new AppError({ boundary: 'analytics', code: codeFromDbError(error) })
  return salesTrendSchema.parse(data)
}

export const salesTrendKey = (storeId: string | null, period: SalesPeriod) =>
  ['sales-trend', storeId, period] as const

export function useSalesTrend(storeId: string | null, period: SalesPeriod) {
  return useQuery<SalesTrend>({
    queryKey: salesTrendKey(storeId, period),
    queryFn: () => fetchSalesTrend(storeId, period),
    enabled: Boolean(storeId),
    retry: false,
    staleTime: 60_000,
    // Cambiar de periodo no debe vaciar la tarjeta mientras llega el nuevo.
    placeholderData: (previous) => previous,
  })
}

/**
 * Variación contra el periodo anterior, en %. Sin base (anterior en cero o sin
 * cifra) no hay variación que afirmar: «+∞ %» no es un dato.
 */
export function salesDelta(trend: Pick<SalesTrend, 'sales' | 'previous_sales'>): number | null {
  if (trend.sales === null || trend.previous_sales === null) return null
  const previous = Number(trend.previous_sales)
  if (!(previous > 0)) return null
  return ((Number(trend.sales) - previous) / previous) * 100
}
