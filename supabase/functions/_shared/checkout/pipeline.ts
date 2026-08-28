/**
 * El orquestador del checkout.
 *
 * Once etapas en orden, una pila de compensaciones y un intento con clave de
 * idempotencia envolviéndolo todo. Es **puro**: no importa el SDK de Supabase,
 * no lee variables de entorno y no sabe qué base hay detrás. Recibe
 * `CheckoutPorts` y ya. Por eso se puede probar entero —idempotencia, cambio de
 * precio, stock insuficiente, canal inválido, reintento, fallo del efecto
 * externo— sin levantar nada.
 *
 * ## Las cuatro propiedades que este archivo garantiza
 *
 * 1. **Repetir la misma petición no crea dos pedidos.** `begin` devuelve
 *    `replay: true` con la respuesta guardada y el pipeline se detiene ahí, sin
 *    tocar existencia, precio ni cobro. La garantía real es el índice único de
 *    `checkout_intents`; esto es la mitad que el cliente ve.
 *
 * 2. **El servidor recalcula todo lo crítico.** El precio se pide siempre
 *    (etapa 3) y se compara con lo que el navegador creía. Un carrito con
 *    precios editados no cambia ni un céntimo, y además el comprador se entera:
 *    `PRECIO_CAMBIADO` no es un fallo del sistema, es una pregunta.
 *
 * 3. **Todo efecto tiene su deshacer, declarado en el mismo sitio donde se
 *    produce.** No hay un `catch` gigante al final que intente adivinar qué
 *    había pasado: cada etapa que deja rastro empuja su compensación a una pila
 *    y el fallo la vacía en orden inverso.
 *
 * 4. **Ninguna llamada externa dentro de la transacción del pedido.** El cobro
 *    se autoriza en la etapa 8, FUERA; la etapa 9 es una sola transacción de
 *    Postgres que ya solo escribe. Los avisos salen por el outbox, después.
 */
import type { OrderItemInput } from '../orders.ts'
import { CheckoutStageError, asStageError } from './errors.ts'
import { CHECKOUT_STAGES, type CheckoutStage } from './stages.ts'
import type {
  AccountContext,
  CheckoutContext,
  CheckoutPorts,
  CheckoutRequest,
  DeliveryContext,
  PaymentOutcome,
  PlacedOrder,
  PromotionResult,
  PurchaseApproval,
  Quote,
  Reservation,
  TaxResult,
} from './ports.ts'

/** Cuánto se aparta la existencia mientras dura el intento. */
export const RESERVATION_TTL_SECONDS = 900

export interface CheckoutInput extends CheckoutRequest {
  /**
   * `true` = el comprador ya vio el precio nuevo y lo acepta. Sin esto, un
   * cambio de precio detiene la compra una vez y solo una.
   *
   * No entra en el resumen de la petición a propósito: aceptar el precio nuevo
   * es la MISMA compra, y si entrara, confirmar el cambio se leería como una
   * petición distinta y crearía el segundo pedido que todo esto evita.
   */
  readonly acceptPriceChanges?: boolean
}

export interface CheckoutSuccess {
  readonly ok: true
  readonly replay: boolean
  readonly intentId: string
  readonly order: PlacedOrder
  readonly quote: Quote | null
  readonly payment: PaymentOutcome | null
  /** `null` cuando no hay cuenta B2B: no se pregunto, que no es «no hacia falta». */
  readonly approval: PurchaseApproval | null
  readonly stagesRun: readonly CheckoutStage[]
}

/** Una compensación pendiente: qué deshacer y cómo. */
interface Compensation {
  readonly label: string
  run(): Promise<void>
}

function isEmptyItems(items: readonly OrderItemInput[]): boolean {
  return items.length === 0
}

/**
 * Etapa 5 · el impuesto NO se recalcula aquí, y es deliberado.
 *
 * La base ya lo redondea POR GRUPO DE TASA dentro de `ebim.build_quote` y de
 * `create_order`, que es la única forma de que la cotización y el pedido den el
 * mismo céntimo. Rehacerlo en TypeScript crearía una segunda autoridad fiscal
 * que discreparía de la primera el día que alguien cambiara un redondeo. Lo que
 * esta etapa hace es lo que sí le toca: comprobar que los totales que llegaron
 * son coherentes entre sí y arrastrar el efecto de las promociones.
 */
