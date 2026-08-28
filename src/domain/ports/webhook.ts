/**
 * Puerto de PUBLICACIÓN de hechos hacia un sistema suscrito (P14-SaaS).
 *
 * ## Por qué existe, según la regla de `ports/index.ts`
 *
 * Un puerto se crea cuando hay una segunda implementación **declarada**, y una
 * fila de `integration_providers` con la operación en `capabilities` cuenta como
 * declaración. La hay: el conector `webhook` de la migración `20260828170200`,
 * con `event.publish`. Y las «implementaciones» de este contrato no son
 * nuestras: es cada sistema suscrito, uno por cliente, y ninguno lo escribe
 * este equipo.
 *
 * Eso es justamente lo que hace que este archivo tenga que existir. Un contrato
 * que solo vive en un `README` se cumple mientras alguien se acuerde; escrito
 * como tipo, `supabase/tests/webhooks.test.ts` comprueba que lo que de verdad
 * sale por la cola tiene esta forma, y la promesa que le hacemos a un tercero
 * pasa de estar documentada a estar verificada.
 *
 * ## Lo que este archivo NO hace
 *
 * No declara ninguna interfaz de cliente HTTP ni de firma. La entrega vive en
 * `supabase/functions/_shared/webhooks`, que es borde: aquí solo está el
 * VOCABULARIO y la forma del sobre, que es lo que un tercero necesita conocer y
 * lo único que no puede cambiar sin romperle la integración.
 */

/** Operaciones canónicas del conector de webhooks. Espejo de sus `capabilities`. */
export const WEBHOOK_OPERATIONS = ['event.publish'] as const
export type WebhookOperation = (typeof WEBHOOK_OPERATIONS)[number]

/**
 * Esquema de firma publicado. `v1` es la versión del ESQUEMA, no la de la API:
 * existe para poder cambiar el algoritmo publicando los dos a la vez durante
 * una ventana, en vez de romper a todos los suscriptores el mismo martes.
 */
export const WEBHOOK_SIGNATURE_SCHEME = 'v1'

/**
 * El SOBRE que recibe un suscriptor.
 *
 * `event_id` es la identidad del hecho y **no cambia al reproducir**: es lo que
 * permite al receptor deduplicar. Un receptor que guarde los `event_id` que ya
 * procesó es inmune tanto a nuestros reintentos como a una reproducción
 * ordenada a mano desde el monitor.
 */
export interface WebhookEnvelope {
  readonly event_id: string
  /** Nombre canónico del hecho, en pasado: `order.created`. */
  readonly event_type: string
  /** Identidad de ESTE intento de entrega. Cambia en cada reproducción. */
  readonly delivery_id: string
  readonly occurred_at: string
  readonly data: Record<string, unknown>
  /** Presente solo cuando la entrega es una reproducción autorizada. */
  readonly replay_of?: string
}

const EVENT_TYPE_FORMAT = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/

/**
 * ¿Esto es un sobre válido?
 *
 * Se usa desde el banco de pruebas de base para comprobar que lo que la cola
 * lleva dentro es exactamente lo que este contrato promete. Sin esta función el
 * contrato sería un comentario.
 */
export function isWebhookEnvelope(value: unknown): value is WebhookEnvelope {
  if (value === null || typeof value !== 'object') return false
  const candidate = value as Record<string, unknown>
  return (
    typeof candidate.event_id === 'string' &&
    candidate.event_id.length > 0 &&
    typeof candidate.event_type === 'string' &&
    EVENT_TYPE_FORMAT.test(candidate.event_type) &&
    typeof candidate.delivery_id === 'string' &&
    typeof candidate.occurred_at === 'string' &&
    candidate.data !== null &&
    typeof candidate.data === 'object'
  )
}
