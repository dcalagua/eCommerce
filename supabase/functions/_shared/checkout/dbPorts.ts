/**
 * Los adaptadores del pipeline sobre las funciones de la base.
 *
 * Traducen y nada más. **Ni un cálculo aquí dentro**: cualquier suma, resta o
 * redondeo en este archivo sería un segundo sitio donde el importe puede salir
 * distinto del que se cobra, que es exactamente lo que P04 cerró al dejar una
 * sola autoridad de precio.
 *
 * ## Dos llamadores, no uno
 *
 * `service` salta la RLS y se usa para lo que el comprador anónimo no puede
 * hacer por su cuenta: reclamar el intento, reservar existencia, crear el
 * pedido. `caller` actúa COMO QUIEN LLAMA (clave publicable + su
 * `Authorization`) y se usa para una sola cosa: preguntar de qué cuenta B2B es
 * miembro. Es deliberado —`my_business_accounts()` no acepta argumentos desde
 * P05 justamente para que la cuenta salga de la sesión y no de un id— y con
 * `service` la pregunta no tendría respuesta posible: no hay sesión que
 * consultar.
 */
import type { OrderItemInput } from '../orders.ts'
import { alwaysDeliverable, noPaymentGateway, noPaymentVoid, noPromotions } from './hooks.ts'
import type {
  AccountContext,
  CheckoutContext,
  CheckoutPorts,
  CheckoutRequest,
  IntentClaim,
  PlacedOrder,
  PriceDrift,
  Quote,
  QuotedLine,
  Reservation,
} from './ports.ts'
import type { CheckoutStage } from './stages.ts'

/**
 * Llamar a una función de la base. Resuelve con el dato o **lanza un `Error`
 * cuyo mensaje es el de Postgres** (`CODIGO: texto`), que es lo que
 * `asStageError` sabe descomponer en código y detalle.
 */
export type RpcCaller = (fn: string, args: Record<string, unknown>) => Promise<unknown>

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function text(source: Record<string, unknown>, key: string, fallback = ''): string {
  const value = source[key]
  return typeof value === 'string' ? value : fallback
}

function nullableText(source: Record<string, unknown>, key: string): string | null {
  const value = source[key]
  return typeof value === 'string' && value !== '' ? value : null
}

function itemPayload(items: readonly OrderItemInput[]): Record<string, unknown>[] {
  return items.map((item) => {
    const line: Record<string, unknown> = {
      product_id: item.product_id,
      quantity: item.quantity,
    }
    if (item.variant_id) line.variant_id = item.variant_id
    if (item.uom_code) line.uom_code = item.uom_code
    return line
  })
}

function toQuote(raw: unknown): Quote {
  const source = record(raw)
  const lines = Array.isArray(source.lines) ? source.lines : []
  return {
    currency: text(source, 'currency'),
    channelCode: text(source, 'channel'),
    taxInclusive: source.tax_inclusive === true,
    lines: lines.map((entry): QuotedLine => {
      const line = record(entry)
      return {
        productId: text(line, 'product_id'),
        variantId: nullableText(line, 'variant_id'),
        uomCode: nullableText(line, 'uom_code'),
        name: text(line, 'name'),
        quantity: Number(line.quantity ?? 0),
        unitPrice: text(line, 'unit_price', '0.00'),
        netAmount: text(line, 'net_amount', '0.00'),
        taxRate: text(line, 'tax_rate', '0'),
        source: text(line, 'source', 'catalog'),
        priceListCode: nullableText(line, 'price_list_code'),
        scope: nullableText(line, 'scope'),
      }
    }),
    subtotal: text(source, 'subtotal', '0.00'),
    taxTotal: text(source, 'tax_total', '0.00'),
    grandTotal: text(source, 'grand_total', '0.00'),
  }
}

export interface DbPortOptions {
  /** Salta RLS. Solo lo que el comprador anónimo no puede hacer por su cuenta. */
  readonly service: RpcCaller
  /** Actúa como quien llama. Solo para resolver la cuenta B2B de la sesión. */
  readonly caller: RpcCaller
  /** `true` si la petición traía `Authorization`. No prueba nada por sí solo. */
  readonly hasSession: boolean
}

