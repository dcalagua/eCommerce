/**
 * Los puertos del checkout.
 *
 * El orquestador (`pipeline.ts`) no sabe qué hay detrás de ninguna de estas
 * funciones: ni que el precio lo resuelve `ebim.resolve_price`, ni que la
 * existencia la aparta `reserve_inventory_for_slug`, ni —sobre todo— quién
 * cobra. **Ningún nombre de pasarela, transportista ni ERP aparece en este
 * archivo ni en ninguno de este directorio**, que es la misma regla que
 * `src/architecture.test.ts` impone sobre `src/`: los proveedores concretos son
 * filas de `integration_providers`, no tipos de TypeScript.
 *
 * Dos reglas más, heredadas de `src/domain/ports` (ADR 001):
 *
 *  1. **Ningún puerto recibe el tenant.** `organization_id` y `company_id`
 *     salen de la tienda dentro de la base. Un parámetro que se puede pasar se
 *     puede pasar mal.
 *  2. **Ninguno recibe un precio, un total ni un canal.** Todo lo que decide
 *     dinero lo devuelve el servidor; el pipeline lo transporta y lo compara,
 *     nunca lo calcula.
 *
 * Sobre la relación con `src/domain/ports/payment.ts`: es el mismo contrato,
 * escrito dos veces porque el borde corre en Deno y no puede importar de `src`.
 * `PaymentAuthorizationPort` es un subconjunto —autorizar y anular— y su
 * vocabulario de estados se compara con el del dominio en un test.
 */
import type { CheckoutStage } from './stages.ts'
import type { OrderItemInput, ShippingAddress } from '../orders.ts'

/** Importe decimal como TEXTO. El céntimo no pasa por un `number`. */
export type MoneyText = string

// ---------------------------------------------------------------------------
// 1 · Contexto
// ---------------------------------------------------------------------------
export interface CheckoutContext {
  readonly storeSlug: string
  readonly storeName: string
  readonly currency: string
  readonly channelCode: string
  readonly channelKind: string
  readonly requiresAuth: boolean
  readonly taxInclusive: boolean
}

// ---------------------------------------------------------------------------
// 2 · Cliente / cuenta
// ---------------------------------------------------------------------------
/**
 * Lo que el SERVIDOR sabe de quien compra. No hay ningún campo que el navegador
 * pueda declarar: la cuenta B2B sale de `my_business_accounts()`, que desde P05
 * no acepta un solo argumento precisamente para que no exista la clase de error
 * que consiste en creerse el id que manda el cliente.
 */
export interface AccountContext {
  readonly hasSession: boolean
  readonly accountId: string | null
  readonly role: string | null
  /** Tope de autorización de la persona, como texto decimal. `null` = sin tope. */
  readonly spendingLimit: MoneyText | null
}

/**
 * ¿Esta compra necesita que alguien de la empresa la firme? (P08-SaaS)
 *
 * La respuesta la da `public.purchase_approval`, y se pide **con la sesión del
 * comprador** por la misma razón que la cuenta: el límite de la persona depende
 * de quién pregunta, y con `service_role` esa pregunta no tiene respuesta.
 *
 * Es una CONSULTA, no una decisión: no crea nada y no cambia ningún estado. Lo
 * que decide de verdad es la base, dentro de `create_order`, que además impone
 * el umbral de la CUENTA por su cuenta — este resultado solo puede AÑADIR una
 * aprobación, nunca quitarla.
 */
export interface PurchaseApproval {
  readonly required: boolean
  /** `user_limit`, `rule` o `account_threshold`. Nunca un texto libre. */
  readonly reason: string | null
  readonly purchaseOrderRequired: boolean
}

