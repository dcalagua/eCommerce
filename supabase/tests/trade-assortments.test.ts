// @vitest-environment node
import type { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestDatabase, expectFailure, TENANT_A } from './harness'

/**
 * Surtidos, contra Postgres real (recorrido B2B · fase 08).
 *
 * Lo que de verdad hay que demostrar es **la precedencia**, porque es la única
 * pieza que puede dar dos respuestas a la misma pregunta. `customer > segment >
 * territory > channel > store`, de lo particular a lo general, igual que en
 * pricing — y calculada en un solo sitio: tres pantallas resolviéndola por su
 * cuenta acabarían enseñando tres catálogos distintos al mismo cliente.
 *
 * Y la degradación, que es la regla del repositorio: **sin surtido configurado
 * se ofrece todo el catálogo**, exactamente como vendía la tienda antes de esta
 * fase. Nada de lo nuevo puede convertirse en un prerrequisito para vender.
 */

let db: PGlite

let STORE = ''

async function svc(query: string, params: unknown[] = []) {
  const result = await db.query<Record<string, unknown>>(query, params)
  return result.rows
}

async function producto(sku: string): Promise<string> {
  const rows = await svc(
    `insert into public.products
       (organization_id, company_id, store_id, sku, slug, name, price, currency, stock, status)
     values ($1, $2, $3, $4, lower($4), $4, '10.00', 'PEN', 10, 'draft') returning id`,
    [TENANT_A.organizationId, TENANT_A.companyId, STORE, sku],
  )
  return rows[0]?.id as string
}

async function cliente(code: string, segment: string | null = null): Promise<string> {
  const rows = await svc(
    `insert into public.customers (organization_id, company_id, kind, code, name, segment_id)
     values ($1, $2, 'company', $3, $3, $4) returning id`,
    [TENANT_A.organizationId, TENANT_A.companyId, code, segment],
  )
  return rows[0]?.id as string
}

async function surtido(code: string, allow = true): Promise<string> {
  const rows = await svc(
    `insert into public.assortments
       (organization_id, company_id, store_id, code, name, is_allow_list)
     values ($1, $2, $3, $4, $4, $5) returning id`,
    [TENANT_A.organizationId, TENANT_A.companyId, STORE, code, allow],
  )
  return rows[0]?.id as string
}

function meter(assortment: string, product: string) {
  return svc(
    `insert into public.assortment_items
       (organization_id, company_id, assortment_id, product_id)
     values ($1, $2, $3, $4)`,
    [TENANT_A.organizationId, TENANT_A.companyId, assortment, product],
  )
}

