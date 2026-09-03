import { z } from 'zod'

export {
  ORDER_SUGGESTIONS_TABLE,
  ORDER_SUGGESTION_ITEMS_TABLE,
  DEMAND_FORECASTS_TABLE,
  SUGGEST_ORDER_RPC,
} from '@/shared/lib/db-schema'

/**
 * Sugerido de pedido y previsión de demanda, en el CLIENTE.
 *
 * Mitad de pantalla de `20260902180000_planning_demand.sql`.
 *
 * **La sugerencia no crea pedidos.** Produce una lista que una persona
 * confirma, y de ahí sale un carrito que entra por el pipeline de checkout de
 * siempre. Un sistema que pide por ti es un sistema que se equivoca por ti, y
 * en distribución eso se paga en devoluciones y mercadería vencida.
 */

export const SUGGESTION_STATUSES = ['draft', 'sent', 'accepted', 'discarded'] as const
export type SuggestionStatus = (typeof SUGGESTION_STATUSES)[number]

/**
 * A dónde puede ir una sugerencia.
 *
 * La base **no** tiene trigger de estado aquí: es criterio de pantalla, y se
 * dice para que nadie lo confunda con una barrera. `accepted` y `discarded`
 * cierran: una sugerencia aceptada ya tiene un pedido detrás, y una descartada
 * es información sobre el modelo que no conviene reescribir.
 */
export function nextSuggestionStatuses(status: SuggestionStatus): SuggestionStatus[] {
  if (status === 'draft') return ['sent', 'discarded']
  if (status === 'sent') return ['accepted', 'discarded']
  return []
}

export const suggestionSchema = z.object({
  id: z.string().uuid(),
  store_id: z.string().uuid(),
  customer_id: z.string().uuid(),
  sales_rep_id: z.string().uuid().nullable().default(null),
  status: z.enum(SUGGESTION_STATUSES).catch('draft'),
  model_code: z.string(),
  generated_at: z.string(),
  order_id: z.string().uuid().nullable().default(null),
  customer_code: z.string().nullable().default(null),
  customer_name: z.string().nullable().default(null),
})
export type Suggestion = z.infer<typeof suggestionSchema>

export const suggestionItemSchema = z.object({
  id: z.string().uuid(),
  suggestion_id: z.string().uuid(),
  product_id: z.string().uuid(),
  variant_id: z.string().uuid().nullable().default(null),
  uom_code: z.string().nullable().default(null),
  suggested_quantity: z.string(),
  /** Por qué se sugiere. La base lo exige: `order_suggestion_items_reason_len`. */
  reason: z.string(),
  last_period_quantity: z.string().nullable().default(null),
  on_hand_quantity: z.string().nullable().default(null),
  position: z.number().default(0),
  product_name: z.string().nullable().default(null),
  product_sku: z.string().nullable().default(null),
})
export type SuggestionItem = z.infer<typeof suggestionItemSchema>

/** Una fila tal y como la devuelve `ebim.suggest_order`. Todavía no es nada. */
export const suggestedLineSchema = z.object({
  product_id: z.string().uuid(),
  variant_id: z.string().uuid().nullable().default(null),
  suggested_quantity: z.coerce.string(),
  last_period_quantity: z.coerce.string().nullable().default(null),
  reason: z.string(),
})
export type SuggestedLine = z.infer<typeof suggestedLineSchema>

export const forecastSchema = z.object({
  id: z.string().uuid(),
  product_id: z.string().uuid(),
  variant_id: z.string().uuid().nullable().default(null),
  territory_id: z.string().uuid().nullable().default(null),
  period_start: z.string(),
  period_end: z.string(),
  forecast_quantity: z.string(),
  confidence: z.string().nullable().default(null),
  model_code: z.string(),
  product_name: z.string().nullable().default(null),
})
export type Forecast = z.infer<typeof forecastSchema>

/** Ventanas de historial que la pantalla ofrece, en días. */
export const SUGGEST_WINDOWS = [15, 30, 60, 90] as const
export type SuggestWindow = (typeof SUGGEST_WINDOWS)[number]

export const generateFormSchema = z.object({
  customer_id: z.string().uuid('planning.error.customer'),
  days: z.string(),
})
export type GenerateFormValues = z.infer<typeof generateFormSchema>

export function emptyGenerateForm(): GenerateFormValues {
  // Treinta días es el mes comercial: ni tan corto que una semana rara lo
  // desvíe, ni tan largo que arrastre un surtido que ya no se vende.
  return { customer_id: '', days: '30' }
}
