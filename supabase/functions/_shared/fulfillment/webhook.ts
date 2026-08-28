/**
 * La entrada de un aviso de operador logístico, de punta a punta.
 *
 * Es la mitad del seguimiento que no depende de nosotros: el operador avisa por
 * su canal, con su firma, cuando le viene bien y **tantas veces como quiera**.
 * Todo lo que sigue está escrito para que ese «tantas veces como quiera» no
 * ensucie la línea de tiempo del pedido.
 *
 * ## El orden es el que es, y no otro
 *
 *   1. **Verificar la firma sobre el cuerpo CRUDO.** Antes de parsear, antes de
 *      buscar nada. Un sobre que no valida se descarta y no toca la base.
 *   2. **Resolver a quién se refiere**, por la guía. El tenant sale de la fila
 *      encontrada; el sobre nunca lo declara. Un webhook que dijera de qué
 *      organización es sería un tenant declarado por un tercero, que es
 *      exactamente lo que el contrato de plataforma prohíbe.
 *   3. **Ingerir por el comando**, con `signature_verified = true` y los
 *      identificadores de evento del operador. Ahí dentro está el cerrojo de
 *      idempotencia, que es un índice único y no un `if`.
 *
 * ## Lo que NO se hace, y por qué
 *
 * No se responde con detalle. Una guía desconocida y un sobre con firma
 * inválida salen igual de escuetos: decirle a quien prueba «esa guía no existe»
 * frente a «la firma no valida» le enseña a distinguir guías reales.
 *
 * Y no se falla sobre un aviso que no interesa. Un evento informativo del
 * operador se acusa y no mueve nada, porque un webhook al que se responde con
 * error se reintenta, a veces para siempre.
 *
 * Es la misma arquitectura que `_shared/payments/webhook.ts` (P09), escrita
 * igual a propósito: dos puertas de entrada de terceros que se comportan
 * distinto son dos superficies de ataque que hay que razonar por separado.
 */
import { UnknownShippingProviderError, resolveShippingProvider } from './registry.ts'
import { supports } from './provider.ts'

export interface WebhookShipmentRef {
  readonly shipmentId: string
}

/** Lo que el ingestor necesita de la base. Dos operaciones, las dos de servidor. */
export interface TrackingWebhookPorts {
  findShipmentByTracking(
    providerCode: string,
    trackingNumber: string,
  ): Promise<WebhookShipmentRef | null>
  ingest(args: Record<string, unknown>): Promise<Record<string, unknown>>
}

export type TrackingWebhookRejection =
  | 'FIRMA_NO_VERIFICADA'
  | 'CONECTOR_NO_DESPLEGADO'
  | 'CONECTOR_SIN_WEBHOOK'
  | 'GUIA_DESCONOCIDA'

export type TrackingWebhookResult =
  | {
      readonly accepted: true
      /** `true` = ningún evento era nuevo. El operador puede dejar de reintentar. */
      readonly replay: boolean
      readonly shipmentId: string
      readonly events: number
      readonly duplicated: number
      readonly status: string | null
    }
  | { readonly accepted: false; readonly code: TrackingWebhookRejection }

export async function ingestTrackingWebhook(input: {
  providerCode: string
  rawBody: string
  signature: string | null
  /** Resuelto del vault por quien llama. Este módulo no lo guarda ni lo registra. */
  secret: string | null
  ports: TrackingWebhookPorts
}): Promise<TrackingWebhookResult> {
  let provider
  try {
    provider = resolveShippingProvider(input.providerCode)
  } catch (error) {
    if (error instanceof UnknownShippingProviderError) {
      return { accepted: false, code: 'CONECTOR_NO_DESPLEGADO' }
    }
    throw error
  }

  if (!supports(provider, 'webhook') || !provider.verifyWebhook) {
    return { accepted: false, code: 'CONECTOR_SIN_WEBHOOK' }
  }

  // 1 · La firma, sobre el cuerpo crudo y antes de nada más.
  const event = await provider.verifyWebhook(input.rawBody, input.signature, input.secret)
  if (event === null) return { accepted: false, code: 'FIRMA_NO_VERIFICADA' }

  // 2 · De quién es esta guía. El tenant sale de la fila, nunca del sobre.
  const shipment = await input.ports.findShipmentByTracking(provider.code, event.trackingNumber)
  if (shipment === null) return { accepted: false, code: 'GUIA_DESCONOCIDA' }

  // 3 · La ingesta, con los tres cerrojos de la base detrás.
  const applied = await input.ports.ingest({
    p_shipment_id: shipment.shipmentId,
    p_events: event.events.map((update) => ({
      external_event_id: update.externalEventId,
      status: update.status,
      provider_status: update.providerStatus,
      occurred_at: update.occurredAt,
      description: update.description,
      location: update.location,
      payload: update.payload,
    })),
    p_source: 'provider_webhook',
    p_signature_verified: true,
  })

  return {
    accepted: true,
    replay: applied.replay === true,
    shipmentId: shipment.shipmentId,
    events: typeof applied.accepted === 'number' ? applied.accepted : 0,
    duplicated: typeof applied.duplicated === 'number' ? applied.duplicated : 0,
    status: typeof applied.status === 'string' ? applied.status : null,
  }
}
