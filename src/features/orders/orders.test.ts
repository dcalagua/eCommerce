import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  ORDER_STATUSES as EDGE_STATUSES,
  ORDER_TRANSITIONS as EDGE_TRANSITIONS,
  canTransition as edgeCanTransition,
} from '../../../supabase/functions/_shared/orders'
import { UPDATE_ORDER_STATUS_FUNCTION } from './api'
import { mapOrderCode } from './errors'
import { ordersToCsv } from './exportCsv'
import {
  ORDER_STATUSES,
  ORDER_TRANSITIONS,
  nextStatuses,
  orderSchema,
  rangeStart,
  shippingAddressSchema,
  type Order,
} from './types'

const HERE = dirname(fileURLToPath(import.meta.url))

const baseOrder = {
  id: '11111111-1111-4111-8111-111111111111',
  organization_id: '22222222-2222-4222-8222-222222222222',
  company_id: '33333333-3333-4333-8333-333333333333',
  store_id: '44444444-4444-4444-8444-444444444444',
  order_number: 'A-000001',
  customer_name: 'Ana Compradora',
  customer_email: 'ana@compradora.com',
  customer_phone: '+51 999 111 222',
  status: 'pending',
  currency: 'PEN',
  subtotal: '200.00',
  tax_total: '36.00',
  shipping_total: '0.00',
  discount_total: '0.00',
  grand_total: '236.00',
  shipping_address: { address: 'Av. Primavera 120', reference: 'Portón verde' },
  notes: null,
  placed_at: '2026-08-20T15:04:00.000Z',
  updated_at: '2026-08-20T15:04:00.000Z',
}

const order = (patch: Partial<Order> = {}): Order => orderSchema.parse({ ...baseOrder, ...patch })

/**
 * La máquina de estados vive en TRES sitios: el trigger de la base (que es el
 * que manda), el borde en Deno y esta copia del navegador. Copias separadas se
 * separan solas — este test es el que lo impide, igual que `roles.test.ts` con
 * la matriz de capacidades.
 */
describe('maquina de estados del pedido', () => {
  it('los estados del front son los mismos que los del borde', () => {
    expect([...ORDER_STATUSES]).toEqual([...EDGE_STATUSES])
  })

  it('cada transicion permitida es la misma en las dos copias', () => {
    for (const status of ORDER_STATUSES) {
      expect([...ORDER_TRANSITIONS[status]]).toEqual([...EDGE_TRANSITIONS[status]])
    }
  })

  it('`nextStatuses` responde igual que `canTransition` del borde', () => {
    for (const from of ORDER_STATUSES) {
      for (const to of ORDER_STATUSES) {
        if (from === to) continue
        expect(nextStatuses(from).includes(to)).toBe(edgeCanTransition(from, to))
      }
    }
  })

  it('la copia del front dice lo mismo que el trigger de la migracion 04', () => {
    const sql = readFileSync(
      join(HERE, '..', '..', '..', 'supabase', 'migrations', '20260827090400_orders.sql'),
      'utf8',
    )
    for (const [from, allowed] of Object.entries(ORDER_TRANSITIONS)) {
      if (allowed.length === 0) continue
      const line = new RegExp(
        `when '${from}'\\s*then array\\[${allowed.map((to) => `'${to}'`).join(',')}\\]`,
      )
      expect(sql.replace(/\s+/g, ' ').replace(/,\s+/g, ',')).toMatch(line)
    }
  })

  it('cancelado y reembolsado son finales', () => {
    expect(nextStatuses('cancelled')).toHaveLength(0)
    expect(nextStatuses('refunded')).toHaveLength(0)
  })
})

describe('dinero del pedido', () => {
  it('un numeric que llega como texto se conserva tal cual', () => {
    expect(order().grand_total).toBe('236.00')
  })

  it('un numero se normaliza a texto con dos decimales — nunca se queda como float', () => {
    const parsed = order({ grand_total: 236.1 as unknown as string })
    expect(parsed.grand_total).toBe('236.10')
    expect(typeof parsed.grand_total).toBe('string')
  })
})

