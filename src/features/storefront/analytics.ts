import { getSupabaseClient } from '@/shared/lib/supabase'
import { TRACK_EVENTS_PUBLIC_RPC } from '@/shared/lib/db-schema'

/**
 * Los TRES hechos que solo existen en la vitrina (P13-SaaS).
 *
 * Los otros seis —checkout iniciado y completado, pedido creado y completado,
 * carrito abandonado y promoción canjeada— los emite un trigger del servidor
 * sobre la fila que ya se escribe. Aquí no se pueden emitir aunque se quiera:
 * `public.track_events_for_slug` los rechaza con
 * `ANALYTICS_EVENTO_NO_PERMITIDO`. Eso es lo que hace que un embudo no se pueda
 * falsear desde la consola del navegador.
 *
 * ## La sesión es un número opaco, y ni siquiera viaja entera
 *
 * `sessionStorage`, no `localStorage`: lo que hace falta para un embudo es
 * saber que dos vistas son la MISMA visita, no reconocer a alguien la semana
 * que viene. Al cerrar la pestaña desaparece, que es exactamente la vida útil
 * de la pregunta que responde.
 *
 * Y lo que se guarda en la base tampoco es este valor: el servidor lo pasa por
 * `ebim.hash_token` (sha256) antes de escribirlo. El navegador manda un
 * identificador; la base guarda un resumen del que no se vuelve.
 *
 * ## Nunca rompe la tienda
 *
 * Todo va envuelto en `void ... .catch(() => {})`. No es descuido: una vitrina
 * que no deja comprar porque no pudo registrar una visita es peor que una
 * vitrina sin analítica. Es la misma regla que `ebim.audit` en la base — el
 * registro no manda sobre el hecho.
 */

const SESSION_KEY = 'ebim.analytics.session'

/** Tipos que la puerta pública acepta. Copia de `ebim.storefront_event_types()`. */
export const STOREFRONT_EVENT_TYPES = ['product_view', 'search', 'add_to_cart'] as const
export type StorefrontEventType = (typeof STOREFRONT_EVENT_TYPES)[number]

export interface StorefrontEvent {
  readonly type: StorefrontEventType
  readonly product_id?: string
  readonly variant_id?: string
  readonly term?: string
  readonly result_count?: number
  readonly quantity?: number
}

/**
 * Identificador opaco de la visita. 256 bits, mismo patrón que `carts.token`:
 * dos uuid v4 sin guiones. No lleva nada dentro —ni tienda, ni usuario, ni
 * fecha— porque no tiene que llevarlo: lo único que se le pide es no repetirse.
 */
function newSessionId(): string {
  const raw = `${crypto.randomUUID()}${crypto.randomUUID()}`.replace(/-/g, '')
  return raw.slice(0, 48)
}

export function sessionId(): string | null {
  if (typeof window === 'undefined' || !window.sessionStorage) return null
  try {
    const existing = window.sessionStorage.getItem(SESSION_KEY)
    if (existing && /^[A-Za-z0-9_-]{16,128}$/.test(existing)) return existing
    const created = newSessionId()
    window.sessionStorage.setItem(SESSION_KEY, created)
    return created
  } catch {
    // Navegación privada con almacenamiento bloqueado. Se sigue enviando el
    // hecho SIN sesión: un `product_view` sin agrupar vale para contar vistas,
    // y renunciar a él por no poder agrupar sería perder las dos cosas.
    return null
  }
}

/**
 * Envía un lote. Como mucho 20, que es el techo que impone la base: recortar
 * aquí también evita que una llamada legítima se caiga entera por pasarse.
 */
export async function trackStorefrontEvents(
  storeSlug: string,
  events: readonly StorefrontEvent[],
): Promise<void> {
  if (events.length === 0) return
  const { error } = await getSupabaseClient().rpc(TRACK_EVENTS_PUBLIC_RPC, {
    p_store_slug: storeSlug,
    p_session: sessionId(),
    p_events: events.slice(0, 20),
  })
  // El error se traga a conciencia y no se transforma en `UiError`: no hay
  // pantalla que lo tenga que enseñar. Que la analítica falle es un problema de
  // la analítica.
  if (error) return
}

/** Dispara y olvida. Es la forma en que lo llaman los componentes. */
export function track(storeSlug: string, ...events: StorefrontEvent[]): void {
  void trackStorefrontEvents(storeSlug, events).catch(() => {})
}
