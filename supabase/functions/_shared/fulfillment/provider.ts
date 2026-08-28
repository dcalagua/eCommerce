/**
 * `ShippingProvider` — el contrato canónico de un operador logístico (P12-SaaS).
 *
 * Es la versión de servidor de `src/domain/ports/fulfillment.ts`: el mismo
 * contrato, escrito donde de verdad se ejecuta. El del navegador describe la
 * frontera para el mapa de dominios; este la implementa.
 *
 * ## Lo que este archivo decide, y cuesta caro revertir
 *
 * 1. **Las capacidades son datos, no `typeof provider.track === 'function'`.**
 *    Un operador que no emite etiqueta declara `label: false` y quien lo usa lo
 *    sabe *antes* de llamarlo, no por un `TypeError` a mitad de un despacho. Es
 *    la misma decisión que `PaymentProvider` (P09) y por la misma razón.
 * 2. **El estado de seguimiento es CANÓNICO, siempre.** El adaptador traduce;
 *    el dominio no aprende la jerga de nadie. `providerStatus` viaja al lado,
 *    sin normalizar, para poder citarlo al llamar al operador — pero no decide
 *    nada. Sin esta separación, la pantalla del backoffice acabaría con un
 *    `switch` por transportista.
 * 3. **Los importes viajan como TEXTO decimal.** `12.30` en `number` es
 *    `12.299999999999999`. Nunca un `number` en la ruta del dinero: misma regla
 *    que el motor de precios (P04) y que el contrato de pasarela (P09).
 * 4. **Ninguna marca en un tipo.** El nombre del operador vive en el `code` de
 *    `integration_providers`, que es una fila. Un `type Carrier = 'dhl' | ...`
 *    obligaría a desplegar la aplicación para dar de alta un transportista.
 * 5. **`timeout` es un resultado de primera clase.** No es un `failed` con otro
 *    texto: un tiempo agotado NO dice que no se emitió la guía, dice que no se
 *    sabe, y de esa diferencia depende si se reintenta —y se paga dos veces— o
 *    si se consulta el estado.
 *
 * ## Lo que este contrato deja fuera a propósito
 *
 * **La elección del centro desde el que sale la mercancía.** Eso es
 * `ebim.select_warehouse` y la regla configurable del método: un transportista
 * no sabe de dónde tiene que salir el paquete, y preguntárselo sería darle una
 * decisión de negocio que no es suya.
 *
 * **El precio que se le cobra al comprador.** El operador puede decir cuánto
 * cobra ÉL (`cost`), y eso se guarda en `shipments.cost`; lo que paga el
 * comprador lo decide `ebim.delivery_options` con la tarifa del comercio. Son
 * dos cifras distintas y su diferencia es el margen de envío.
 */

/** Operaciones canónicas. Mismo vocabulario que `integration_providers.capabilities`. */
export type ShippingOperation = 'create' | 'track' | 'cancel' | 'label' | 'webhook'

export interface ShippingProviderCapabilities {
  /** Emitir el envío y obtener guía. */
  readonly create: boolean
  /** Consultar el histórico por guía. Es lo que salva un `timeout`. */
  readonly track: boolean
  readonly cancel: boolean
  /** Devuelve una referencia de etiqueta imprimible. */
  readonly label: boolean
  /** Avisa por webhook firmado. */
  readonly webhook: boolean
}

/**
 * Estados CANÓNICOS de seguimiento. Copia exacta del enum
 * `public.tracking_status`; el comando `shipment_track_ingest` rechaza
 * cualquier otro valor, así que una divergencia entre esta lista y la base sale
 * como error de dominio y no como una fila mal guardada.
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
  /** No mueve nada. Existe para no tener que inventarle un estado a un aviso informativo. */
  'info',
] as const
export type TrackingStatus = (typeof TRACKING_STATUSES)[number]

export function isTrackingStatus(value: string): value is TrackingStatus {
  return (TRACKING_STATUSES as readonly string[]).includes(value)
}

export interface ShipmentAddress {
  readonly line1: string
  readonly line2?: string | null
  readonly city?: string | null
  readonly region?: string | null
  readonly postalCode?: string | null
  /** ISO 3166-1 alpha-2. */
  readonly country: string
  readonly contactName?: string | null
  readonly contactPhone?: string | null
}

export interface ShipmentLine {
  readonly sku: string
  readonly name: string
  readonly quantity: number
  /** Decimal como texto, o `null` cuando el catálogo no lo declara. Nunca cero por defecto. */
  readonly weight: string | null
}

export interface CreateShipmentInput {
  /** Identificador del envío en ESTE sistema, no en el operador. */
  readonly shipmentId: string
  readonly fulfillmentId: string
  readonly orderNumber: string
  /** Servicio dentro del catálogo del operador. Vocabulario suyo, no nuestro. */
  readonly serviceCode?: string | null
  /** Misma petición, misma clave, una sola guía. Viaja hasta el operador. */
  readonly idempotencyKey: string
  /** Desde dónde sale. `null` cuando el tenant no lleva almacenes. */
  readonly origin: ShipmentAddress | null
  readonly destination: ShipmentAddress
  readonly lines: readonly ShipmentLine[]
  /** Peso total, decimal como texto. `null` = no declarado, que no es cero. */
  readonly weight: string | null
  readonly currency: string
  /** Valor declarado para el seguro, si el comercio lo usa. */
  readonly declaredValue: string | null
}

