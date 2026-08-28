import type { Money, Quantity } from '../money'
import type { Provider, ProviderOperation } from './operations'

/**
 * `FulfillmentProvider` — cómo llega el pedido al comprador.
 *
 * La frontera está declarada en la base (`shipment.create`, `shipment.track`,
 * `shipment.cancel`) y es de las que no admiten una implementación única: cada
 * país tiene su transportista y cada tenant contrata el suyo. El dominio pide
 * «crea un envío con estas líneas a esta dirección» y quién lo lleva es
 * configuración —una fila de `integration_providers`, no un tipo—.
 *
 * ## Lo que este contrato deja fuera, y por qué
 *
 * **La ELECCIÓN del centro desde el que sale la mercancía.** Eso es
 * `InventoryPort` más la regla configurable del método
 * (`delivery_methods.sourcing`, P12): un transportista no sabe de dónde tiene
 * que salir el paquete, y preguntárselo sería darle una decisión de negocio
 * que no es suya.
 *
 * **El precio que se le cobra al comprador.** El operador dice cuánto cobra ÉL
 * (`Shipment.cost`); lo que paga el comprador lo decide el motor de tarifas del
 * comercio en el servidor. Son dos cifras distintas y su diferencia es el
 * margen de envío: con una sola columna no se podría calcular.
 *
 * ## Por qué el estado de seguimiento es canónico
 *
 * Cada operador tiene su jerga —«EN RUTA», `OUT_FOR_DEL`, código 47— y ninguna
 * entra en el dominio como estado: el adaptador traduce a `TrackingStatus` y
 * deja la suya al lado, sin normalizar, para poder citarla al llamar al
 * operador. Sin esa separación, cada pantalla acabaría con un `switch` por
 * transportista.
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

/**
 * Ciclo del BULTO. No es el de la promesa de entrega: un fulfillment puede
 * seguir en camino con su primer envío ya devuelto y el segundo recién creado.
 */
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
  /** Lo que cobra el OPERADOR, no lo que paga el comprador. */
  readonly cost: Money | null
  readonly estimatedDelivery: string | null
}

/**
 * Vocabulario CANÓNICO de seguimiento. Espejo del enum
 * `public.tracking_status`; el adaptador traduce a esto y nunca al revés.
 *
 * `info` existe para que un aviso que no mueve nada —«documentación
 * recibida»— se pueda registrar sin inventarle un estado que sí mueve.
 */
export const TRACKING_STATUSES = [
  'label_created',
  'picked_up',
  'in_transit',
  'out_for_delivery',
  'delivery_attempted',
  'delivered',
  'exception',
  'returned',
  'cancelled',
  'info',
] as const
export type TrackingStatus = (typeof TRACKING_STATUSES)[number]

export interface TrackingEvent {
  /**
   * Identificador del evento DEL LADO DEL OPERADOR. Es lo que hace idempotente
   * la ingesta: el mismo aviso reenviado veinte veces es una sola fila. Un
   * operador que no lo manda obliga al adaptador a sintetizarlo de forma
   * determinista; dejarlo vacío haría desaparecer la deduplicación justo para
   * el operador que peor se porta.
   */
  readonly externalEventId: string
  readonly occurredAt: string
  readonly status: TrackingStatus
  /** El estado del operador TAL CUAL. Se guarda para citarlo; no decide nada. */
  readonly providerStatus: string | null
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
  /**
   * Anular una guía ya emitida. Opcional en la práctica —no todos los
   * operadores lo ofrecen y algunos ya la han cobrado—, y por eso es una
   * operación propia de `integration_providers.capabilities` y no una bandera
   * de `shipment.create`.
   */
  cancelShipment?(trackingNumber: string): Promise<Shipment>
}

export const FULFILLMENT_OPERATIONS: readonly ProviderOperation[] = [
  'shipment.create',
  'shipment.track',
  'shipment.cancel',
]
