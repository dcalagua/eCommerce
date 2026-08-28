/**
 * El conector `sandbox_carrier`: un operador logístico DETERMINISTA, sin cajas.
 *
 * Es el operador falso que pide el criterio de la fase —«PASS si se puede
 * conectar un operador logístico nuevo mediante adapter»— y, como el `sandbox`
 * de pagos (P09), NO vive en la carpeta de tests: vive donde vive cualquier
 * otro adaptador, se registra igual y tiene fila en `integration_providers`
 * igual. Esa es la propiedad que interesa: los tests recorren el MISMO camino
 * que la producción, no uno paralelo.
 *
 * ## Cómo se le pide un resultado concreto
 *
 * Por los DECIMALES del peso declarado, que es el análogo de los céntimos que
 * usa el sandbox de pagos y el único dato numérico que un envío siempre trae:
 *
 *   `x.01` → el operador rechaza  (`failed`)
 *   `x.02` → tiempo agotado       (`timeout`)  ← NO dice que no se emitió
 *   resto  → guía emitida
 *
 * Sin peso declarado emite guía: es el caso normal de un catálogo que todavía
 * no declara pesos, y hacerlo fallar convertiría «falta configurar» en «el
 * transportista no responde».
 *
 * Determinista de verdad: sin reloj para decidir, sin azar y sin estado entre
 * llamadas. La guía se deriva del identificador del envío, así que repetir una
 * llamada devuelve LA MISMA guía — que es lo que deja que el índice único
 * `(provider_code, tracking_number)` haga su trabajo también en las pruebas.
 */
import type {
  CreateShipmentInput,
  ShipmentOutcome,
  ShippingProvider,
  ShippingWebhookEvent,
  TrackingUpdate,
} from './provider.ts'
import { isTrackingStatus } from './provider.ts'
// La verificación HMAC es genérica —no sabe nada de pagos— y se reusa tal cual
// en vez de copiarse: dos implementaciones de una comparación en tiempo
// constante se separan el día que alguien "optimice" una de las dos.
import { verifyHmacSignature } from '../payments/signature.ts'

export const SANDBOX_CARRIER_CODE = 'sandbox_carrier'

/** Los decimales del peso, como entero de 0 a 99. Sobre TEXTO, nunca sobre float. */
function decimalsOf(weight: string | null): number {
  if (weight === null) return 0
  const match = /^-?\d+(?:\.(\d{1,3}))?$/.exec(weight.trim())
  if (!match) return 0
  return Number((match[1] ?? '0').slice(0, 2).padEnd(2, '0'))
}

/** Guía estable: mismo envío, misma guía. */
function trackingFor(shipmentId: string): string {
  return `SBXC${shipmentId.replace(/-/g, '').slice(0, 16).toUpperCase()}`
}

export interface SandboxCarrierOptions {
  /** Coste que declara el operador. Decimal como texto; nunca un `number`. */
  readonly cost?: string
  /** Días hasta la entrega estimada, contados desde `today`. */
  readonly transitDays?: number
  /**
   * «Hoy», inyectable. El sandbox no lee el reloj para DECIDIR nada; solo lo
   * necesita para componer una fecha estimada, y recibirlo es lo que hace que
   * un test de fechas no sea intermitente.
   */
  readonly today?: string
}