export type ShipmentOutcomeStatus = 'created' | 'failed' | 'timeout'

export interface ShipmentOutcome {
  readonly status: ShipmentOutcomeStatus
  /** La guía que el comprador copia en la web del operador. */
  readonly trackingNumber: string | null
  readonly trackingUrl: string | null
  /** REFERENCIA a la etiqueta, nunca el PDF: este proceso no mueve binarios. */
  readonly labelRef: string | null
  /** Lo que cobra el OPERADOR. Decimal como texto. Distinto de lo que paga el comprador. */
  readonly cost: string | null
  readonly currency: string | null
  /** ISO `YYYY-MM-DD`. */
  readonly estimatedDelivery: string | null
  readonly errorCode: string | null
  readonly errorDetail: string | null
}

/**
 * Un hecho de seguimiento ya traducido al vocabulario canónico.
 *
 * `externalEventId` es OBLIGATORIO. Un operador que no manda identificador de
 * evento obliga al adaptador a sintetizarlo de forma determinista a partir del
 * contenido; eso es mejor que dejarlo vacío, porque con `null` la deduplicación
 * desaparecería justo para el operador que peor se porta.
 */
export interface TrackingUpdate {
  readonly externalEventId: string
  readonly status: TrackingStatus
  /** El estado del operador TAL CUAL. Se guarda para citarlo; no decide nada. */
  readonly providerStatus: string | null
  /** ISO 8601. */
  readonly occurredAt: string
  readonly description: string | null
  readonly location: string | null
  readonly payload: Record<string, unknown>
}

/**
 * Aviso entrante ya VERIFICADO. `verifyWebhook` devuelve esto o `null`; si
 * devuelve `null`, quien llama descarta y **no reintenta**: un sobre con firma
 * inválida no mejora al repetirlo.
 */
export interface ShippingWebhookEvent {
  /** Guía a la que se refiere. Es por donde se resuelve el envío —y el tenant—. */
  readonly trackingNumber: string
  readonly events: readonly TrackingUpdate[]
}

export interface ShippingProvider {
  /** Código en `integration_providers`. Un dato del catálogo, no una marca. */
  readonly code: string
  readonly capabilities: ShippingProviderCapabilities
  createShipment?(input: CreateShipmentInput): Promise<ShipmentOutcome>
  /**
   * Historial COMPLETO, no el último estado. Un comprador que pregunta «¿dónde
   * está?» quiere ver el recorrido; devolver solo el estado obliga a guardar
   * cada consulta para poder reconstruirlo.
   */
  track?(trackingNumber: string): Promise<readonly TrackingUpdate[]>
  cancelShipment?(trackingNumber: string): Promise<ShipmentOutcome>
  /** `null` si la firma no valida. Quien llama descarta, no reintenta. */
  verifyWebhook?(
    rawBody: string,
    signature: string | null,
    secret: string | null,
  ): Promise<ShippingWebhookEvent | null>
}

/** Error de dominio: se pidió a un operador algo que declara no saber hacer. */
export class ShippingCapabilityError extends Error {
  readonly code = 'OPERACION_NO_SOPORTADA'
  readonly providerCode: string
  readonly operation: ShippingOperation

  constructor(providerCode: string, operation: ShippingOperation) {
    super(`El operador "${providerCode}" no implementa la operacion "${operation}"`)
    this.name = 'ShippingCapabilityError'
    this.providerCode = providerCode
    this.operation = operation
  }
}

export function supports(provider: ShippingProvider, operation: ShippingOperation): boolean {
  switch (operation) {
    case 'create':
      return provider.capabilities.create && typeof provider.createShipment === 'function'
    case 'track':
      return provider.capabilities.track && typeof provider.track === 'function'
    case 'cancel':
      return provider.capabilities.cancel && typeof provider.cancelShipment === 'function'
    case 'label':
      return provider.capabilities.label
    case 'webhook':
      return provider.capabilities.webhook && typeof provider.verifyWebhook === 'function'
  }
}

/**
 * Exige la operación y devuelve el método. Que la capacidad declarada y el
 * método presente tengan que coincidir es deliberado: un adaptador que declara
 * `track: true` y no lo implementa es un error del adaptador, y sale aquí en
 * vez de a mitad de una consulta de estado.
 */
export function requireOperation<T>(
  provider: ShippingProvider,
  operation: ShippingOperation,
  method: T | undefined,
): T {
  if (!supports(provider, operation) || method === undefined) {
    throw new ShippingCapabilityError(provider.code, operation)
  }
  return method
}

/**
 * Estado canónico → estado del envío en la base.
 *
 * `info` devuelve `null` a propósito: un aviso informativo se registra y NO
 * mueve el envío. Traducirlo a algo para tener un valor que poner marcaría como
 * movido un envío que sigue donde estaba.
 */
export function shipmentStateFor(status: TrackingStatus): string | null {
  switch (status) {
    case 'label_created':
      return 'created'
    case 'picked_up':
      return 'picked_up'
    case 'in_transit':
      return 'in_transit'
    case 'out_for_delivery':
      return 'out_for_delivery'
    case 'delivery_attempted':
    case 'exception':
      return 'failed'
    case 'delivered':
      return 'delivered'
    case 'returned':
      return 'returned'
    case 'cancelled':
      return 'cancelled'
    case 'info':
      return null
  }
}
