import type { Money } from '../money'
import type { Provider, ProviderOperation } from './operations'

/**
 * `PaymentProvider` — autorizar, capturar y devolver un cobro.
 *
 * La frontera es real y ya está declarada en la base: `integration_providers`
 * trae tres pasarelas distintas (`payment.authorize`, `payment.capture`,
 * `payment.refund`) y `tenant_integrations` deja que cada sociedad habilite la
 * suya. Un tenant cobra por una y otro por otra; el dominio no puede saber cuál.
 *
 * Decisiones que este contrato fija, todas caras de revertir después:
 *
 *  1. **`idempotencyKey` es obligatoria.** No opcional, no «recomendada». Un
 *     cobro es la operación donde un reintento de red cuesta dinero real, y es
 *     exactamente el fallo que P00 documentó en el checkout: la petición llega,
 *     la respuesta se pierde, el navegador reintenta. La clave la pone quien
 *     inicia el cobro y viaja hasta la pasarela.
 *  2. **Autorizar y capturar son dos pasos.** Aunque una pasarela concreta los
 *     junte, el modelo los separa: «autorizado pero no despachado» es un estado
 *     que un comercio de mueble vive todos los días.
 *  3. **Aquí no se toca una tarjeta.** El puerto mueve referencias
 *     (`providerReference`) y montos. Ningún PAN, ningún CVV, ningún token de
 *     tarjeta entra en el dominio ni en este repositorio.
 *  4. **Ningún nombre de banco ni de pasarela.** Eso vive en el `code` del
 *     proveedor, que es un dato del catálogo, no un tipo de TypeScript.
 */

export type PaymentStatus =
  | 'authorized'
  | 'captured'
  | 'refunded'
  | 'declined'
  /** La pasarela aceptó la petición y responderá por webhook. No es éxito. */
  | 'pending'

export interface PaymentIntent {
  /** Identificador del intento en ESTE sistema, no en la pasarela. */
  readonly intentId: string
  readonly orderId: string
  readonly amount: Money
  /**
   * Misma petición, misma clave, un solo cargo. La conserva el proveedor y la
   * reenvía en cada reintento.
   */
  readonly idempotencyKey: string
  /** A dónde vuelve el comprador. La compone el servidor, no el navegador. */
  readonly returnUrl?: string
}

export interface PaymentResult {
  readonly intentId: string
  readonly status: PaymentStatus
  /** Identificador del lado de la pasarela: lo que se cita al conciliar. */
  readonly providerReference: string | null
  readonly amount: Money
  /**
   * Código del proveedor tal cual, SIN traducir. Se guarda para conciliar y
   * para diagnosticar; el texto que ve el comprador sale de i18n.
   */
  readonly providerCode: string | null
  /** A dónde redirigir si la pasarela exige pasar por su página. */
  readonly redirectUrl?: string
}

export interface RefundRequest {
  readonly intentId: string
  /** Devolución parcial: el importe, no el pedido. */
  readonly amount: Money
  readonly idempotencyKey: string
}

/**
 * Notificación entrante de la pasarela. La firma la verifica el adaptador con
 * el secreto del vault (`tenant_integrations.secret_ref`) ANTES de construir
 * esto: al dominio solo llega lo ya verificado.
 */
export interface PaymentWebhook {
  readonly providerReference: string
  readonly status: PaymentStatus
  readonly amount: Money
  readonly receivedAt: string
}

export interface PaymentProvider extends Provider {
  authorize(intent: PaymentIntent): Promise<PaymentResult>
  capture(intentId: string, amount: Money): Promise<PaymentResult>
  refund(request: RefundRequest): Promise<PaymentResult>
  /** `null` si la firma no valida. El llamador NO reintenta: descarta. */
  parseWebhook(payload: unknown, signature: string): PaymentWebhook | null
}

export const PAYMENT_OPERATIONS: readonly ProviderOperation[] = [
  'payment.authorize',
  'payment.capture',
  'payment.refund',
]