function addDays(iso: string, days: number): string {
  const date = new Date(`${iso}T00:00:00.000Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

function failure(code: string, detail: string, status: 'failed' | 'timeout'): ShipmentOutcome {
  return {
    status,
    trackingNumber: null,
    trackingUrl: null,
    labelRef: null,
    cost: null,
    currency: null,
    estimatedDelivery: null,
    errorCode: code,
    errorDetail: detail,
  }
}

export function createSandboxCarrier(options: SandboxCarrierOptions = {}): ShippingProvider {
  const today = options.today ?? new Date().toISOString().slice(0, 10)
  const transitDays = options.transitDays ?? 2

  return {
    code: SANDBOX_CARRIER_CODE,
    capabilities: {
      create: true,
      track: true,
      cancel: true,
      label: true,
      webhook: true,
    },

    createShipment(input: CreateShipmentInput): Promise<ShipmentOutcome> {
      const marker = decimalsOf(input.weight)
      if (marker === 1) {
        return Promise.resolve(
          failure('SBXC_RECHAZADO', 'El operador de pruebas rechazo el envio', 'failed'),
        )
      }
      if (marker === 2) {
        // `timeout` y no `failed`: no se sabe si la guía se emitió. Quien llama
        // tiene que consultar el estado, no reintentar a ciegas.
        return Promise.resolve(
          failure('SBXC_TIEMPO_AGOTADO', 'El operador de pruebas no contesto', 'timeout'),
        )
      }

      const tracking = trackingFor(input.shipmentId)
      return Promise.resolve({
        status: 'created',
        trackingNumber: tracking,
        trackingUrl: `https://sandbox.invalid/track/${tracking}`,
        labelRef: `sandbox://label/${tracking}`,
        cost: options.cost ?? '0.00',
        currency: input.currency,
        estimatedDelivery: addDays(today, transitDays),
        errorCode: null,
        errorDetail: null,
      })
    },

    track(trackingNumber: string): Promise<readonly TrackingUpdate[]> {
      // Historial completo y siempre el mismo para la misma guía: dos eventos
      // con identificador derivado de la guía, así que consultar dos veces no
      // duplica nada cuando se ingiere (el índice único los colapsa).
      return Promise.resolve([
        {
          externalEventId: `${trackingNumber}:1`,
          status: 'label_created',
          providerStatus: 'LABEL',
          occurredAt: `${today}T08:00:00.000Z`,
          description: 'Guia emitida',
          location: null,
          payload: {},
        },
        {
          externalEventId: `${trackingNumber}:2`,
          status: 'in_transit',
          providerStatus: 'TRANSIT',
          occurredAt: `${today}T12:00:00.000Z`,
          description: 'En camino',
          location: null,
          payload: {},
        },
      ])
    },

    cancelShipment(trackingNumber: string): Promise<ShipmentOutcome> {
      return Promise.resolve({
        status: 'created',
        trackingNumber,
        trackingUrl: null,
        labelRef: null,
        cost: null,
        currency: null,
        estimatedDelivery: null,
        errorCode: null,
        errorDetail: null,
      })
    },

    /**
     * El sobre del sandbox es JSON con `tracking_number` y una lista de
     * eventos ya canónicos. Un operador real traduciría aquí su jerga; este no
     * tiene jerga que traducir, y por eso el adaptador es corto: lo que la fase
     * demuestra no es que este conector sea listo, es que el DOMINIO no
     * necesita saber nada de él.
     */
    async verifyWebhook(
      rawBody: string,
      signature: string | null,
      secret: string | null,
    ): Promise<ShippingWebhookEvent | null> {
      if (!(await verifyHmacSignature({ rawBody, signature, secret }))) return null

      let parsed: unknown
      try {
        parsed = JSON.parse(rawBody)
      } catch {
        return null
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null

      const body = parsed as Record<string, unknown>
      const tracking = typeof body.tracking_number === 'string' ? body.tracking_number.trim() : ''
      if (tracking === '') return null

      const raw = Array.isArray(body.events) ? body.events : []
      const events: TrackingUpdate[] = []
      for (const item of raw) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) continue
        const entry = item as Record<string, unknown>
        const status = typeof entry.status === 'string' ? entry.status.trim().toLowerCase() : ''
        if (!isTrackingStatus(status)) continue
        const occurredAt =
          typeof entry.occurred_at === 'string' ? entry.occurred_at : new Date().toISOString()
        // Sin identificador de evento se SINTETIZA de forma determinista: el
        // mismo aviso reenviado produce la misma clave y la base lo colapsa.
        const externalEventId =
          typeof entry.event_id === 'string' && entry.event_id.trim() !== ''
            ? entry.event_id.trim()
            : `${tracking}:${status}:${occurredAt}`

        events.push({
          externalEventId: externalEventId.slice(0, 200),
          status,
          providerStatus: typeof entry.provider_status === 'string' ? entry.provider_status : null,
          occurredAt,
          description: typeof entry.description === 'string' ? entry.description : null,
          location: typeof entry.location === 'string' ? entry.location : null,
          payload: {},
        })
      }

      if (events.length === 0) return null
      return { trackingNumber: tracking, events }
    },
  }
}
