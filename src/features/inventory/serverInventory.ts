import type {
  Availability,
  AvailabilityRequest,
  InventoryPort,
  Reservation,
  ReservationRequest,
} from '@/domain'
import {
  commitReservation,
  fetchAvailability,
  fetchPublicAvailability,
  releaseReservation,
  reserveStock,
  type AvailabilityItem,
} from './api'

/**
 * `InventoryPort` sobre el motor de la base (P06-SaaS).
 *
 * Hay **dos** implementaciones y esa es exactamente la razón por la que el
 * puerto existía desde P01 (`src/domain/ports/index.ts`: «un puerto existe
 * cuando hay una segunda implementación ya declarada»). No son dos capas de la
 * misma cosa: responden a dos preguntas distintas hechas por dos actores con
 * dos autorizaciones distintas.
 *
 * | | `backofficeInventory` | `storefrontInventory` |
 * |---|---|---|
 * | Quién pregunta | miembro de la sociedad | comprador anónimo |
 * | Cómo se resuelve la tienda | por `store_id` + membresía | por el slug de la URL |
 * | Qué recibe | la cifra exacta | solo el semáforo |
 * | Puede reservar | sí (venta asistida) | no desde el navegador |
 *
 * Lo que ninguna de las dos hace: **calcular**. Traducen la forma del
 * transporte a la del dominio y nada más. Cualquier resta o comparación de
 * cantidades que apareciera aquí sería un segundo sitio donde la
 * disponibilidad puede salir distinta de la que el pedido va a aplicar.
 *
 * El tercer implementador —el adaptador de ERP contra `stock.read`— entra por
 * el servidor (`sync_inventory_level`), no por el navegador: el bundle no habla
 * con el sistema de gestión del tenant.
 */

function toItem(request: AvailabilityRequest): AvailabilityItem {
  const item: AvailabilityItem = { product_id: request.productId, quantity: request.quantity }
  if (request.variantId) item.variant_id = request.variantId
  return item
}

export interface StoreScopedInventory {
  /** Contexto de tienda ya resuelto por quien construye el adaptador. */
  readonly storeId: string
}

/**
 * Adaptador del BACKOFFICE. Devuelve cantidades porque quien pregunta ya puede
 * leer `inventory_levels` por RLS: esconder la cifra aquí no protegería nada y
 * dejaría al operador adivinando.
 */
export function backofficeInventory(scope: StoreScopedInventory): InventoryPort {
  return {
    async availability(request: readonly AvailabilityRequest[]): Promise<readonly Availability[]> {
      const rows = await fetchAvailability({
        storeId: scope.storeId,
        items: request.map(toItem),
      })
      return rows.map((row) => ({
        productId: row.product_id,
        variantId: row.variant_id,
        // `unknown` gana sobre la cifra: quien no sabe no promete, y una cota
        // inferior presentada como dato exacto es peor que no dar dato.
        availableQuantity: row.unknown ? null : row.available,
        unknown: row.unknown,
        inStock: row.in_stock,
        source: row.source,
      }))
    },

    async reserve(request: ReservationRequest): Promise<Reservation> {
      const result = await reserveStock({
        storeId: scope.storeId,
        referenceKey: request.referenceKey,
        items: request.lines.map((line) => ({
          product_id: line.productId,
          variant_id: line.variantId ?? null,
          uom_code: line.uomCode ?? null,
          quantity: line.quantity,
        })),
        ...(request.ttlSeconds !== undefined ? { ttlSeconds: request.ttlSeconds } : {}),
      })

      return {
        reservationId: result.reservation_id,
        claimToken: result.token,
        expiresAt: result.expires_at,
        lines: result.lines.map((line) => ({
          productId: line.product_id,
          variantId: line.variant_id,
          quantity: line.quantity,
        })),
      }
    },

    async release(reservationId: string): Promise<void> {
      await releaseReservation({ id: reservationId })
    },

    async commit(reservationId: string): Promise<void> {
      await commitReservation({ id: reservationId })
    },
  }
}

export interface PublicScopedInventory {
  /** Slug de la URL pública. La tienda la resuelve el servidor a partir de él. */
  readonly storeSlug: string
}

/**
 * Adaptador de la VITRINA. `availableQuantity` es siempre `null` y `unknown`
 * dice si es porque la fuente no lo sabe: la cifra exacta no sale a `anon` en
 * ninguna circunstancia (es información competitiva del tenant y además
 * envejece antes de llegar al navegador). Lo que decide si se puede comprar es
 * `inStock`, ya resuelto para la cantidad pedida.
 *
 * `reserve` / `release` / `commit` no existen desde el navegador anónimo: las
 * abre el servidor (`reserve_inventory_for_slug`) porque una reserva que el
 * cliente puede pedir en bucle es una forma de vaciar una tienda sin comprar
 * nada. El carrito de P07 las llamará desde su Edge Function.
 */
export function storefrontInventory(scope: PublicScopedInventory) {
  return {
    async availability(request: readonly AvailabilityRequest[]): Promise<readonly Availability[]> {
      const rows = await fetchPublicAvailability({
        storeSlug: scope.storeSlug,
        items: request.map(toItem),
      })
      return rows.map((row) => ({
        productId: row.product_id,
        variantId: row.variant_id,
        availableQuantity: null,
        unknown: row.unknown,
        inStock: row.in_stock,
        source: row.source,
      }))
    },
  }
}