function asignar(
  assortment: string,
  scope: string,
  target: { customer?: string; segment?: string; territory?: string; channel?: string } = {},
) {
  return svc(
    `insert into public.assortment_assignments
       (organization_id, company_id, store_id, assortment_id, scope,
        customer_id, segment_id, territory_id, channel_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      TENANT_A.organizationId,
      TENANT_A.companyId,
      STORE,
      assortment,
      scope,
      target.customer ?? null,
      target.segment ?? null,
      target.territory ?? null,
      target.channel ?? null,
    ],
  )
}

async function seOfrece(customer: string, product: string): Promise<boolean> {
  const rows = await svc(`select ebim.product_in_assortment($1, $2, $3) as v`, [
    STORE,
    customer,
    product,
  ])
  return rows[0]?.v as boolean
}

beforeAll(async () => {
  db = await createTestDatabase()
  await svc(`select public.bootstrap_tenant($1, $2, $3, $4, $5, $6, $7, 'Tienda', 'PEN')`, [
    TENANT_A.organizationId,
    TENANT_A.companyId,
    TENANT_A.slug,
    TENANT_A.slug,
    TENANT_A.adminEmail,
    TENANT_A.ownerId,
    TENANT_A.storeSlug,
  ])
  const tienda = await svc(`select id from public.stores where organization_id = $1`, [
    TENANT_A.organizationId,
  ])
  STORE = tienda[0]?.id as string
}, 240_000)

afterAll(async () => {
  await db?.close()
})

describe('sin surtido configurado, se vende como siempre', () => {
  it('todo el catálogo está disponible', async () => {
    const c = await cliente('CLI-LIBRE')
    const p = await producto('SKU-LIBRE')

    // La degradación es la regla: nada de lo nuevo es prerrequisito para vender.
    expect(await seOfrece(c, p)).toBe(true)
  })
})

describe('lista blanca y lista negra', () => {
  it('la blanca deja pasar solo lo que contiene', async () => {
    const c = await cliente('CLI-BLANCA')
    const dentro = await producto('SKU-DENTRO')
    const fuera = await producto('SKU-FUERA')
    const s = await surtido('BLANCA', true)

    await meter(s, dentro)
    await asignar(s, 'customer', { customer: c })

    expect(await seOfrece(c, dentro)).toBe(true)
    expect(await seOfrece(c, fuera)).toBe(false)
  })

  it('la negra deja pasar todo MENOS lo que contiene', async () => {
    const c = await cliente('CLI-NEGRA')
    const vetado = await producto('SKU-VETADO')
    const otro = await producto('SKU-OTRO')
    const s = await surtido('NEGRA', false)

    await meter(s, vetado)
    await asignar(s, 'customer', { customer: c })

    // Un distribuidor necesita las dos formas: «solo estos 200» para el canal
    // moderno y «todo menos estos 5» para el tradicional.
    expect(await seOfrece(c, vetado)).toBe(false)
    expect(await seOfrece(c, otro)).toBe(true)
  })
})

describe('la precedencia', () => {
  it('el surtido de CLIENTE gana al de tienda', async () => {
    const c = await cliente('CLI-PREC')
    const p = await producto('SKU-PREC')

    // La tienda entera: solo se ofrece `p`.
    const general = await surtido('GENERAL', true)
    await meter(general, p)
    await asignar(general, 'store')
    expect(await seOfrece(c, p)).toBe(true)

    // Y este cliente concreto: una lista blanca vacía, o sea, nada.
    const suyo = await surtido('SOLO-SUYO', true)
    await asignar(suyo, 'customer', { customer: c })

    // Lo particular manda sobre lo general, igual que en pricing.
    expect(await seOfrece(c, p)).toBe(false)
  })

  it('el de SEGMENTO gana al de tienda, y pierde con el de cliente', async () => {
    const seg = await svc(
      `insert into public.customer_segments (organization_id, company_id, code, name)
       values ($1, $2, 'bodega', 'Bodega') returning id`,
      [TENANT_A.organizationId, TENANT_A.companyId],
    )
    const segmento = seg[0]?.id as string
    const c = await cliente('CLI-SEG', segmento)
    const p = await producto('SKU-SEG')

    const delSegmento = await surtido('SEG-BLANCA', true)
    await meter(delSegmento, p)
    await asignar(delSegmento, 'segment', { segment: segmento })

    // Gana al 'store' que ya existe y que no lo contiene.
    expect(await seOfrece(c, p)).toBe(true)
  })
})

describe('la forma de la asignación', () => {
  it('el ámbito y su objetivo no se contradicen', async () => {
    const s = await surtido('MALA', true)
    const c = await cliente('CLI-MALA')

    // «Ámbito tienda» con un cliente dentro haría que «a quién aplica» tuviera
    // dos respuestas.
    const message = await expectFailure(() => asignar(s, 'store', { customer: c }))
    expect(message).toMatch(/scope_target|violates check/i)
  })

  it('la misma asignación no entra dos veces', async () => {
    const s = await surtido('REPE', true)
    await asignar(s, 'store')

    // `nulls not distinct`: sin él, «ámbito tienda» —con todas las columnas de
    // objetivo en NULL— se podría repetir indefinidamente.
    const message = await expectFailure(() => asignar(s, 'store'))
    expect(message).toMatch(/assortment_assignments_unique|duplicate key/i)
  })

  it('un producto no se repite dentro del surtido', async () => {
    const s = await surtido('ITEMS', true)
    const p = await producto('SKU-ITEMS')

    await meter(s, p)
    const message = await expectFailure(() => meter(s, p))
    expect(message).toMatch(/assortment_items_unique|duplicate key/i)
  })
})