function calculateTaxes(quote: Quote, promotions: PromotionResult): TaxResult {
  if (Number(promotions.discountTotal) !== 0) {
    // P10 traerá descuentos y con ellos la base imponible cambia. Hasta
    // entonces esto no puede pasar, y si pasara sería un error de programación
    // que no debe llegar a un importe cobrado.
    throw new CheckoutStageError({
      stage: 'calculate_taxes',
      code: 'PROMOCION_NO_SOPORTADA',
      message: 'Todavía no hay motor de promociones que recalcule el impuesto',
      status: 500,
    })
  }

  return {
    taxInclusive: quote.taxInclusive,
    subtotal: quote.subtotal,
    taxTotal: quote.taxTotal,
    grandTotal: quote.grandTotal,
  }
}

/**
 * Ejecuta el checkout completo.
 *
 * Devuelve el pedido o lanza un `CheckoutStageError` que ya sabe en qué etapa
 * murió, si se puede reintentar y qué se deshizo por el camino.
 */
export async function runCheckout(
  ports: CheckoutPorts,
  input: CheckoutInput,
): Promise<CheckoutSuccess> {
  if (isEmptyItems(input.items)) {
    throw new CheckoutStageError({
      stage: 'resolve_prices',
      code: 'ITEMS_REQUERIDOS',
      message: 'El pedido necesita al menos una linea',
    })
  }

  // --- Idempotencia. Antes de la primera etapa y fuera de ellas -------------
  const claim = await ports.begin(input).catch((error) => {
    throw asStageError('resolve_context', error)
  })

  if (claim.replay && claim.result) {
    // Este pedido ya existe. No se toca nada: ni precio, ni existencia, ni
    // cobro. Es el caso del reintento de red, y es el que impide el pedido
    // duplicado incluso cuando el navegador insiste.
    return {
      ok: true,
      replay: true,
      intentId: claim.intentId,
      order: toPlacedOrder(claim.result, true),
      quote: null,
      payment: null,
      approval: null,
      stagesRun: [],
    }
  }

  const compensations: Compensation[] = []
  const stagesRun: CheckoutStage[] = []
  let current: CheckoutStage = 'resolve_context'
  let approval: PurchaseApproval | null = null

  const stage = async <T>(name: CheckoutStage, run: () => Promise<T>): Promise<T> => {
    current = name
    await ports.markStage(claim.intentId, name)
    const value = await run()
    stagesRun.push(name)
    return value
  }

  try {
    // --- 1 · Contexto ------------------------------------------------------
    const context: CheckoutContext = await stage('resolve_context', () =>
      ports.resolveContext(input.storeSlug),
    )

    // --- 2 · Cliente, cuenta y canal ---------------------------------------
    const account: AccountContext = await stage('validate_account', async () => {
      const resolved = await ports.resolveAccount()
      // Un canal que exige sesión no lo puede usar un comprador anónimo. La
      // base ya lo impide (`CANAL_NO_PUBLICO`), pero aquí el mensaje puede
      // decir qué hacer —entrar— en vez de solo que no se puede.
      if (context.requiresAuth && !resolved.hasSession) {
        throw new CheckoutStageError({
          stage: 'validate_account',
          code: 'CANAL_EXIGE_SESION',
          message: 'Ese canal de venta exige iniciar sesion',
        })
      }
      return resolved
    })

    // --- 3 · Precio --------------------------------------------------------
    const quote: Quote = await stage('resolve_prices', async () => {
      const resolved = await ports.resolvePrices(input.storeSlug, input.items)

      if (resolved.currency !== context.currency) {
        throw new CheckoutStageError({
          stage: 'resolve_prices',
          code: 'MONEDA_INCONSISTENTE',
          message: `La cotizacion vino en ${resolved.currency} y la tienda opera en ${context.currency}`,
        })
      }

      // El servidor ya recalculó; esto solo decide si hay que AVISAR. La
      // referencia con la que se compara es el snapshot que el propio motor
      // escribió en el carrito, NO un importe declarado por el navegador: en
      // esta petición no viaja ni un céntimo, y eso es una invariante que un
      // test de la vitrina comprueba sobre el cuerpo entero.
      if (input.cartToken && !input.acceptPriceChanges) {
        const drift = await ports.resolvePriceDrift(input.storeSlug, input.cartToken)
        if (drift.changed.length > 0) {
          throw new CheckoutStageError({
            stage: 'resolve_prices',
            code: 'PRECIO_CAMBIADO',
            message: `El precio cambio en ${drift.changed.length} linea(s) desde que se anadieron al carrito`,
            retryable: false,
          })
        }
      }

      return resolved
    })

    // --- 4 · Promociones (gancho estable) ----------------------------------
    const promotions: PromotionResult = await stage('resolve_promotions', () =>
      ports.resolvePromotions({ context, account, quote }),
    )

    // --- 5 · Impuesto ------------------------------------------------------
    const taxes: TaxResult = await stage('calculate_taxes', async () =>
      calculateTaxes(quote, promotions),
    )

    // --- 6 · Existencia. PRIMERA etapa con efecto que hay que deshacer ------
    const reservation: Reservation = await stage('reserve_inventory', async () => {
      const held = await ports.reserveInventory({
        storeSlug: input.storeSlug,
        // La referencia de la reserva ES la clave de idempotencia: reservar dos
        // veces para el mismo intento devuelve la MISMA reserva (P06), así que
        // un reintento no compromete el doble.
        referenceKey: input.idempotencyKey,
        items: input.items,
        ttlSeconds: RESERVATION_TTL_SECONDS,
      })
      compensations.push({
        label: `release_reservation:${held.reservationId}`,
        run: () => ports.releaseReservation(input.storeSlug, held.token),
      })
      // El token queda anotado en el intento: si este proceso muere ahora
      // mismo, el siguiente reintento sabe qué soltar.
      await ports.markStage(claim.intentId, 'reserve_inventory', held.token)
      return held
    })

    // --- 7 · Entrega (gancho estable) --------------------------------------
    await stage('validate_delivery', async (): Promise<DeliveryContext> => {
      const resolved = await ports.validateDelivery({
        context,
        address: input.shippingAddress,
        account,
      })
      if (!resolved.deliverable) {
        throw new CheckoutStageError({
          stage: 'validate_delivery',
          code: 'DIRECCION_NO_ENTREGABLE',
          message: resolved.reason ?? 'No se puede entregar en esa direccion',
        })
      }
      return resolved
    })

    // --- 8 · Cobro y autorización de compra --------------------------------
    const payment: PaymentOutcome = await stage('authorize_payment', async () => {
      // El límite de la persona es una autorización de COMPRA, y solo se puede
      // comprobar cuando ya hay total. Por eso vive aquí y no en la etapa 2.
      if (account.spendingLimit !== null && Number(taxes.grandTotal) > Number(account.spendingLimit)) {
        throw new CheckoutStageError({
          stage: 'authorize_payment',
          code: 'LIMITE_DE_AUTORIZACION',
          message: 'El importe supera el limite de autorizacion de esta persona',
        })
      }

      // ¿Hace falta que alguien de la empresa firme esta compra? Se pregunta
      // aqui, y no en la etapa 2, por la misma razon que el limite: hasta que
      // no hay total no hay pregunta que hacer. Y solo si hay cuenta: un
      // comprador anonimo no tiene a quien pedirle una firma.
      //
      // Que la consulta falle NO puede impedir la compra —el umbral de la
      // cuenta lo impone la base de todas formas, con la fila delante—, asi que
      // un portal B2B que no conteste degrada a «no se pudo preguntar» y sigue.
      if (account.accountId !== null) {
        try {
          approval = await ports.resolveApproval(account.accountId, taxes.grandTotal)
        } catch (error) {
          console.error('[checkout] no se pudo resolver la autorizacion de compra', error)
          approval = null
        }
      }

      const outcome = await ports.authorizePayment({
        amount: taxes.grandTotal,
        currency: quote.currency,
        idempotencyKey: input.idempotencyKey,
        customerEmail: input.customerEmail,
        storeSlug: input.storeSlug,
        methodCode: input.paymentMethodCode,
      })

      if (outcome.status === 'declined') {
        throw new CheckoutStageError({
          stage: 'authorize_payment',
          code: 'PAGO_RECHAZADO',
          message: outcome.providerMessage ?? 'El pago no se pudo autorizar',
        })
      }

      if (outcome.status === 'authorized' || outcome.status === 'captured') {
        // Cobrado o retenido, y todavía sin pedido: si lo que viene falla, hay
        // que deshacerlo. Dinero retenido sin pedido detrás es de alguien, y
        // dinero capturado sin pedido detrás lo es todavía más — por eso
        // `captured` entra aquí desde P09 y no solo `authorized`.
        compensations.push({
          label: `void_payment:${outcome.providerReference ?? 'sin-referencia'}`,
          run: () => ports.voidPayment(outcome),
        })
      }

      return outcome
    })

    // --- 9 · El pedido, en UNA transacción ---------------------------------
    const order: PlacedOrder = await stage('create_order', async () => {
      const placed = await ports.placeOrder({
        intentId: claim.intentId,
        request: input,
        reservationToken: reservation.token,
        payment,
        account,
        approval,
      })
      // A partir de aquí no se compensa: el pedido existe y deshacerlo no es
      // «soltar una reserva», es cancelar una venta. Eso lo decide una persona
      // desde el backoffice (P08), no un `catch`.
      compensations.length = 0
      return placed
    })

    // --- 10 · Los hechos ---------------------------------------------------
    // No hay nada que hacer, y eso es la propiedad, no una carencia: los dos
    // eventos (`order.created` y `notification.order_confirmation`) se
    // escribieron DENTRO de la transacción de la etapa 9. Si esta etapa
    // publicara por su cuenta, existiría el estado «pedido creado, nadie
    // enterado» — que es exactamente lo que el patrón outbox elimina.
    await stage('publish_events', async () => undefined)

    // --- 11 · El aviso -----------------------------------------------------
    // Tampoco hay nada síncrono. El consumidor del outbox entrega el correo con
    // sus reintentos y su backoff; bloquear la respuesta del comprador hasta
    // que un proveedor de mensajería conteste sería regalarle la disponibilidad
    // de la tienda a un tercero.
    await stage('notify', async () => undefined)

    return {
      ok: true,
      replay: order.replay,
      intentId: claim.intentId,
      order,
      quote,
      payment,
      approval,
      stagesRun,
    }
  } catch (error) {
    const stageError = asStageError(current, error)
    const undone = await unwind(compensations)
    const failure = stageError.withCompensations(undone)

    // El cierre del intento no puede tapar el error original: si falla, se
    // registra y se sigue lanzando lo que de verdad pasó.
    try {
      await ports.failIntent(
        claim.intentId,
        failure.stage,
        failure.code,
        [failure.message, ...undone.map((entry) => `compensado: ${entry}`)].join(' · '),
      )
    } catch (closeError) {
      console.error('[checkout] no se pudo cerrar el intento', closeError)
    }

    throw failure
  }
}

