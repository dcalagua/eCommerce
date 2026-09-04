import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  COMPANY_A,
  ORG,
  STORE_A,
  createFakeSupabase,
  makeSession,
  type FakeSupabase,
} from '@/test/supabaseMock'

/**
 * La carga masiva de precios contra la clave única de la tabla.
 *
 * `price_list_items` tiene dos índices únicos por (lista, producto o variante,
 * presentación, cantidad mínima). La importación era un `insert` a secas —el
 * comentario del código decía `upsert`, el código no lo hacía— así que volver a
 * importar la misma hoja con tres precios corregidos moría con un error de
 * duplicado. Corregir en bloque es justo para lo que se usa un CSV, o sea que
 * el caso que fallaba era el principal.
 *
 * Se prueba a nivel de API y no de pantalla porque lo que hay que fijar es la
 * PARTIDA entre altas y actualizaciones: eso es lo que decide si una segunda
 * importación repara la lista o la rompe.
 */

const holder = vi.hoisted(() => ({ client: null as unknown }))

vi.mock('@/shared/lib/supabase', () => ({
  tryGetSupabaseClient: () => holder.client,
  getSupabaseClient: () => holder.client,
}))

const { importPriceItems } = await import('./api')

const LIST_ID = '77777777-7777-4777-8777-777777777701'
const PRODUCT_A = '77777777-7777-4777-8777-7777777777a1'
const PRODUCT_B = '77777777-7777-4777-8777-7777777777a2'
const ITEM_A = '77777777-7777-4777-8777-7777777777b1'

const SCOPE = { organizationId: ORG, companyId: COMPANY_A, storeId: STORE_A }

function backend(): FakeSupabase {
  return createFakeSupabase({
    session: makeSession(),
    tables: {
      price_list_items: [
        {
          id: ITEM_A,
          organization_id: ORG,
          company_id: COMPANY_A,
          store_id: STORE_A,
          price_list_id: LIST_ID,
          product_id: PRODUCT_A,
          variant_id: null,
          uom_id: null,
          // Como lo devuelve Postgres: seis decimales. La hoja trae «1».
          min_quantity: '1.000000',
          unit_price: '80.00',
          compare_at_price: '100.00',
        },
      ],
    },
  })
}

function fila(overrides: Record<string, unknown> = {}) {
  return {
    line: 2,
    productId: PRODUCT_A,
    variantId: null,
    uomId: null,
    minQuantity: '1',
    unitPrice: '72.00',
    compareAtPrice: null,
    ...overrides,
  }
}

beforeEach(() => {
  holder.client = null
})

describe('importación de precios', () => {
  it('reimportar un renglón que ya está lo ACTUALIZA en vez de duplicarlo', async () => {
    const fake = backend()
    holder.client = fake

    const resultado = await importPriceItems({ scope: SCOPE, listId: LIST_ID, rows: [fila()] })

    expect(resultado).toEqual({ inserted: 0, updated: 1 })
    const filas = fake.state.tables.price_list_items as Record<string, unknown>[]
    expect(filas).toHaveLength(1)
    expect(filas[0]?.unit_price).toBe('72.00')
    // La hoja traía el «antes» vacío: quitarlo es lo que saca al producto de la
    // banda de ofertas de la vitrina, y tiene que llegar hasta la tabla.
    expect(filas[0]?.compare_at_price).toBeNull()
  })

  it('«1» de la hoja y «1.000000» de la base son la MISMA cantidad mínima', async () => {
    const fake = backend()
    holder.client = fake

    await importPriceItems({ scope: SCOPE, listId: LIST_ID, rows: [fila({ minQuantity: '1.00' })] })

    // Comparadas como texto serían dos claves distintas, y el alta chocaría
    // contra el índice único que dice que no puede haber dos.
    expect(fake.state.tables.price_list_items).toHaveLength(1)
  })

  it('lo que no estaba se da de alta, y en una sola escritura', async () => {
    const fake = backend()
    holder.client = fake

    const resultado = await importPriceItems({
      scope: SCOPE,
      listId: LIST_ID,
      rows: [fila(), fila({ line: 3, productId: PRODUCT_B, unitPrice: '25.00' })],
    })

    expect(resultado).toEqual({ inserted: 1, updated: 1 })
    const filas = fake.state.tables.price_list_items as Record<string, unknown>[]
    expect(filas).toHaveLength(2)
    expect(filas.find((row) => row.product_id === PRODUCT_B)?.price_list_id).toBe(LIST_ID)
  })

  it('una escala distinta del mismo producto es un renglón nuevo, no una corrección', async () => {
    const fake = backend()
    holder.client = fake

    const resultado = await importPriceItems({
      scope: SCOPE,
      listId: LIST_ID,
      rows: [fila({ minQuantity: '12', unitPrice: '68.00' })],
    })

    expect(resultado).toEqual({ inserted: 1, updated: 0 })
    expect(fake.state.tables.price_list_items).toHaveLength(2)
  })

  it('una hoja vacía no escribe nada', async () => {
    const fake = backend()
    holder.client = fake

    expect(await importPriceItems({ scope: SCOPE, listId: LIST_ID, rows: [] })).toEqual({
      inserted: 0,
      updated: 0,
    })
  })
})
