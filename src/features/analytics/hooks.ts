import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  fetchAnalyticsKpis,
  fetchChannelPerformance,
  fetchFunnel,
  fetchSearchTerms,
  fetchTimeseries,
  fetchTopProducts,
  type AnalyticsWindow,
} from './api'
import { isNotEntitled } from './errors'
import type { AnalyticsRange } from './types'

/**
 * Estado del cuadro de mando.
 *
 * No hay una sola mutación: la analítica se lee. La única escritura del dominio
 * es la puerta anónima de la vitrina (`track_events_for_slug`), y no pasa por
 * aquí — la emite la tienda, no el backoffice.
 *
 * `retry: false` en lo que exige addon: `SIN_MODULO` no se arregla
 * reintentando, y reintentar cuatro veces solo retrasa el mensaje de «no está
 * en tu plan» — misma decisión que la vitrina tomó con el 404 de tienda.
 */
export const ANALYTICS_KEY = ['analytics'] as const

const windowKey = (w: AnalyticsWindow) => [w.storeId, w.from, w.to] as const

export const kpisKey = (w: AnalyticsWindow) => [...ANALYTICS_KEY, 'kpis', ...windowKey(w)] as const
export const topProductsKey = (w: AnalyticsWindow) =>
  [...ANALYTICS_KEY, 'top-products', ...windowKey(w)] as const
export const channelsKey = (w: AnalyticsWindow) =>
  [...ANALYTICS_KEY, 'channels', ...windowKey(w)] as const
export const timeseriesKey = (w: AnalyticsWindow) =>
  [...ANALYTICS_KEY, 'timeseries', ...windowKey(w)] as const
export const funnelKey = (w: AnalyticsWindow) =>
  [...ANALYTICS_KEY, 'funnel', ...windowKey(w)] as const
export const searchTermsKey = (w: AnalyticsWindow) =>
  [...ANALYTICS_KEY, 'search-terms', ...windowKey(w)] as const

/**
 * La ventana, calculada UNA vez y en el cliente.
 *
 * Se manda como par de instantes y no como «últimos N días» a propósito: el
 * servidor tiene su propio defecto (30 días) y si la pantalla lo dejara
 * decidir, cambiar ese defecto movería los números de todas las pantallas a la
 * vez y sin aviso. Aquí el rango es explícito y se ve en la URL de la llamada.
 */
export function useAnalyticsWindow(storeId: string | null, days: AnalyticsRange): AnalyticsWindow {
  return useMemo(() => {
    const to = new Date()
    const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000)
    return { storeId, from: from.toISOString(), to: to.toISOString() }
  }, [storeId, days])
}

export function useAnalyticsKpis(window: AnalyticsWindow) {
  return useQuery({
    queryKey: kpisKey(window),
    queryFn: () => fetchAnalyticsKpis(window),
    enabled: window.storeId !== null,
  })
}

export function useTopProducts(window: AnalyticsWindow) {
  return useQuery({
    queryKey: topProductsKey(window),
    queryFn: () => fetchTopProducts(window),
    enabled: window.storeId !== null,
  })
}

export function useChannelPerformance(window: AnalyticsWindow) {
  return useQuery({
    queryKey: channelsKey(window),
    queryFn: () => fetchChannelPerformance(window),
    enabled: window.storeId !== null,
  })
}

export function useTimeseries(window: AnalyticsWindow) {
  return useQuery({
    queryKey: timeseriesKey(window),
    queryFn: () => fetchTimeseries(window),
    enabled: window.storeId !== null,
  })
}

export function useFunnel(window: AnalyticsWindow, enabled: boolean) {
  return useQuery({
    queryKey: funnelKey(window),
    queryFn: () => fetchFunnel(window),
    enabled: enabled && window.storeId !== null,
    retry: (count, error) => !isNotEntitled(error) && count < 1,
  })
}

export function useSearchTerms(window: AnalyticsWindow, enabled: boolean) {
  return useQuery({
    queryKey: searchTermsKey(window),
    queryFn: () => fetchSearchTerms(window),
    enabled: enabled && window.storeId !== null,
    retry: (count, error) => !isNotEntitled(error) && count < 1,
  })
}
