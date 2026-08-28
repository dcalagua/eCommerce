// @vitest-environment node
/**
 * El orquestador del checkout, con puertos falsos.
 *
 * Aquí no hay base de datos y es a propósito: lo que se prueba es la **máquina**
 * —el orden de las etapas, la idempotencia, las compensaciones y qué error sale
 * de cada sitio—, y esa lógica tiene que poder ejercitarse sin levantar
 * Postgres. Lo que sí toca la base se prueba en `checkout-pipeline.test.ts`
 * contra el esquema real; las dos mitades juntas cubren la fase.
 *
 * Cada test declara solo el puerto que le importa y hereda el resto de un
 * conjunto que funciona. Es la forma de que «fallar al reservar» sea un test de
 * tres líneas y no una fixtura de treinta.
 */
import { describe, expect, it, vi } from 'vitest'

import { CheckoutStageError } from '../functions/_shared/checkout/errors.ts'
import { CHECKOUT_STAGES, type CheckoutStage } from '../functions/_shared/checkout/stages.ts'
import { runCheckout, type CheckoutInput } from '../functions/_shared/checkout/pipeline.ts'
import {
  alwaysDeliverable,
  noPaymentGateway,
  noPaymentVoid,
  noPromotions,
} from '../functions/_shared/checkout/hooks.ts'
import type { CheckoutPorts, PlacedOrder, Quote } from '../functions/_shared/checkout/ports.ts'
import { requestHash } from '../functions/_shared/checkout/request.ts'

const INTENT = '11111111-1111-4111-8111-111111111111'
const PRODUCT = '22222222-2222-4222-8222-222222222222'
const ORDER = '33333333-3333-4333-8333-333333333333'

const QUOTE: Quote = {
  currency: 'PEN',
  channelCode: 'b2c',
  taxInclusive: false,
  lines: [
    {
      productId: PRODUCT,
      variantId: null,
      uomCode: null,
      name: 'Silla',
      quantity: 2,
      unitPrice: '100.00',
      netAmount: '200.00',
      taxRate: '0.18',
      source: 'catalog',
      priceListCode: null,
      scope: null,
    },
  ],
  subtotal: '200.00',
  taxTotal: '36.00',
  grandTotal: '236.00',
}

const ORDER_RESULT: PlacedOrder = {
  orderId: ORDER,
  orderNumber: 'EC-20260828-00001',
  accessToken: 'a'.repeat(64),
  status: 'pending',
  currency: 'PEN',
  subtotal: '200.00',
  taxTotal: '36.00',
  grandTotal: '236.00',
  items: [],
  replay: false,
}

function input(overrides: Partial<CheckoutInput> = {}): CheckoutInput {
  return {
    storeSlug: 'tienda-a',
    idempotencyKey: 'k'.repeat(32),
    requestHash: 'f'.repeat(64),
    cartToken: 'c'.repeat(64),
    customerName: 'Ana Compradora',
    customerEmail: 'ana@compradora.com',
    customerPhone: '+51 999 111 222',
    shippingAddress: { address: 'Av. Primavera 120' },
    notes: null,
    items: [{ product_id: PRODUCT, quantity: 2 }],
    ...overrides,
  }
}

/** Registro de lo que el pipeline fue haciendo, en orden. */
interface Recorder {
  stages: CheckoutStage[]
  released: string[]
  voided: number
  failures: Array<{ stage: CheckoutStage; code: string; detail: string }>
}