// ---------------------------------------------------------------------------
// 3 · Precio
// ---------------------------------------------------------------------------
export interface QuotedLine {
  readonly productId: string
  readonly variantId: string | null
  readonly uomCode: string | null
  readonly name: string
  readonly quantity: number
  readonly unitPrice: MoneyText
  readonly netAmount: MoneyText
  readonly taxRate: MoneyText
  readonly source: string
  readonly priceListCode: string | null
  readonly scope: string | null
}

export interface Quote {
  readonly currency: string
  readonly channelCode: string
  readonly taxInclusive: boolean
  readonly lines: readonly QuotedLine[]
  readonly subtotal: MoneyText
  readonly taxTotal: MoneyText
  readonly grandTotal: MoneyText
}

/**
 * Lineas cuyo precio ya no es el que el comprador vio.
 *
 * La referencia NO la pone el navegador: sale de
 * `cart_items.unit_price_snapshot`, que escribio el motor de precios cuando el
 * comprador toco el carrito por ultima vez. Es lo que permite avisar de un
 * cambio de precio **sin que ningun importe viaje en la peticion de compra**.
 */
export interface DriftedLine {
  readonly productId: string
  readonly variantId: string | null
  readonly uomCode: string | null
  readonly was: MoneyText
  readonly now: MoneyText
}

export interface PriceDrift {
  readonly changed: readonly DriftedLine[]
}

// ---------------------------------------------------------------------------
// 4 · Promociones (gancho estable; P10)
// ---------------------------------------------------------------------------
export interface PromotionAdjustment {
  readonly code: string
  readonly label: string
  readonly amount: MoneyText
  readonly productId: string | null
}

export interface PromotionResult {
  readonly adjustments: readonly PromotionAdjustment[]
  readonly discountTotal: MoneyText
}

// ---------------------------------------------------------------------------
// 5 · Impuesto
// ---------------------------------------------------------------------------
export interface TaxResult {
  readonly taxInclusive: boolean
  readonly subtotal: MoneyText
  readonly taxTotal: MoneyText
  readonly grandTotal: MoneyText
}

// ---------------------------------------------------------------------------
// 6 · Existencia
// ---------------------------------------------------------------------------
export interface Reservation {
  readonly reservationId: string
  /** Secreto de 256 bits. Es lo único que permite reclamar ESTA reserva. */
  readonly token: string
  readonly expiresAt: string
  /** `false` = ya existía por la misma referencia (idempotencia de P06). */
  readonly created: boolean
}

// ---------------------------------------------------------------------------
// 7 · Entrega (gancho estable; P12)
// ---------------------------------------------------------------------------
export interface DeliveryContext {
  readonly address: ShippingAddress
  readonly deliverable: boolean
  /** Motivo cuando no lo es. Sin nombres de transportista. */
  readonly reason: string | null
}

// ---------------------------------------------------------------------------
// 8 · Pago
// ---------------------------------------------------------------------------
/**
 * `not_required` es un estado de primera clase y no un `null`: «esta tienda
 * todavía no cobra en línea» es una decisión del comercio, no la ausencia de un
 * dato. Con `null` habría que preguntarse en cada rama si es que no hay
 * pasarela o si es que falló la que hay.
 */
export type PaymentStatus = 'not_required' | 'authorized' | 'pending' | 'declined'

export interface PaymentRequest {
  readonly amount: MoneyText
  readonly currency: string
  /** La misma que ancla el intento. Viaja hasta el proveedor. */
  readonly idempotencyKey: string
  readonly customerEmail: string
}

export interface PaymentOutcome {
  readonly status: PaymentStatus
  /** Código del proveedor en `integration_providers`. Nunca su marca. */
  readonly providerCode: string | null
  readonly providerReference: string | null
  /** Código del proveedor tal cual, para conciliar. El texto del comprador es i18n. */
  readonly providerMessage: string | null
}

