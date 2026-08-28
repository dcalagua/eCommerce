/**
 * Los tres ganchos VACÍOS del pipeline, y por qué existen vacíos.
 *
 * Promociones (P10), entrega (P12) y cobro (P09) son etapas del checkout que
 * hoy no tienen motor. Hay dos formas de tratarlas y una es mala:
 *
 *  · **Omitirlas** hasta que exista el motor. Entonces el día que llegue hay
 *    que abrir el orquestador, meter una etapa en medio, recolocar las
 *    compensaciones y volver a razonar el orden. Se toca lo que ya funcionaba
 *    para añadir lo que no existía.
 *  · **Dejar el asiento hecho** con una implementación estable que devuelve el
 *    elemento neutro. Entonces P09, P10 y P12 son *sustituir un adaptador*, que
 *    es exactamente lo que la Definition of Done de esta fase pide:
 *    «extensible mediante pasos/ports sin nombres de proveedores concretos».
 *
 * El elemento neutro no es «no hacer nada»: es un valor con la forma completa
 * —cero descuentos, entregable, cobro no requerido— que las etapas siguientes
 * pueden consumir sin ramas especiales. Una etapa que a veces devuelve
 * `undefined` obliga a cada consumidor a acordarse.
 */
import type {
  AccountContext,
  CheckoutContext,
  DeliveryContext,
  PaymentOutcome,
  PaymentRequest,
  PromotionResult,
  Quote,
} from './ports.ts'
import type { ShippingAddress } from '../orders.ts'

/**
 * Etapa 4 · sin promociones.
 *
 * Devuelve cero descuentos SIEMPRE, y `calculateTaxes` comprueba que sea cero
 * antes de seguir: si algún día esta implementación devolviera un importe sin
 * que el motor de impuesto sepa recalcular la base, el pipeline se para en vez
 * de cobrar un total inconsistente.
 */
export function noPromotions(_input: {
  context: CheckoutContext
  account: AccountContext
  quote: Quote
}): Promise<PromotionResult> {
  return Promise.resolve({ adjustments: [], discountTotal: '0.00' })
}

/**
 * Etapa 7 · sin reglas de entrega.
 *
 * El checkout mínimo pide una dirección de texto libre y una referencia
 * (P06), y eso es lo único que hay que validar hoy — el formato ya lo impuso
 * `normalizeShippingAddress`. Lo que P12 traerá son zonas de cobertura, coste
 * de envío y ventanas de entrega; el asiento está aquí y la forma del
 * resultado no va a cambiar: entregable o no, y por qué.
 */
export function alwaysDeliverable(input: {
  context: CheckoutContext
  address: ShippingAddress
  account: AccountContext
}): Promise<DeliveryContext> {
  return Promise.resolve({ address: input.address, deliverable: true, reason: null })
}

/**
 * Etapa 8 · sin pasarela.
 *
 * `not_required` y no `authorized`: decir que se autorizó un cobro que nunca se
 * intentó sería mentir en el sitio donde más caro sale. La tienda cobra por su
 * canal y el pedido nace en `pending`, que es lo que ya hacía P06 — la
 * diferencia es que ahora esa decisión tiene un nombre y un puerto.
 *
 * P09 sustituye esta función por una que resuelve el proveedor activo del
 * tenant en `tenant_integrations` y le pide `payment.authorize`. Ni esta
 * función ni su reemplazo pueden nombrar una pasarela: el nombre vive en el
 * `code` de `integration_providers`, que es un dato.
 */
export function noPaymentGateway(_request: PaymentRequest): Promise<PaymentOutcome> {
  return Promise.resolve({
    status: 'not_required',
    providerCode: null,
    providerReference: null,
    providerMessage: null,
  })
}

/**
 * Compensación del cobro. Sin pasarela no hay nada que anular, y por eso no
 * lanza: una compensación que falla cuando no había nada que deshacer taparía
 * el error real que la disparó.
 */
export function noPaymentVoid(_outcome: PaymentOutcome): Promise<void> {
  return Promise.resolve()
}