describe('direccion de entrega', () => {
  it('acepta la forma del checkout minimo', () => {
    expect(shippingAddressSchema.parse({ address: 'Calle 1', reference: 'Rojo' })).toEqual({
      address: 'Calle 1',
      reference: 'Rojo',
    })
  })

  it('un jsonb con otra forma no revienta la pantalla: se lee vacio', () => {
    expect(shippingAddressSchema.parse('texto suelto')).toEqual({})
    expect(shippingAddressSchema.parse(null)).toEqual({})
  })
})

describe('filtro de fecha', () => {
  const now = new Date('2026-08-27T18:30:00.000Z')

  it('«todas las fechas» no acota nada', () => {
    expect(rangeStart('all', now)).toBeNull()
  })

  it('«hoy» arranca a medianoche, no hace 24 horas', () => {
    const start = new Date(rangeStart('today', now) as string)
    expect(start.getHours()).toBe(0)
    expect(start.getMinutes()).toBe(0)
    expect(start.getDate()).toBe(now.getDate())
  })

  it('los rangos incluyen el dia de hoy: 7 dias son hoy y los 6 anteriores', () => {
    const week = new Date(rangeStart('week', now) as string)
    const today = new Date(rangeStart('today', now) as string)
    const days = Math.round((today.getTime() - week.getTime()) / 86_400_000)
    expect(days).toBe(6)
  })
})

describe('exportacion CSV', () => {
  it('lleva los importes como texto decimal, sin simbolo ni separador de miles', () => {
    const csv = ordersToCsv([order()])
    expect(csv.split('\r\n')[1]).toContain('"236.00"')
    expect(csv).not.toContain('S/')
  })

  it('neutraliza una formula escondida en el nombre del comprador', () => {
    const csv = ordersToCsv([order({ customer_name: '=1+1' })])
    expect(csv).toContain(`"'=1+1"`)
  })

  it('junta direccion y referencia en una sola celda', () => {
    expect(ordersToCsv([order()])).toContain('"Av. Primavera 120 — Portón verde"')
  })
})

describe('traduccion de errores', () => {
  it('una transicion imposible se explica, no cae en el generico', () => {
    expect(mapOrderCode('ORDER_TRANSICION_INVALIDA')).toBe('orders.error.transition')
  })

  it('los importes inmutables tienen su propio mensaje', () => {
    expect(mapOrderCode('ORDER_IMPORTES_INMUTABLES')).toBe('orders.error.amounts')
  })

  it('un codigo desconocido no se enseña crudo', () => {
    expect(mapOrderCode('42P01')).toBe('orders.error.generic')
  })
})

/**
 * El encargo P07 es explícito: los cambios de estado pasan SOLO por
 * `update-order-status`. Una regla que solo vive en un comentario se rompe en la
 * siguiente pantalla, así que se comprueba sobre el código del propio módulo.
 */
describe('el backoffice no escribe pedidos por PostgREST', () => {
  // Se quitan los comentarios antes de mirar: este mismo archivo NOMBRA la
  // llamada prohibida para explicar por qué no está, y un escáner que no
  // distingue código de prosa daría un falso positivo con su propia doc.
  const source = readFileSync(join(HERE, 'api.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')

  it('la capa de datos de pedidos no hace update/insert/delete sobre la tabla', () => {
    expect(source).not.toMatch(/\.update\(/)
    expect(source).not.toMatch(/\.insert\(/)
    expect(source).not.toMatch(/\.delete\(/)
  })

  it('el unico camino de escritura es la Edge Function', () => {
    // Desde P01 el nombre de la funcion vive en `shared/lib/db-schema.ts`, asi
    // que se comprueba el VALOR importado en vez de buscar el literal en este
    // archivo: si alguien apunta la constante a otra funcion, esto falla, y un
    // `toContain` sobre el fuente no lo habria visto.
    expect(UPDATE_ORDER_STATUS_FUNCTION).toBe('update-order-status')
    expect(source).toMatch(/functions\.invoke\(UPDATE_ORDER_STATUS_FUNCTION/)
  })

  it('el cuerpo que sale del navegador no lleva tenant ni importes', () => {
    const body = source.slice(source.indexOf('export async function updateOrderStatus'))
    for (const forbidden of ['organization_id', 'company_id', 'store_id', 'grand_total', 'subtotal']) {
      expect(body).not.toContain(forbidden)
    }
  })
})
