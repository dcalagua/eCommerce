// @vitest-environment node
/**
 * P12-SaaS · el contrato canonico de OPERADOR LOGISTICO, con puertos falsos.
 *
 * Aqui no hay base de datos: se comprueba la parte del dominio que decide ANTES
 * de escribir nada —que capacidades declara un conector, que sale de un tiempo
 * agotado, que se hace con un aviso mal firmado, como se traduce la jerga de un
 * operador al vocabulario canonico— y que el ingestor llama al comando con los
 * argumentos correctos.
 *
 * ## La Definition of Done de la fase se comprueba AQUI
 *
 *   «PASS si se puede conectar un operador logistico nuevo mediante adapter.»
 *
 * El test `conectar un operador nuevo es escribir un adaptador y una linea`
 * registra un transportista que no existe en ningun sitio del repositorio y
 * recorre con el el ciclo entero —guia, seguimiento, webhook—. Si algun dia
 * hiciera falta tocar el dominio para dar de alta un operador, ese test dejaria
 * de compilar o dejaria de pasar, que es la unica forma de que la promesa siga
 * siendo cierta dentro de un ano.
 */
import { describe, expect, it } from 'vitest'
import {
  ShippingCapabilityError,
  isTrackingStatus,
  requireOperation,
  shipmentStateFor,
  supports,
  TRACKING_STATUSES,
  type ShipmentOutcome,
  type ShippingProvider,
  type TrackingUpdate,
} from '../functions/_shared/fulfillment/provider.ts'
import {
  UnknownShippingProviderError,
  deployedShippingProviders,
  hasShippingProvider,
  registerShippingProvider,
  resolveShippingProvider,
} from '../functions/_shared/fulfillment/registry.ts'
import {
  SANDBOX_CARRIER_CODE,
  createSandboxCarrier,
} from '../functions/_shared/fulfillment/sandbox.ts'
import { hmacSha256Hex } from '../functions/_shared/payments/signature.ts'
import {
  ingestTrackingWebhook,
  type TrackingWebhookPorts,
} from '../functions/_shared/fulfillment/webhook.ts'

const SHIPMENT = '33333333-3333-4333-8333-333333333333'
const FULFILLMENT = '44444444-4444-4444-8444-444444444444'
const SECRET = 'secreto-de-pruebas'

function createInput(overrides: Record<string, unknown> = {}) {
  return {
    shipmentId: SHIPMENT,
    fulfillmentId: FULFILLMENT,
    orderNumber: 'EC-20260828-00001',
    serviceCode: null,
    idempotencyKey: 'k'.repeat(32),
    origin: null,
    destination: {
      line1: 'Av. Primavera 120',
      city: 'Lima',
      region: 'Lima',
      postalCode: '15023',
      country: 'PE',
      contactName: 'Ana Compradora',
      contactPhone: '+51 999 111 222',
    },
    lines: [{ sku: 'sku-a', name: 'Silla', quantity: 1, weight: '1.000' }],
    weight: '1.000',
    currency: 'PEN',
    declaredValue: null,
    ...overrides,
  }
}

/** Anota lo que le piden a la base y contesta lo que se le diga. */
function fakePorts(canned: Record<string, unknown> = {}) {
  const calls: Array<Record<string, unknown>> = []
  const ports: TrackingWebhookPorts = {
    findShipmentByTracking(_code, tracking) {
      return Promise.resolve(tracking === 'DESCONOCIDA' ? null : { shipmentId: SHIPMENT })
    },
    ingest(args) {
      calls.push(args)
      return Promise.resolve({ accepted: 1, duplicated: 0, replay: false, status: 'in_transit', ...canned })
    },
  }
  return { ports, calls }
}

async function signedBody(body: unknown): Promise<{ raw: string; signature: string }> {
  const raw = JSON.stringify(body)
  return { raw, signature: await hmacSha256Hex(SECRET, raw) }
}

// ---------------------------------------------------------------------------

