import type { Quantity } from '../money'

/**
 * `InventoryPort` — cuánto hay y cuánto se puede prometer.
 *
 * Por qué existe la frontera: hasta P06 la disponibilidad era `products.stock`,
 * un entero por producto, y `create_order` lo descontaba al confirmar. Los
 * otros dos implementadores estaban declarados y ahora uno de ellos existe:
 * P06-SaaS trae `on_hand` / `reserved` / ATP por variante y almacén, y
 * `integration_providers` sigue declarando `stock.read` para los adaptadores de
 * ERP, porque en un tenant que lleva el stock en su sistema de gestión el stock
 * verdadero está allí y la copia local es, como mucho, una caché.
 *
 * La distinción que este contrato fija, y que un entero no puede expresar:
 * **consultar disponibilidad no es reservarla**. `availability` es una foto que
 * caduca en cuanto se toma; `reserve` es lo único que impide vender la misma
 * unidad dos veces, y por eso devuelve un identificador con caducidad en vez de
 * un booleano.
 *
 * ## Las tres formas de no tener una cifra, y por qué no son la misma
 *
 * Un `availableQuantity` a `null` NUNCA se lee como cero. Puede significar dos
 * cosas distintas y el campo `unknown` las separa:
 *
 *  - `unknown: true`  — la fuente no lo sabe. Un ERP que no responde no vació
 *    el almacén; tratarlo como cero vacía la tienda entera durante una caída
 *    ajena. Lo correcto es no prometer, no negar.
 *  - `unknown: false` — esta implementación no PUBLICA la cifra. Es el caso de
 *    la vitrina: el comprador recibe el semáforo, no el número, porque la
 *    existencia exacta es información competitiva del tenant.
 *
 * En los dos casos lo que decide si se puede comprar es `inStock`, que ya viene
 * calculado para la cantidad pedida.
 */

export interface AvailabilityRequest {
  readonly productId: string
  /** Obligatorio cuando el producto se vende por variantes. */
  readonly variantId?: string | null
  readonly quantity: Quantity
}

export interface Availability {
  readonly productId: string
  readonly variantId: string | null
  /**
   * Cantidad prometible (ATP), o `null` cuando no hay cifra. Ver la nota de
   * arriba: `null` nunca es cero.
   */
  readonly availableQuantity: Quantity | null
  /** La fuente no pudo confirmar la cifra. Distinto de «no hay». */
  readonly unknown: boolean
  /** Lo que el storefront publica, ya resuelto para la cantidad pedida. */
  readonly inStock: boolean
  readonly source: 'catalog' | 'warehouse' | 'erp'
}

export interface ReservationLine {
  readonly productId: string
  readonly variantId?: string | null
  /** Presentación de venta. La conversión a unidades base la hace el servidor. */
  readonly uomCode?: string | null
  readonly quantity: Quantity
}

export interface ReservationRequest {
  /**
   * Idempotencia de NEGOCIO: el carrito, el pedido, el evento externo. Reservar
   * dos veces con la misma clave devuelve la misma reserva en vez de
   * comprometer el doble. Sin ella, un reintento de red vacía el almacén.
   */
  readonly referenceKey: string
  readonly lines: readonly ReservationLine[]
  /** Cuánto vive la reserva. La implementación impone un mínimo y un máximo. */
  readonly ttlSeconds?: number
}

export interface Reservation {
  readonly reservationId: string
  /**
   * Secreto de portador con el que el checkout reclama ESTA reserva. Existe
   * porque un identificador de fila es enumerable y una reserva ajena no se
   * puede poder consumir; el mismo patrón que el token de pedido.
   */
  readonly claimToken: string
  readonly lines: readonly ReservationLine[]
  /** Cuándo deja de valer. Una reserva sin caducidad es stock perdido. */
  readonly expiresAt: string
}

export interface InventoryPort {
  /** Foto de disponibilidad. No compromete nada. */
  availability(request: readonly AvailabilityRequest[]): Promise<readonly Availability[]>

  /**
   * Compromete unidades. Atómica sobre el conjunto: o entran todas las líneas o
   * no entra ninguna. Media reserva es un carrito que el comprador cree cerrado
   * y no lo está.
   */
  reserve(request: ReservationRequest): Promise<Reservation>

  /** Devuelve las unidades. Idempotente: soltar dos veces no libera el doble. */
  release(reservationId: string): Promise<void>

  /** Convierte la reserva en salida real cuando el pedido queda firme. */
  commit(reservationId: string): Promise<void>
}
