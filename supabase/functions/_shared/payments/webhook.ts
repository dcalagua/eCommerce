/**
 * La entrada de un aviso de pasarela, de punta a punta.
 *
 * Es la mitad del cobro que no depende del comprador: la pasarela avisa por su
 * canal, con su firma, cuando le viene bien y **tantas veces como quiera**.
 * Todo lo que sigue está escrito para que ese «tantas veces como quiera» no
 * cueste dinero.
 *
 * ## El orden es el que es, y no otro
 *
 *   1. **Verificar la firma sobre el cuerpo CRUDO.** Antes de parsear, antes de
 *      buscar nada. Un sobre que no valida se descarta y no toca la base.
 *   2. **Resolver a quién se refiere**, por la referencia del proveedor. El
 *      tenant sale de la fila encontrada; el sobre nunca lo declara. Un webhook
 *      que dijera de qué organización es sería un tenant declarado por un
 *      tercero, que es exactamente lo que el contrato prohíbe.
 *   3. **Aplicar por el comando**, con `signature_verified = true` y el
 *      identificador de evento del proveedor. Ahí dentro están los tres
 *      cerrojos de idempotencia.
 *
 * ## Lo que NO se hace, y por qué
 *
 * No se responde con detalle. Un aviso desconocido y uno con firma inválida
 * salen igual de escuetos: decirle a quien prueba «esa referencia no existe»
 * frente a «la firma no valida» le enseña a distinguir referencias reales.
 *
 * Y no se lanza sobre un evento que no interesa: un `payment.pending` de la
 * pasarela es información, no un problema. Se acusa recibo y no se mueve nada,
 * porque un webhook al que se responde con error se reintenta para siempre.
 */
import {
  attemptOperation,
  attemptStatusFor,
  intentStatusFor,
  supports,
  type PaymentResultStatus,
} from './provider.ts'
import { UnknownPaymentProviderError, resolvePaymentProvider } from './registry.ts'

export interface WebhookIntentRef {
  readonly intentId: string
}

export interface WebhookRefundRef {
  readonly refundId: string
}

/**
 * Lo que el ingestor necesita de la base. Cuatro operaciones, todas de
 * servidor: la búsqueda por referencia y los dos comandos que mueven dinero.
 */
export interface WebhookPorts {
  findIntentByReference(
    providerCode: string,
    providerReference: string,
  ): Promise<WebhookIntentRef | null>
  findRefundByReference(
    providerCode: string,
    providerReference: string,
  ): Promise<WebhookRefundRef | null>
  applyOutcome(args: Record<string, unknown>): Promise<Record<string, unknown>>
  settleRefund(args: Record<string, unknown>): Promise<Record<string, unknown>>
}

export type WebhookRejection =
  | 'FIRMA_NO_VERIFICADA'
  | 'CONECTOR_NO_DESPLEGADO'
  | 'CONECTOR_SIN_WEBHOOK'
  | 'REFERENCIA_DESCONOCIDA'

export type WebhookResult =
  | {
      readonly accepted: true
      readonly replay: boolean
      readonly kind: 'payment' | 'refund' | 'ignored'
      readonly intentId: string | null
      readonly refundId: string | null
      readonly status: string | null
    }
  | { readonly accepted: false; readonly code: WebhookRejection }

/** Estados del proveedor que SÍ mueven un intento de cobro. */
const PAYMENT_STATUSES: readonly PaymentResultStatus[] = [
  'authorized',
  'captured',
  'declined',
  'failed',
  'cancelled',
]

function isPaymentStatus(status: string): status is PaymentResultStatus {
  return (PAYMENT_STATUSES as readonly string[]).includes(status)
}

export async function ingestPaymentWebhook(input: {
  providerCode: string
  rawBody: string
  signature: string | null
  /** Resuelto del vault por quien llama. Este módulo no lo guarda ni lo registra. */
  secret: string | null
  ports: WebhookPorts
}): Promise<WebhookResult> {
  let provider
  try {
    provider = resolvePaymentProvider(input.providerCode)
  } catch (error) {
    if (error instanceof UnknownPaymentProviderError) {
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

  // 2 · Una devolución se liquida contra la DEVOLUCIÓN, no contra el cobro.
  if (event.status === 'refunded') {
    const refund = await input.ports.findRefundByReference(
      provider.code,
      event.providerReference,
    )
    if (refund === null) return { accepted: false, code: 'REFERENCIA_DESCONOCIDA' }

    const settled = await input.ports.settleRefund({
      p_refund_id: refund.refundId,
      p_status: 'succeeded',
      p_provider_reference: event.providerReference,
      p_source: 'provider_webhook',
      p_external_event_id: event.externalEventId,
      p_signature_verified: true,
      p_payload: event.payload,
    })
    return {
      accepted: true,
      replay: settled.replay === true,
      kind: 'refund',
      intentId: null,
      refundId: refund.refundId,
      status: typeof settled.status === 'string' ? settled.status : null,
    }
  }

  const intent = await input.ports.findIntentByReference(provider.code, event.providerReference)
  if (intent === null) return { accepted: false, code: 'REFERENCIA_DESCONOCIDA' }

  // 3 · Un evento que no mueve nada se acusa y se olvida. Responder con error
  //     a un aviso legítimo pero irrelevante lo condena a reintentarse siempre.
  if (!isPaymentStatus(event.status)) {
    return {
      accepted: true,
      replay: false,
      kind: 'ignored',
      intentId: intent.intentId,
      refundId: null,
      status: null,
    }
  }

  const applied = await input.ports.applyOutcome({
    p_intent_id: intent.intentId,
    p_operation: attemptOperation('webhook'),
    // La clave del intento es el identificador del evento del proveedor: el
    // mismo aviso reenviado cae sobre la misma fila de `payment_attempts`.
    p_idempotency_key: `webhook:${event.externalEventId}`,
    p_attempt_status: attemptStatusFor(event.status),
    p_intent_status: intentStatusFor(event.status),
    p_amount: event.amount,
    p_provider_reference: event.providerReference,
    p_provider_result_code: event.eventType,
    p_source: 'provider_webhook',
    p_external_event_id: event.externalEventId,
    p_signature_verified: true,
    p_payload: event.payload,
  })

  return {
    accepted: true,
    replay: applied.replay === true,
    kind: 'payment',
    intentId: intent.intentId,
    refundId: null,
    status: typeof applied.status === 'string' ? applied.status : null,
  }
}