describe('el operador de pruebas es determinista', () => {
  const carrier = createSandboxCarrier({ today: '2026-08-28', transitDays: 2 })

  it('la misma entrada da SIEMPRE la misma guia', async () => {
    const first = await carrier.createShipment?.(createInput())
    const second = await carrier.createShipment?.(createInput())
    expect(first).toEqual(second)
    expect(first?.trackingNumber).toBeTruthy()
  })

  it('los decimales del peso eligen el resultado, como en cualquier entorno de pruebas', async () => {
    const rechazo = await carrier.createShipment?.(createInput({ weight: '2.010' }))
    expect(rechazo?.status).toBe('failed')
    expect(rechazo?.trackingNumber).toBeNull()

    const agotado = await carrier.createShipment?.(createInput({ weight: '2.020' }))
    // `timeout` y NO `failed`: no se sabe si la guia se emitio. Reintentar a
    // ciegas es lo que produce dos guias pagadas por el mismo paquete.
    expect(agotado?.status).toBe('timeout')
  })

  it('sin peso declarado emite guia: «no configurado» no es «el operador falla»', async () => {
    const outcome = await carrier.createShipment?.(createInput({ weight: null }))
    expect(outcome?.status).toBe('created')
  })

  it('el coste que devuelve es el del OPERADOR, no el que paga el comprador', async () => {
    const conCoste = createSandboxCarrier({ today: '2026-08-28', cost: '9.90' })
    const outcome = await conCoste.createShipment?.(createInput())
    expect(outcome?.cost).toBe('9.90')
    expect(outcome?.currency).toBe('PEN')
  })

  it('el historial de seguimiento es completo y estable', async () => {
    const events = await carrier.track?.('SBXC0001')
    expect(events?.map((e) => e.status)).toEqual(['label_created', 'in_transit'])
    // Identificadores derivados de la guia: consultar dos veces no duplica
    // nada, porque el indice unico de la base los colapsa.
    expect(events?.[0]?.externalEventId).toBe('SBXC0001:1')
  })
})

describe('las capacidades se declaran, no se adivinan', () => {
  it('un operador que no anula lo dice, y pedirlo es un error de dominio', () => {
    const parcial: ShippingProvider = {
      code: 'parcial',
      capabilities: { create: true, track: true, cancel: false, label: false, webhook: false },
      createShipment: () => Promise.resolve({} as ShipmentOutcome),
      track: () => Promise.resolve([]),
    }

    expect(supports(parcial, 'create')).toBe(true)
    expect(supports(parcial, 'cancel')).toBe(false)
    expect(() => requireOperation(parcial, 'cancel', parcial.cancelShipment)).toThrow(
      ShippingCapabilityError,
    )
    try {
      requireOperation(parcial, 'cancel', parcial.cancelShipment)
    } catch (error) {
      expect((error as ShippingCapabilityError).code).toBe('OPERACION_NO_SOPORTADA')
    }
  })

  it('declarar una capacidad sin implementarla tambien es un error, y sale aqui', () => {
    const mentiroso: ShippingProvider = {
      code: 'mentiroso',
      capabilities: { create: true, track: true, cancel: true, label: true, webhook: true },
    }
    expect(supports(mentiroso, 'track')).toBe(false)
    expect(() => requireOperation(mentiroso, 'track', mentiroso.track)).toThrow(
      ShippingCapabilityError,
    )
  })
})

describe('el vocabulario canonico', () => {
  it('es el mismo que el enum de la base', () => {
    expect([...TRACKING_STATUSES].sort()).toEqual([
      'cancelled',
      'delivered',
      'delivery_attempted',
      'exception',
      'in_transit',
      'info',
      'label_created',
      'out_for_delivery',
      'picked_up',
      'returned',
    ])
  })

  it('`info` NO mueve el envio: registrarlo no es lo mismo que aplicarlo', () => {
    expect(shipmentStateFor('info')).toBeNull()
    expect(shipmentStateFor('delivered')).toBe('delivered')
    // Un intento fallido y una incidencia acaban en el mismo sitio: el envio se
    // queda parado y alguien tiene que mirarlo.
    expect(shipmentStateFor('delivery_attempted')).toBe('failed')
    expect(shipmentStateFor('exception')).toBe('failed')
  })

  it('la jerga de un operador no es un estado', () => {
    expect(isTrackingStatus('EN RUTA')).toBe(false)
    expect(isTrackingStatus('in_transit')).toBe(true)
  })
})

