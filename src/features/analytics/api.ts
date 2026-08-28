import type { SupabaseClient } from '@supabase/supabase-js'
import { tryGetSupabaseClient } from '@/shared/lib/supabase'
import { AnalyticsError, analyticsErrorFromDb } from './errors'
import {
  ANALYTICS_CHANNELS_RPC,
  ANALYTICS_FUNNEL_RPC,
  ANALYTICS_KPIS_RPC,
  ANALYTICS_SEARCH_TERMS_RPC,
  ANALYTICS_TIMESERIES_RPC,
  ANALYTICS_TOP_PRODUCTS_RPC,
  analyticsKpisSchema,
  channelRowSchema,
  funnelRowSchema,
  searchTermSchema,
  timeseriesRowSchema,
  topProductSchema,
  type AnalyticsKpis,
  type ChannelRow,
  type FunnelRow,
  type SearchTermRow,
  type TimeseriesRow,
  type TopProduct,
} from './types'

/**
 * Acceso a datos del cuadro de mando.
 *
 * Tres reglas, y las tres son consecuencia de cómo está construido el dominio:
 *
 *  1. **Ninguna consulta declara el tenant.** Ni un `eq('organization_id', …)`.
 *     Las funciones de indicadores son `SECURITY INVOKER`: la RLS del usuario
 *     decide qué filas cuentan, y una tienda ajena aporta cero — no filtra.
 *  2. **Aquí no se calcula ningún indicador.** La pantalla enseña lo que la
 *     base devolvió. Un ticket medio dividido en el navegador sería una segunda
 *     autoridad que discreparía de la primera el día que alguien cambiara un
 *     redondeo.
 *  3. **La ventana es un par de fechas y se manda entera.** No se pide «los
 *     últimos N días» para que el servidor lo interprete: dos pantallas que
 *     traduzcan «30 días» distinto dan dos números distintos.
 */

function client(): SupabaseClient {
  const supabase = tryGetSupabaseClient()
  if (!supabase) throw new AnalyticsError('auth.notConfigured', 'CONFIG_INCOMPLETA')
  return supabase
}

export interface AnalyticsWindow {
  storeId: string | null
  from: string
  to: string
}

function args(window: AnalyticsWindow): Record<string, unknown> {
  return { p_store_id: window.storeId, p_from: window.from, p_to: window.to }
}

export async function fetchAnalyticsKpis(window: AnalyticsWindow): Promise<AnalyticsKpis> {
  const { data, error } = await client().rpc(ANALYTICS_KPIS_RPC, args(window))
  if (error) throw analyticsErrorFromDb(error)
  return analyticsKpisSchema.parse(data)
}

export async function fetchTopProducts(
  window: AnalyticsWindow,
  limit = 10,
): Promise<TopProduct[]> {
  const { data, error } = await client().rpc(ANALYTICS_TOP_PRODUCTS_RPC, {
    ...args(window),
    p_limit: limit,
  })
  if (error) throw analyticsErrorFromDb(error)
  return (data ?? []).map((row: unknown) => topProductSchema.parse(row))
}

export async function fetchChannelPerformance(window: AnalyticsWindow): Promise<ChannelRow[]> {
  const { data, error } = await client().rpc(ANALYTICS_CHANNELS_RPC, args(window))
  if (error) throw analyticsErrorFromDb(error)
  return (data ?? []).map((row: unknown) => channelRowSchema.parse(row))
}

export async function fetchTimeseries(window: AnalyticsWindow): Promise<TimeseriesRow[]> {
  const { data, error } = await client().rpc(ANALYTICS_TIMESERIES_RPC, args(window))
  if (error) throw analyticsErrorFromDb(error)
  return (data ?? []).map((row: unknown) => timeseriesRowSchema.parse(row))
}

/** Exige `analytics.advanced`. Sin el addon, la base levanta `SIN_MODULO`. */
export async function fetchFunnel(window: AnalyticsWindow): Promise<FunnelRow[]> {
  const { data, error } = await client().rpc(ANALYTICS_FUNNEL_RPC, args(window))
  if (error) throw analyticsErrorFromDb(error)
  return (data ?? []).map((row: unknown) => funnelRowSchema.parse(row))
}

/** Exige `analytics.advanced`. Sin el addon, la base levanta `SIN_MODULO`. */
export async function fetchSearchTerms(
  window: AnalyticsWindow,
  limit = 20,
): Promise<SearchTermRow[]> {
  const { data, error } = await client().rpc(ANALYTICS_SEARCH_TERMS_RPC, {
    ...args(window),
    p_limit: limit,
  })
  if (error) throw analyticsErrorFromDb(error)
  return (data ?? []).map((row: unknown) => searchTermSchema.parse(row))
}