export function createDbPorts(options: DbPortOptions): CheckoutPorts {
  const { service, caller, hasSession } = options

  return {
    async begin(request: CheckoutRequest): Promise<IntentClaim> {
      const raw = record(
        await service('checkout_begin', {
          p_store_slug: request.storeSlug,
          p_idempotency_key: request.idempotencyKey,
          p_request_hash: request.requestHash,
          p_cart_token: request.cartToken,
        }),
      )
      return {
        intentId: text(raw, 'intent_id'),
        replay: raw.replay === true,
        attempt: Number(raw.attempt ?? 1),
        result: raw.result ? record(raw.result) : null,
      }
    },

    async markStage(intentId: string, stage: CheckoutStage, reservationToken?: string) {
      await service('checkout_mark_stage', {
        p_intent_id: intentId,
        p_stage: stage,
        p_reservation_token: reservationToken ?? null,
      })
    },

    async failIntent(intentId: string, stage: CheckoutStage, code: string, detail: string) {
      await service('checkout_fail', {
        p_intent_id: intentId,
        p_stage: stage,
        p_code: code,
        p_detail: detail,
      })
    },

    async resolveContext(storeSlug: string): Promise<CheckoutContext> {
      const raw = record(await service('checkout_context', { p_store_slug: storeSlug }))
      return {
        storeSlug: text(raw, 'store_slug', storeSlug),
        storeName: text(raw, 'store_name'),
        currency: text(raw, 'currency'),
        channelCode: text(raw, 'channel'),
        channelKind: text(raw, 'channel_kind'),
        requiresAuth: raw.requires_auth === true,
        taxInclusive: raw.tax_inclusive === true,
      }
    },

    async resolveAccount(): Promise<AccountContext> {
      const empty: AccountContext = {
        hasSession,
        accountId: null,
        role: null,
        spendingLimit: null,
      }
      if (!hasSession) return empty

      // Con sesión pero sin vínculo, la respuesta es una lista vacía y NO un
      // error: un comprador con cuenta EBIM que todavía no está vinculado a
      // ninguna empresa compra igual que un anónimo.
      let rows: unknown
      try {
        rows = await caller('my_business_accounts', {})
      } catch (error) {
        // Que el portal B2B no conteste no puede impedir una compra normal.
        console.error('[checkout] no se pudo resolver la cuenta B2B', error)
        return empty
      }

      const first = Array.isArray(rows) ? record(rows[0]) : record(rows)
      if (!first.account_id) return empty

      return {
        hasSession,
        accountId: text(first, 'account_id'),
        role: nullableText(first, 'role'),
        spendingLimit: nullableText(first, 'spending_limit'),
      }
    },

    async resolvePrices(storeSlug: string, items: readonly OrderItemInput[]): Promise<Quote> {
      return toQuote(
        await service('price_quote_for_slug', {
          p_store_slug: storeSlug,
          p_items: itemPayload(items),
        }),
      )
    },

    async resolvePriceDrift(storeSlug: string, cartToken: string): Promise<PriceDrift> {
      const raw = record(
        await service('cart_price_drift', { p_store_slug: storeSlug, p_token: cartToken }),
      )
      const changed = Array.isArray(raw.changed) ? raw.changed : []
      return {
        changed: changed.map((entry) => {
          const line = record(entry)
          return {
            productId: text(line, 'product_id'),
            variantId: nullableText(line, 'variant_id'),
            uomCode: nullableText(line, 'uom_code'),
            was: text(line, 'was', '0.00'),
            now: text(line, 'now', '0.00'),
          }
        }),
      }
    },

    resolvePromotions: noPromotions,

    async reserveInventory(input): Promise<Reservation> {
      const raw = record(
        await service('reserve_inventory_for_slug', {
          p_store_slug: input.storeSlug,
          p_reference_key: input.referenceKey,
          p_items: itemPayload(input.items),
          p_ttl_seconds: input.ttlSeconds,
        }),
      )
      return {
        reservationId: text(raw, 'reservation_id'),
        token: text(raw, 'token'),
        expiresAt: text(raw, 'expires_at'),
        created: raw.created !== false,
      }
    },

    validateDelivery: alwaysDeliverable,

    authorizePayment: noPaymentGateway,

    async placeOrder(input): Promise<PlacedOrder> {
      const raw = record(
        await service('checkout_place_order', {
          p_intent_id: input.intentId,
          p_customer_email: input.request.customerEmail,
          p_items: itemPayload(input.request.items),
          p_customer_name: input.request.customerName,
          p_customer_phone: input.request.customerPhone,
          p_shipping_address: input.request.shippingAddress,
          p_notes: input.request.notes,
          p_reservation_token: input.reservationToken,
          p_payment:
            input.payment.status === 'not_required'
              ? null
              : {
                  status: input.payment.status,
                  provider_code: input.payment.providerCode,
                  provider_reference: input.payment.providerReference,
                },
        }),
      )
      return {
        orderId: text(raw, 'order_id'),
        orderNumber: text(raw, 'order_number'),
        accessToken: nullableText(raw, 'access_token'),
        status: text(raw, 'status'),
        currency: text(raw, 'currency'),
        subtotal: text(raw, 'subtotal', '0.00'),
        taxTotal: text(raw, 'tax_total', '0.00'),
        grandTotal: text(raw, 'grand_total', '0.00'),
        items: Array.isArray(raw.items) ? (raw.items as Record<string, unknown>[]) : [],
        replay: raw.replay === true,
      }
    },

    async releaseReservation(storeSlug: string, token: string) {
      await service('release_inventory_by_token', {
        p_store_slug: storeSlug,
        p_token: token,
      })
    },

    voidPayment: noPaymentVoid,
  }
}