function ports(
  overrides: Partial<CheckoutPorts> = {},
): { ports: CheckoutPorts; log: Recorder } {
  const log: Recorder = { stages: [], released: [], voided: 0, failures: [] }

  const base: CheckoutPorts = {
    begin: () =>
      Promise.resolve({ intentId: INTENT, replay: false, attempt: 1, result: null }),
    markStage: (_id, stage) => {
      log.stages.push(stage)
      return Promise.resolve()
    },
    failIntent: (_id, stage, code, detail) => {
      log.failures.push({ stage, code, detail })
      return Promise.resolve()
    },
    resolveContext: (storeSlug) =>
      Promise.resolve({
        storeSlug,
        storeName: 'Tienda A',
        currency: 'PEN',
        channelCode: 'b2c',
        channelKind: 'b2c',
        requiresAuth: false,
        taxInclusive: false,
      }),
    resolveAccount: () =>
      Promise.resolve({ hasSession: false, accountId: null, role: null, spendingLimit: null }),
    resolvePrices: () => Promise.resolve(QUOTE),
    resolvePriceDrift: () => Promise.resolve({ changed: [] }),
    resolvePromotions: noPromotions,
    reserveInventory: () =>
      Promise.resolve({
        reservationId: 'res-1',
        token: 'r'.repeat(64),
        expiresAt: '2026-08-28T00:15:00Z',
        created: true,
      }),
    validateDelivery: alwaysDeliverable,
    authorizePayment: noPaymentGateway,
    placeOrder: () => Promise.resolve(ORDER_RESULT),
    releaseReservation: (_slug, token) => {
      log.released.push(token)
      return Promise.resolve()
    },
    voidPayment: () => {
      log.voided += 1
      return noPaymentVoid({
        status: 'not_required',
        providerCode: null,
        providerReference: null,
        providerMessage: null,
      })
    },
    ...overrides,
  }

  return { ports: base, log }
}

async function expectStageFailure(
  run: () => Promise<unknown>,
): Promise<CheckoutStageError> {
  try {
    await run()
  } catch (error) {
    expect(error).toBeInstanceOf(CheckoutStageError)
    return error as CheckoutStageError
  }
  throw new Error('Se esperaba un fallo del pipeline y la operacion tuvo exito')
}

describe('el camino feliz', () => {
  it('recorre las once etapas en el orden declarado', async () => {
    const { ports: p, log } = ports()

    const result = await runCheckout(p, input())

    expect(result.ok).toBe(true)
    expect(result.order.orderNumber).toBe('EC-20260828-00001')
    // `markStage` se llama una vez por etapa, más la anotación del token de la
    // reserva (que repite `reserve_inventory` a propósito: es la que graba el
    // secreto en el intento).
    expect(log.stages.filter((stage, index) => log.stages.indexOf(stage) === index)).toEqual([
      ...CHECKOUT_STAGES,
    ])
    expect(result.stagesRun).toEqual([...CHECKOUT_STAGES])
  })

  it('el token de la reserva se anota en el intento antes de crear el pedido', async () => {
    const marks: Array<[CheckoutStage, string | undefined]> = []
    const { ports: p } = ports({
      markStage: (_id, stage, token) => {
        marks.push([stage, token])
        return Promise.resolve()
      },
    })

    await runCheckout(p, input())

    // Sin esta anotación, un proceso que muriera aquí dejaría existencia
    // apartada que nadie sabría soltar hasta que caducara sola.
    expect(marks).toContainEqual(['reserve_inventory', 'r'.repeat(64)])
  })

  it('sin pasarela el cobro no se inventa: queda como «no requerido»', async () => {
    const { ports: p } = ports()
    const result = await runCheckout(p, input())
    expect(result.payment?.status).toBe('not_required')
  })
})

describe('idempotencia', () => {
  it('un reintento devuelve el MISMO pedido y no toca nada más', async () => {
    const reserve = vi.fn()
    const place = vi.fn()
    const { ports: p, log } = ports({
      begin: () =>
        Promise.resolve({
          intentId: INTENT,
          replay: true,
          attempt: 2,
          result: {
            order_id: ORDER,
            order_number: 'EC-20260828-00001',
            access_token: 'a'.repeat(64),
            status: 'pending',
            currency: 'PEN',
            subtotal: '200.00',
            tax_total: '36.00',
            grand_total: '236.00',
            items: [],
          },
        }),
      reserveInventory: reserve as unknown as CheckoutPorts['reserveInventory'],
      placeOrder: place as unknown as CheckoutPorts['placeOrder'],
    })

    const result = await runCheckout(p, input())

    expect(result.replay).toBe(true)
    expect(result.order.orderNumber).toBe('EC-20260828-00001')
    // Ni una etapa, ni una reserva, ni un pedido: la petición repetida no
    // vuelve a apartar existencia ni a cobrar.
    expect(log.stages).toEqual([])
    expect(reserve).not.toHaveBeenCalled()
    expect(place).not.toHaveBeenCalled()
  })

  it('dos peticiones concurrentes con la misma clave: la segunda no ejecuta', async () => {
    // Es lo que hace `checkout_begin` cuando encuentra un intento vivo.
    const { ports: p } = ports({
      begin: () =>
        Promise.reject(
          new Error('CHECKOUT_EN_CURSO: ese intento de compra todavia se esta procesando'),
        ),
    })

    const error = await expectStageFailure(() => runCheckout(p, input()))
    expect(error.code).toBe('CHECKOUT_EN_CURSO')
    expect(error.status).toBe(409)
    // Este SÍ se puede reintentar: el otro intento va a terminar.
    expect(error.retryable).toBe(true)
  })

  it('la misma clave con otra petición es un error explícito, no una compra', async () => {
    const { ports: p } = ports({
      begin: () =>
        Promise.reject(
          new Error('IDEMPOTENCIA_EN_CONFLICTO: esa clave ya se uso para una peticion distinta'),
        ),
    })

    const error = await expectStageFailure(() => runCheckout(p, input()))
    expect(error.code).toBe('IDEMPOTENCIA_EN_CONFLICTO')
    expect(error.retryable).toBe(false)
  })
})