/**
 * Deshace en orden INVERSO. Cada compensación va en su propio `try`: si soltar
 * la reserva falla, anular el cobro tiene que intentarse igual. Y ninguna puede
 * reemplazar al error original, que es el que explica qué pasó.
 */
async function unwind(compensations: Compensation[]): Promise<string[]> {
  const done: string[] = []
  for (const compensation of [...compensations].reverse()) {
    try {
      await compensation.run()
      done.push(compensation.label)
    } catch (error) {
      console.error('[checkout] compensacion fallida', compensation.label, error)
      done.push(`${compensation.label}:FALLIDA`)
    }
  }
  compensations.length = 0
  return done
}

/** La respuesta guardada de un intento que ya salió bien, con su forma. */
function toPlacedOrder(result: Record<string, unknown>, replay: boolean): PlacedOrder {
  const text = (key: string): string => {
    const value = result[key]
    return typeof value === 'string' ? value : ''
  }
  return {
    orderId: text('order_id'),
    orderNumber: text('order_number'),
    accessToken: typeof result.access_token === 'string' ? result.access_token : null,
    status: text('status'),
    approvalStatus: text('approval_status') || 'not_required',
    sourceChannel: text('source_channel') || 'storefront',
    currency: text('currency'),
    subtotal: text('subtotal'),
    taxTotal: text('tax_total'),
    grandTotal: text('grand_total'),
    items: Array.isArray(result.items) ? (result.items as Record<string, unknown>[]) : [],
    replay,
  }
}

/** Las once, para quien quiera enseñar el progreso. */
export const PIPELINE_STAGES = CHECKOUT_STAGES
