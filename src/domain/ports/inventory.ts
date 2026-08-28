import type { Quantity } from '../money'

/**
 * `InventoryPort` — cuánto hay y cuánto se puede prometer.
 *
 * Por qué existe la frontera: hoy la disponibilidad es `products.stock`, un
 * entero por producto, y `create_order` lo descuenta al confirmar. Los otros
 * dos implementadores están declarados: P06 trae `on_hand` / `reserved` / ATP
 * por variante y almacén, y `integration_providers` declara `stock.read` para
 * los adaptadores de ERP, porque en un tenant que lleva el stock en su sistema
 * de gestión el stock verdadero está allí y la copia local es, como mucho, una
 * caché.
 *
 * La distinción que este contrato fija ahora, y que un entero no puede
 * expresar: **consultar disponibilidad no es reservarla**. `availability` es
 * una foto que caduca en cuanto se toma; `reserve` es lo único que impide
 * vender la misma unidad dos veces, y por eso devuelve un identificador con
 * caducidad en vez de un booleano. Sin esa separación el sobreventa depende de
 * la suerte, que es la situación actual descrita en el baseline.
 */

export interface AvailabilityRequest {
  readonly productId: string
  readonly quantity: Quantity
}

export interface Availability {
  readonly productId: string
  /**
   * Cantidad prometible (ATP). `null` significa «no se sabe»: un ERP que no
   * responde no es un stock de cero, y tratarlo como cero vacía la tienda
   * entera durante una caída ajena.
   */
  readonly availableQuantity: Quantity | null
  /** Lo que el storefront publica. Nunca la cifra: el stock exacto es interno. */
  readonly inStock: boolean
  readonly source: 'catalog' | 'warehouse' | 'erp'
}

export interface ReservationLine {
  readonly productId: string
  readonly quantity: Quantity
}

export interface Reservation {
  readonly reservationId: string
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
  reserve(lines: readonly ReservationLine[]): Promise<Reservation>

  /** Devuelve las unidades. Idempotente: soltar dos veces no libera el doble. */
  release(reservationId: string): Promise<void>

  /** Convierte la reserva en salida real cuando el pedido queda firme. */
  commit(reservationId: string): Promise<void>
}