describe('el resumen de la peticion', () => {
  it('el mismo carrito en otro orden da el MISMO resumen', async () => {
    const a = await requestHash({
      storeSlug: 'tienda-a',
      items: [
        { product_id: PRODUCT, quantity: 2 },
        { product_id: '44444444-4444-4444-8444-444444444444', quantity: 1 },
      ],
      customerEmail: 'ana@compradora.com',
      customerName: 'Ana',
      customerPhone: '+51 999',
      shippingAddress: { address: 'Av. Primavera 120' },
      notes: null,
    })
    const b = await requestHash({
      storeSlug: 'TIENDA-A',
      items: [
        { product_id: '44444444-4444-4444-8444-444444444444', quantity: 1 },
        { product_id: PRODUCT, quantity: 2 },
      ],
      customerEmail: 'ANA@compradora.com',
      customerName: 'Ana',
      customerPhone: '+51 999',
      shippingAddress: { address: 'Av. Primavera 120' },
      notes: null,
    })
    // Si esto fallara, el reintento del navegador —que reserializa— se leería
    // como una petición distinta y crearía el segundo pedido.
    expect(a).toBe(b)
  })

  it('cambiar una cantidad cambia el resumen', async () => {
    const base = {
      storeSlug: 'tienda-a',
      customerEmail: 'ana@compradora.com',
      customerName: 'Ana',
      customerPhone: '+51 999',
      shippingAddress: { address: 'Av. Primavera 120' },
      notes: null,
    }
    const a = await requestHash({ ...base, items: [{ product_id: PRODUCT, quantity: 2 }] })
    const b = await requestHash({ ...base, items: [{ product_id: PRODUCT, quantity: 3 }] })
    expect(a).not.toBe(b)
  })
})

describe('el precio cambiado', () => {
  it('detiene la compra UNA vez y no aparta existencia', async () => {
    const reserve = vi.fn()
    const { ports: p, log } = ports({
      resolvePriceDrift: () =>
        Promise.resolve({
          changed: [
            { productId: PRODUCT, variantId: null, uomCode: null, was: '100.00', now: '120.00' },
          ],
        }),
      reserveInventory: reserve as unknown as CheckoutPorts['reserveInventory'],
    })

    const error = await expectStageFailure(() => runCheckout(p, input()))

    expect(error.code).toBe('PRECIO_CAMBIADO')
    expect(error.stage).toBe('resolve_prices')
    // Falla ANTES de reservar: parar en la etapa 3 no deja existencia
    // comprometida esperando a que el comprador decida.
    expect(reserve).not.toHaveBeenCalled()
    expect(log.released).toEqual([])
    expect(log.failures[0]?.stage).toBe('resolve_prices')
  })

  it('aceptado por el comprador, la compra pasa', async () => {
    const { ports: p } = ports({
      resolvePriceDrift: () =>
        Promise.resolve({
          changed: [
            { productId: PRODUCT, variantId: null, uomCode: null, was: '100.00', now: '120.00' },
          ],
        }),
    })

    const result = await runCheckout(p, input({ acceptPriceChanges: true }))
    expect(result.ok).toBe(true)
  })

  it('sin carrito de servidor no se compara nada, y no se inventa un cambio', async () => {
    const drift = vi.fn()
    const { ports: p } = ports({
      resolvePriceDrift: drift as unknown as CheckoutPorts['resolvePriceDrift'],
    })

    const result = await runCheckout(p, input({ cartToken: null }))

    expect(result.ok).toBe(true)
    expect(drift).not.toHaveBeenCalled()
  })
})

