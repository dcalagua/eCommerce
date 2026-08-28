import type { Money, Quantity } from '../money'
import type { Provider, ProviderOperation } from './operations'

/**
 * `FulfillmentProvider` — cómo llega el pedido al comprador.
 *
 * La frontera está declarada en la base (`shipment.create`, `shipment.track`) y
 * es de las que no admiten una implementación única: cada país tiene su
 * transportista y cada tenant contrata el suyo. El dominio pide «crea un envío
 * con estas líneas a esta dirección» y quién lo lleva es configuración.
 *
 * Lo que este contrato deja fuera a propósito: la ELECCIÓN del centro desde el
 * que sale la mercancía. Eso es `InventoryPort` (P06). Un transportista no sabe
 * de dónde tiene que salir el paquete.
 */

export interface ShippingAddress {
  readonly line1: string
  readonly line2?: string
  readonly city: string
  readonly region?: string
  readonly postalCode?: string
  /** ISO 3166-1 alpha-2. */
  readonly country: string
  readonly contactName: string
  readonly contactPhone: string
}

export interface ShipmentLine {
  readonly productId: string
  readonly quantity: Quantity
}

export interface ShipmentRequest {
  readonly orderId: string
  readonly address: ShippingAddress
  readonly lines: readonly ShipmentLine[]
  /** Método elegido dentro del catálogo del proveedor. */
  readonly serviceCode?: string
  readonly idempotencyKey: string
}

export type ShipmentStatus =
  | 'created'
  | 'picked_up'
  | 'in_transit'
  | 'delivered'
  | 'failed'
  | 'returned'

export interface Shipment {
  readonly shipmentId: string
  readonly orderId: string
  readonly status: ShipmentStatus
  /** Número que el comprador copia en la web del transportista. */
  readonly trackingNumber: string | null
  readonly trackingUrl: string | null
  readonly cost: Money | null
  readonly estimatedDelivery: string | null
}

export interface TrackingEvent {
  readonly occurredAt: string
  readonly status: ShipmentStatus
  readonly description: string
  readonly location: string | null
}

export interface FulfillmentProvider extends Provider {
  createShipment(request: ShipmentRequest): Promise<Shipment>
  /**
   * Historial completo, no el último estado. Un comprador que pregunta «¿dónde
   * está?» quiere ver el recorrido; devolver solo el estado obliga a guardar
   * cada consulta para poder reconstruirlo.
   */
  track(trackingNumber: string): Promise<readonly TrackingEvent[]>
}

export const FULFILLMENT_OPERATIONS: readonly ProviderOperation[] = [
  'shipment.create',
  'shipment.track',
]
