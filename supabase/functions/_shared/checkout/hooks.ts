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
  GiftCardTender,
  PaymentOutcome,
  PaymentRequest,
  PromotionResult,
  Quote,
} from './ports.ts'
import type { OrderItemInput, ShippingAddress } from '../orders.ts'

/**
 * Etapa 4 · sin promociones.
 *
 * P10 le puso motor detrás (`serverPromotions`, en `dbPorts.ts`), pero esta
 * función NO se retira y no es código muerto: es el elemento neutro con el que
 * se prueba que el pipeline se comporta igual cuando el comercio no tiene el
 * módulo contratado, que es el caso de todo tenant recién dado de alta. Ese
 * camino tiene que seguir existiendo y tiene que seguir estando probado.
 *
 * Devuelve cero descuentos SIEMPRE y **sin `totals`**, y `calculateTaxes`
 * comprueba las dos cosas: un importe de descuento sin totales recalculados
 * detrás sería un error de programación que no debe llegar a un cobro.
 */
export function noPromotions(_input: {
  context: CheckoutContext
  account: AccountContext
  quote: Quote
  couponCodes: readonly string[]
  customerEmail: string
  items: readonly OrderItemInput[]
}): Promise<PromotionResult> {
  return Promise.resolve({
    adjustments: [],
    discountTotal: '0.00',
    lines: [],
    coupons: [],
    skipped: [],
  })
}

/**
 * Etapa 8a · sin tarjetas regalo.
 *
 * El elemento neutro no es «cero»: es «no se aplicó nada y queda por cobrar
 * todo». Devolver `applied: '0.00'` sin `remaining` obligaría a la etapa 8 a
 * acordarse de que, cuando no hay tarjeta, el importe a autorizar es el total —
 * y una rama que hay que recordar es una rama que un día se olvida.
 */
export function noGiftCards(input: {
  storeSlug: string
  codes: readonly string[]
  amount: string
  idempotencyKey: string
}): Promise<GiftCardTender> {
  return Promise.resolve({ redemptions: [], applied: '0.00', remaining: input.amount })
}

/**
 * Compensación del canje. Sin tarjeta no hay saldo que devolver, y por eso no
 * lanza: una compensación que falla cuando no había nada que deshacer taparía
 * el error real que la disparó.
 */
export function noGiftCardRelease(_input: {
  storeSlug: string
  tender: GiftCardTender
}): Promise<void> {
  return Promise.resolve()
}

/**
 * Etapa 7 · sin reglas de entrega.
 *
 * P12 le puso motor detrás (`serverDelivery`, en `dbPorts.ts`), pero esta
 * función NO se retira y no es código muerto: es el elemento neutro con el que
 * se prueba que el pipeline se comporta igual cuando el comercio no ha
 * configurado ninguna zona ni ningún método, que es el caso de todo tenant
 * recién dado de alta y el que funcionaba desde P06. Ese camino tiene que
 * seguir existiendo y tiene que seguir estando probado.
 *
 * Devuelve entregable y coste CERO siempre. `methodCode: null` es lo que hace
 * que `create_order` no planifique ningún fulfillment: no es que la entrega
 * falle, es que no se eligió ninguna.
 */
export function alwaysDeliverable(input: {
  context: CheckoutContext
  address: ShippingAddress
  account: AccountContext
}): Promise<DeliveryContext> {
  return Promise.resolve({
    address: input.address,
    deliverable: true,
    reason: null,
    amount: '0.00',
    methodCode: null,
    strategy: null,
    promisedFrom: null,
    promisedTo: null,
  })
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