describe('el registro de adaptadores', () => {
  it('un operador sin adaptador desplegado no es un «no soportado»', () => {
    expect(hasShippingProvider('operador-inexistente')).toBe(false)
    expect(() => resolveShippingProvider('operador-inexistente')).toThrow(
      UnknownShippingProviderError,
    )
    try {
      resolveShippingProvider('operador-inexistente')
    } catch (error) {
      // Es un error de DESPLIEGUE —fila dada de alta sin desplegar el
      // adaptador—, y por eso tiene codigo propio.
      expect((error as UnknownShippingProviderError).code).toBe('CONECTOR_NO_DESPLEGADO')
    }
  })

  it('el de pruebas viene desplegado', () => {
    expect(deployedShippingProviders()).toContain(SANDBOX_CARRIER_CODE)
  })

  /**
   * LA prueba de la Definition of Done. Un operador que no existe en ninguna
   * otra parte del repositorio se conecta con dos cosas: una implementacion del
   * contrato y una linea en el registro. Ni una migracion, ni un cambio en el
   * pipeline, ni un `if` en ninguna pantalla.
   */
  it('conectar un operador nuevo es escribir un adaptador y una linea', async () => {
    const eventos: TrackingUpdate[] = [
      {
        externalEventId: 'nuevo-1',
        status: 'picked_up',
        providerStatus: 'RECOGIDO-47',
        occurredAt: '2026-08-28T09:00:00.000Z',
        description: 'Recogido en origen',
        location: 'Lima',
        payload: {},
      },
    ]

    registerShippingProvider('operador-nuevo', () => ({
      code: 'operador-nuevo',
      capabilities: { create: true, track: true, cancel: false, label: false, webhook: true },
      createShipment: (input) =>
        Promise.resolve({
          status: 'created',
          trackingNumber: `NUEVO-${input.shipmentId.slice(0, 8)}`,
          trackingUrl: null,
          labelRef: null,
          cost: '12.00',
          currency: input.currency,
          estimatedDelivery: '2026-08-30',
          errorCode: null,
          errorDetail: null,
        }),
      track: () => Promise.resolve(eventos),
      // El adaptador es el UNICO que conoce la jerga del operador: aqui
      // «RECOGIDO-47» se traduce a `picked_up` y el dominio no se entera.
      verifyWebhook: (rawBody, signature) =>
        Promise.resolve(
          signature === 'firma-buena'
            ? { trackingNumber: JSON.parse(rawBody).guia as string, events: eventos }
            : null,
        ),
    }))

    const provider = resolveShippingProvider('operador-nuevo')
    const outcome = await provider.createShipment?.(createInput())
    expect(outcome?.status).toBe('created')
    expect(outcome?.trackingNumber).toBe(`NUEVO-${SHIPMENT.slice(0, 8)}`)

    const historial = await provider.track?.('NUEVO-1')
    expect(historial?.[0]?.status).toBe('picked_up')
    expect(historial?.[0]?.providerStatus).toBe('RECOGIDO-47')

    const { ports, calls } = fakePorts()
    const result = await ingestTrackingWebhook({
      providerCode: 'operador-nuevo',
      rawBody: JSON.stringify({ guia: 'NUEVO-1' }),
      signature: 'firma-buena',
      secret: SECRET,
      ports,
    })

    expect(result.accepted).toBe(true)
    expect(calls[0]?.p_shipment_id).toBe(SHIPMENT)
    // Lo que llega a la base es CANONICO; la jerga viaja al lado, sin decidir.
    const enviados = calls[0]?.p_events as Array<Record<string, unknown>>
    expect(enviados[0]?.status).toBe('picked_up')
    expect(enviados[0]?.provider_status).toBe('RECOGIDO-47')
  })
})

