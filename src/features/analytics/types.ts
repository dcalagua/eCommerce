import { z } from 'zod'

/**
 * Tipos del cuadro de mando (P13-SaaS).
 *
 * Dos reglas propias de esta pantalla, y las dos vienen de la fase:
 *
 *  1. **Los importes son TEXTO y no se suman aquí.** Vienen como `numeric` de
 *     Postgres. Un total recalculado en el navegador es un segundo número que
 *     puede discrepar del que se cobró.
 *  2. **`null` NO es cero.** Toda razón —conversión, abandono, ticket medio—
 *     llega en `null` cuando su denominador es cero, y la pantalla pinta un
 *     guion. Un 0 % de conversión se lee como «la tienda no vende»; un guion se
 *     lee como «todavía no hay con qué calcularlo», que es lo que pasa de
 *     verdad el primer día de un tenant.
 */

export {
  ANALYTICS_CHANNELS_RPC,
  ANALYTICS_FUNNEL_RPC,
  ANALYTICS_KPIS_RPC,
  ANALYTICS_SEARCH_TERMS_RPC,
  ANALYTICS_TIMESERIES_RPC,
  ANALYTICS_TOP_PRODUCTS_RPC,
} from '@/shared/lib/db-schema'

/** Copia del enum `public.analytics_event_type`. Un test compara las dos listas. */
export const ANALYTICS_EVENT_TYPES = [
  'product_view',
  'search',
  'add_to_cart',
  'checkout_started',
  'checkout_completed',
  'cart_abandoned',
  'order_created',
  'order_completed',
  'promotion_used',
] as const
export type AnalyticsEventType = (typeof ANALYTICS_EVENT_TYPES)[number]

/** Ventanas ofrecidas. No hay selector de fecha libre: ver la nota en la pantalla. */
export const ANALYTICS_RANGES = [7, 30, 90] as const
export type AnalyticsRange = (typeof ANALYTICS_RANGES)[number]

const decimal = z.string().nullable()

export const analyticsKpisSchema = z.object({
  from: z.string(),
  to: z.string(),
  currency: z.string().nullable(),
  orders: z.number(),
  gross_sales: decimal,
  paid_sales: decimal,
  discounts: decimal,
  shipping: decimal,
  units: z.number(),
  average_ticket: decimal,
  checkouts_started: z.number(),
  checkouts_completed: z.number(),
  conversion_rate: decimal,
  carts_abandoned: z.number(),
  carts_converted: z.number(),
  abandonment_rate: decimal,
})
export type AnalyticsKpis = z.infer<typeof analyticsKpisSchema>

export const topProductSchema = z.object({
  product_id: z.string().nullable(),
  sku: z.string(),
  name: z.string().nullable(),
  units: z.number(),
  revenue: z.string().nullable(),
  currency: z.string().nullable(),
  orders: z.number(),
})
export type TopProduct = z.infer<typeof topProductSchema>

export const channelRowSchema = z.object({
  channel_id: z.string(),
  channel_code: z.string(),
  channel_name: z.string(),
  channel_kind: z.string(),
  orders: z.number(),
  units: z.number(),
  revenue: z.string().nullable(),
  currency: z.string().nullable(),
})
export type ChannelRow = z.infer<typeof channelRowSchema>

export const timeseriesRowSchema = z.object({
  day: z.string(),
  orders: z.number(),
  units: z.number(),
  revenue: z.string().nullable(),
  currency: z.string().nullable(),
})
export type TimeseriesRow = z.infer<typeof timeseriesRowSchema>

export const funnelRowSchema = z.object({
  event_type: z.string(),
  events: z.number(),
  sessions: z.number().nullable(),
})
export type FunnelRow = z.infer<typeof funnelRowSchema>

export const searchTermSchema = z.object({
  term: z.string(),
  searches: z.number(),
  zero_results: z.number(),
  sessions: z.number().nullable(),
})
export type SearchTermRow = z.infer<typeof searchTermSchema>
