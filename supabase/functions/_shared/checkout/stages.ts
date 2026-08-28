/**
 * Las once etapas del checkout, EN ORDEN.
 *
 * Esta lista es el contrato del pipeline y está **duplicada a propósito**: la
 * versión que manda es el enum `public.checkout_stage` de la migración
 * `20260828100300`, porque es la que persiste en `checkout_intents.stage` y
 * nadie puede saltársela. Esta copia existe para que el orquestador pueda
 * ordenarlas y para que un fallo tenga nombre antes de llegar a la base. Un
 * test compara las dos listas —mismo patrón que `ORDER_TRANSITIONS` en
 * `_shared/orders.ts`, que lleva desde P02 sin desincronizarse.
 *
 * El orden NO es decorativo. Cada etapa depende de lo que dejó la anterior y,
 * más importante, la posición decide qué hay que **compensar** cuando algo
 * falla: todo lo que se hizo antes de la etapa que revienta hay que deshacerlo,
 * y solo se puede deshacer lo que se sabe que se hizo.
 */
export const CHECKOUT_STAGES = [
  /** Qué tienda, qué canal, qué moneda. Sin esto no se puede decidir nada. */
  'resolve_context',
  /** Quién compra: sesión, cuenta B2B y compatibilidad con el canal. */
  'validate_account',
  /** Cuánto cuesta, según la ÚNICA autoridad de precio (`ebim.resolve_price`). */
  'resolve_prices',
  /** Descuentos. Hoy es un gancho estable que devuelve cero (P10 lo llena). */
  'resolve_promotions',
  /** Impuesto por grupo de tasa. Lo calcula la base; aquí se comprueba. */
  'calculate_taxes',
  /** Apartar existencia con caducidad (P06). Primera etapa con efecto. */
  'reserve_inventory',
  /** ¿Se puede entregar donde dice? Gancho estable hasta P12. */
  'validate_delivery',
  /** Autorizar el cobro y el límite de gasto de la cuenta. Fuera de la transacción. */
  'authorize_payment',
  /** La transacción que crea el pedido, cierra el intento y publica los hechos. */
  'create_order',
  /** Los hechos ya salieron dentro de la transacción anterior; aquí se constata. */
  'publish_events',
  /** Nada síncrono: el aviso lo entrega el consumidor del outbox. */
  'notify',
] as const

export type CheckoutStage = (typeof CHECKOUT_STAGES)[number]

/** Posición de una etapa. Es lo que permite compensar «todo lo anterior». */
export function stageIndex(stage: CheckoutStage): number {
  return CHECKOUT_STAGES.indexOf(stage)
}