// ---------------------------------------------------------------------------
// 9 · Pedido
// ---------------------------------------------------------------------------
export interface PlacedOrder {
  readonly orderId: string
  readonly orderNumber: string
  readonly accessToken: string | null
  readonly status: string
  /** P08: `pending` = el pedido existe pero espera la firma de la empresa. */
  readonly approvalStatus: string
  readonly sourceChannel: string
  readonly currency: string
  readonly subtotal: MoneyText
  readonly taxTotal: MoneyText
  readonly grandTotal: MoneyText
  readonly items: readonly Record<string, unknown>[]
  readonly replay: boolean
}

// ---------------------------------------------------------------------------
// El conjunto
// ---------------------------------------------------------------------------
export interface CheckoutRequest {
  readonly storeSlug: string
  readonly idempotencyKey: string
  readonly requestHash: string
  readonly cartToken: string | null
  readonly customerName: string
  readonly customerEmail: string
  readonly customerPhone: string
  readonly shippingAddress: ShippingAddress
  /**
   * Dirección FISCAL. `null` = se factura donde se entrega, que es lo que pasa
   * en casi toda compra B2C. No es un dato de dinero: es una dirección, y por
   * eso sí puede venir del comprador.
   */
  readonly billingAddress: ShippingAddress | null
  readonly notes: string | null
  readonly items: readonly OrderItemInput[]
}

export interface IntentClaim {
  readonly intentId: string
  readonly replay: boolean
  readonly attempt: number
  /** Respuesta ya construida del intento que salió bien. Solo si `replay`. */
  readonly result: Record<string, unknown> | null
}

export interface CheckoutPorts {
  // Idempotencia: no es una etapa, es lo que envuelve a las once.
  begin(request: CheckoutRequest): Promise<IntentClaim>
  markStage(intentId: string, stage: CheckoutStage, reservationToken?: string): Promise<void>
  failIntent(
    intentId: string,
    stage: CheckoutStage,
    code: string,
    detail: string,
  ): Promise<void>

  // Las once etapas, en el orden de `CHECKOUT_STAGES`.
  resolveContext(storeSlug: string): Promise<CheckoutContext>
  resolveAccount(): Promise<AccountContext>
  resolvePrices(storeSlug: string, items: readonly OrderItemInput[]): Promise<Quote>
  /**
   * Solo tiene sentido con un carrito de servidor detras: sin snapshot no hay
   * con que comparar. Sin carrito devuelve la lista vacia, que es la respuesta
   * honesta y no un "no cambio nada".
   */
  resolvePriceDrift(storeSlug: string, cartToken: string): Promise<PriceDrift>
  resolvePromotions(input: {
    context: CheckoutContext
    account: AccountContext
    quote: Quote
  }): Promise<PromotionResult>
  reserveInventory(input: {
    storeSlug: string
    referenceKey: string
    items: readonly OrderItemInput[]
    ttlSeconds: number
  }): Promise<Reservation>
  validateDelivery(input: {
    context: CheckoutContext
    address: ShippingAddress
    account: AccountContext
  }): Promise<DeliveryContext>
  authorizePayment(request: PaymentRequest): Promise<PaymentOutcome>
  /**
   * Solo se pregunta cuando hay cuenta B2B. Un comprador anónimo no tiene a
   * quién pedirle una firma, y preguntarlo igual sería inventar un circuito de
   * aprobación para el 99% de las compras (regla de la fase: la aprobación B2B
   * no contamina B2C).
   */
  resolveApproval(accountId: string, amount: MoneyText): Promise<PurchaseApproval>
  placeOrder(input: {
    intentId: string
    request: CheckoutRequest
    reservationToken: string | null
    payment: PaymentOutcome
    account: AccountContext
    approval: PurchaseApproval | null
  }): Promise<PlacedOrder>

  // Compensaciones. Existen porque las etapas 6 y 8 dejan rastro fuera de la
  // transacción del pedido, y ese rastro hay que poder deshacerlo.
  releaseReservation(storeSlug: string, token: string): Promise<void>
  voidPayment(outcome: PaymentOutcome): Promise<void>
}