describe('lo que falla, y lo que se deshace', () => {
  it('stock insuficiente: falla en su etapa y no crea pedido', async () => {
    const place = vi.fn()
    const { ports: p, log } = ports({
      reserveInventory: () =>
        Promise.reject(new Error('STOCK_INSUFICIENTE: SKU-1 (no hay existencia suficiente)')),
      placeOrder: place as unknown as CheckoutPorts['placeOrder'],
    })

    const error = await expectStageFailure(() => runCheckout(p, input()))

    expect(error.code).toBe('STOCK_INSUFICIENTE')
    expect(error.stage).toBe('reserve_inventory')
    expect(error.status).toBe(409)
    expect(error.retryable).toBe(false)
    expect(place).not.toHaveBeenCalled()
    expect(log.failures[0]?.stage).toBe('reserve_inventory')
  })

  it('«no se sabe» no es «no hay»: código propio y SÍ reintentable', async () => {
    const { ports: p } = ports({
      reserveInventory: () =>
        Promise.reject(
          new Error('DISPONIBILIDAD_DESCONOCIDA: SKU-1 no se puede prometer ahora mismo'),
        ),
    })

    const error = await expectStageFailure(() => runCheckout(p, input()))
    expect(error.code).toBe('DISPONIBILIDAD_DESCONOCIDA')
    expect(error.status).toBe(503)
    expect(error.retryable).toBe(true)
  })

  it('un canal que exige sesión se rechaza antes de tocar existencia', async () => {
    const reserve = vi.fn()
    const { ports: p } = ports({
      resolveContext: (storeSlug) =>
        Promise.resolve({
          storeSlug,
          storeName: 'Tienda interna',
          currency: 'PEN',
          channelCode: 'interno',
          channelKind: 'internal',
          requiresAuth: true,
          taxInclusive: false,
        }),
      reserveInventory: reserve as unknown as CheckoutPorts['reserveInventory'],
    })

    const error = await expectStageFailure(() => runCheckout(p, input()))

    expect(error.code).toBe('CANAL_EXIGE_SESION')
    expect(error.stage).toBe('validate_account')
    expect(reserve).not.toHaveBeenCalled()
  })

  /**
   * LA compensación de la fase: si algo falla DESPUÉS de reservar, las unidades
   * vuelven al fondo común en el acto. Sin esto, cada intento fallido dejaría
   * stock apartado hasta que caducara solo, y una racha de fallos vaciaría la
   * tienda sin haber vendido nada.
   */
  it('un fallo posterior a la reserva la suelta', async () => {
    const { ports: p, log } = ports({
      placeOrder: () => Promise.reject(new Error('ERROR_INTERNO: la base no contesto')),
    })

    const error = await expectStageFailure(() => runCheckout(p, input()))

    expect(error.stage).toBe('create_order')
    expect(log.released).toEqual(['r'.repeat(64)])
    // Y queda escrito en el intento, no solo en un log que nadie mira.
    expect(log.failures[0]?.detail).toContain('compensado: release_reservation:res-1')
  })

  it('si la propia compensación falla, el error original sigue siendo el que sale', async () => {
    const { ports: p, log } = ports({
      validateDelivery: () => Promise.reject(new Error('ERROR_INTERNO: se cayo el validador')),
      releaseReservation: () => Promise.reject(new Error('la reserva ya no existe')),
    })

    const error = await expectStageFailure(() => runCheckout(p, input()))

    // El fallo de la compensación NO reemplaza al error real...
    expect(error.stage).toBe('validate_delivery')
    // ...pero tampoco se pierde: queda anotado como fallido.
    expect(log.failures[0]?.detail).toContain('release_reservation:res-1:FALLIDA')
  })

  it('un cobro autorizado se anula si el pedido no llega a existir', async () => {
    let voided = 0
    const { ports: p, log } = ports({
      authorizePayment: () =>
        Promise.resolve({
          status: 'authorized',
          providerCode: 'proveedor-de-prueba',
          providerReference: 'ref-1',
          providerMessage: null,
        }),
      voidPayment: () => {
        voided += 1
        return Promise.resolve()
      },
      placeOrder: () => Promise.reject(new Error('ERROR_INTERNO: la base no contesto')),
    })

    await expectStageFailure(() => runCheckout(p, input()))

    expect(voided).toBe(1)
    // Orden INVERSO: primero se anula el cobro (lo último que se hizo), después
    // se suelta la reserva.
    expect(log.failures[0]?.detail).toContain('void_payment:ref-1')
    expect(log.released).toEqual(['r'.repeat(64)])
  })

  it('un cobro rechazado no crea pedido y suelta la reserva', async () => {
    const place = vi.fn()
    const { ports: p, log } = ports({
      authorizePayment: () =>
        Promise.resolve({
          status: 'declined',
          providerCode: 'proveedor-de-prueba',
          providerReference: null,
          providerMessage: 'fondos insuficientes',
        }),
      placeOrder: place as unknown as CheckoutPorts['placeOrder'],
    })

    const error = await expectStageFailure(() => runCheckout(p, input()))

    expect(error.code).toBe('PAGO_RECHAZADO')
    expect(error.status).toBe(402)
    expect(place).not.toHaveBeenCalled()
    expect(log.released).toEqual(['r'.repeat(64)])
  })

  /**
   * Cuando el pedido YA existe no hay nada que compensar: deshacerlo no es
   * «soltar una reserva», es cancelar una venta, y eso lo decide una persona.
   */
  it('creado el pedido, un fallo posterior no lo deshace', async () => {
    const { ports: p, log } = ports({
      markStage: (_id, stage) => {
        log.stages.push(stage)
        // Falla justo DESPUÉS de crear el pedido.
        if (stage === 'publish_events') return Promise.reject(new Error('la red se cayo'))
        return Promise.resolve()
      },
    })

    await expectStageFailure(() => runCheckout(p, input()))

    expect(log.released).toEqual([])
  })

  it('un carrito vacío ni siquiera reclama el intento', async () => {
    const begin = vi.fn()
    const { ports: p } = ports({ begin: begin as unknown as CheckoutPorts['begin'] })

    const error = await expectStageFailure(() => runCheckout(p, input({ items: [] })))

    expect(error.code).toBe('ITEMS_REQUERIDOS')
    expect(begin).not.toHaveBeenCalled()
  })

  it('lo desconocido no se marca reintentable', async () => {
    const { ports: p } = ports({
      resolvePrices: () => Promise.reject(new Error('algo raro sin codigo de negocio')),
    })

    const error = await expectStageFailure(() => runCheckout(p, input()))
    expect(error.code).toBe('ERROR_INTERNO')
    expect(error.status).toBe(500)
    expect(error.retryable).toBe(false)
  })
})

describe('la cuenta B2B y su limite', () => {
  it('un importe por encima del limite personal no compra', async () => {
    const place = vi.fn()
    const { ports: p, log } = ports({
      resolveAccount: () =>
        Promise.resolve({
          hasSession: true,
          accountId: '55555555-5555-4555-8555-555555555555',
          role: 'buyer',
          spendingLimit: '100.00',
        }),
      placeOrder: place as unknown as CheckoutPorts['placeOrder'],
    })

    const error = await expectStageFailure(() => runCheckout(p, input()))

    expect(error.code).toBe('LIMITE_DE_AUTORIZACION')
    expect(error.stage).toBe('authorize_payment')
    expect(place).not.toHaveBeenCalled()
    // Y la existencia vuelve: no se queda apartada por un límite administrativo.
    expect(log.released).toEqual(['r'.repeat(64)])
  })

  it('sin limite declarado, el importe no lo bloquea', async () => {
    const { ports: p } = ports({
      resolveAccount: () =>
        Promise.resolve({
          hasSession: true,
          accountId: '55555555-5555-4555-8555-555555555555',
          role: 'admin',
          spendingLimit: null,
        }),
    })

    const result = await runCheckout(p, input())
    expect(result.ok).toBe(true)
  })
})