describe('la entrada de un aviso de operador', () => {
  it('un aviso bien firmado llega al comando con la firma marcada como verificada', async () => {
    const { raw, signature } = await signedBody({
      tracking_number: 'SBXC0001',
      events: [{ event_id: 'evt-1', status: 'in_transit', occurred_at: '2026-08-28T10:00:00Z' }],
    })
    const { ports, calls } = fakePorts()

    const result = await ingestTrackingWebhook({
      providerCode: SANDBOX_CARRIER_CODE,
      rawBody: raw,
      signature,
      secret: SECRET,
      ports,
    })

    expect(result.accepted).toBe(true)
    expect(calls[0]?.p_signature_verified).toBe(true)
    expect(calls[0]?.p_source).toBe('provider_webhook')
  })

  it('una firma que no valida se descarta y NO toca la base', async () => {
    const { raw } = await signedBody({
      tracking_number: 'SBXC0001',
      events: [{ event_id: 'evt-1', status: 'in_transit' }],
    })
    const { ports, calls } = fakePorts()

    const result = await ingestTrackingWebhook({
      providerCode: SANDBOX_CARRIER_CODE,
      rawBody: raw,
      signature: 'a'.repeat(64),
      secret: SECRET,
      ports,
    })

    expect(result).toEqual({ accepted: false, code: 'FIRMA_NO_VERIFICADA' })
    expect(calls).toHaveLength(0)
  })

  it('el cuerpo RESERIALIZADO no valida: la firma es sobre los bytes que llegaron', async () => {
    const original = { tracking_number: 'SBXC0001', events: [{ event_id: 'e', status: 'in_transit' }] }
    const { raw, signature } = await signedBody(original)
    const reserializado = JSON.stringify(JSON.parse(raw), Object.keys(original).reverse())
    const { ports } = fakePorts()

    const result = await ingestTrackingWebhook({
      providerCode: SANDBOX_CARRIER_CODE,
      rawBody: reserializado,
      signature,
      secret: SECRET,
      ports,
    })
    expect(result.accepted).toBe(false)
  })

  it('AVISO REPETIDO: el segundo sale como repeticion, no como segundo evento', async () => {
    const { raw, signature } = await signedBody({
      tracking_number: 'SBXC0001',
      events: [{ event_id: 'evt-1', status: 'in_transit' }],
    })
    const { ports } = fakePorts({ accepted: 0, duplicated: 1, replay: true })

    const result = await ingestTrackingWebhook({
      providerCode: SANDBOX_CARRIER_CODE,
      rawBody: raw,
      signature,
      secret: SECRET,
      ports,
    })

    expect(result.accepted).toBe(true)
    expect(result.accepted === true && result.replay).toBe(true)
    expect(result.accepted === true && result.duplicated).toBe(1)
  })

  it('una guia que no es de aqui no crea nada', async () => {
    const { raw, signature } = await signedBody({
      tracking_number: 'DESCONOCIDA',
      events: [{ event_id: 'evt-1', status: 'in_transit' }],
    })
    const { ports, calls } = fakePorts()

    const result = await ingestTrackingWebhook({
      providerCode: SANDBOX_CARRIER_CODE,
      rawBody: raw,
      signature,
      secret: SECRET,
      ports,
    })

    expect(result).toEqual({ accepted: false, code: 'GUIA_DESCONOCIDA' })
    expect(calls).toHaveLength(0)
  })

  it('un conector sin adaptador desplegado no se confunde con una firma mala', async () => {
    const { ports } = fakePorts()
    const result = await ingestTrackingWebhook({
      providerCode: 'no-desplegado',
      rawBody: '{}',
      signature: 'x',
      secret: SECRET,
      ports,
    })
    expect(result).toEqual({ accepted: false, code: 'CONECTOR_NO_DESPLEGADO' })
  })

  it('el aviso NUNCA declara el tenant: sale de la fila que se encuentra', async () => {
    const { raw, signature } = await signedBody({
      tracking_number: 'SBXC0001',
      organization_id: '00000000-0000-4000-8000-000000000000',
      events: [{ event_id: 'evt-1', status: 'in_transit' }],
    })
    const { ports, calls } = fakePorts()

    await ingestTrackingWebhook({
      providerCode: SANDBOX_CARRIER_CODE,
      rawBody: raw,
      signature,
      secret: SECRET,
      ports,
    })

    const enviado = JSON.stringify(calls[0])
    expect(enviado).not.toContain('organization_id')
    expect(enviado).not.toContain('company_id')
  })

  it('un evento con estado inventado se descarta y el resto sigue', async () => {
    const { raw, signature } = await signedBody({
      tracking_number: 'SBXC0001',
      events: [
        { event_id: 'evt-malo', status: 'TELEPORTADO' },
        { event_id: 'evt-bueno', status: 'in_transit' },
      ],
    })
    const { ports, calls } = fakePorts()

    const result = await ingestTrackingWebhook({
      providerCode: SANDBOX_CARRIER_CODE,
      rawBody: raw,
      signature,
      secret: SECRET,
      ports,
    })

    expect(result.accepted).toBe(true)
    const enviados = calls[0]?.p_events as Array<Record<string, unknown>>
    expect(enviados).toHaveLength(1)
    expect(enviados[0]?.external_event_id).toBe('evt-bueno')
  })

  it('sin id de evento se SINTETIZA uno determinista', async () => {
    const body = {
      tracking_number: 'SBXC0001',
      events: [{ status: 'in_transit', occurred_at: '2026-08-28T10:00:00Z' }],
    }
    const first = await signedBody(body)
    const second = await signedBody(body)
    const a = fakePorts()
    const b = fakePorts()

    await ingestTrackingWebhook({
      providerCode: SANDBOX_CARRIER_CODE,
      rawBody: first.raw,
      signature: first.signature,
      secret: SECRET,
      ports: a.ports,
    })
    await ingestTrackingWebhook({
      providerCode: SANDBOX_CARRIER_CODE,
      rawBody: second.raw,
      signature: second.signature,
      secret: SECRET,
      ports: b.ports,
    })

    const idA = (a.calls[0]?.p_events as Array<Record<string, unknown>>)[0]?.external_event_id
    const idB = (b.calls[0]?.p_events as Array<Record<string, unknown>>)[0]?.external_event_id
    // El mismo aviso reenviado produce la MISMA clave, y la base lo colapsa.
    expect(idA).toBe(idB)
    expect(String(idA)).toContain('SBXC0001')
  })
})
