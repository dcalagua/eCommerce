// @vitest-environment node
import type { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { asRole, claimsFor, createTestDatabase, expectFailure, TENANT_A, TENANT_B } from './harness'

/**
 * Cotizaciones, contra Postgres real (recorrido B2B · fase 06).
 *
 * Lo que se demuestra es la propiedad que hace que un precio dado siga siendo
 * el precio dado: **un documento que el cliente ya vio no se edita por detrás**.
 * `sent` todavía admite corrección —el vendedor se equivocó y reenvía—, pero
 * `accepted`, `rejected` y `expired` están cerrados, y el estado no retrocede.
 *
 * Y la que evita la duplicidad de dominios: `quote_items` tiene la forma de
 * `order_items`, impuesto por línea incluido, para que convertir sea copiar y
 * no traducir. Cada traducción entre dos formas parecidas es un sitio donde se
 * pierde el IGV de una línea.
 */

let db: PGlite

// El id de la tienda lo pone `bootstrap_tenant`: forzarlo con un update rompe
// las FK de `store_settings`, que ya cuelga de ella.
let STORE_A = ''
let STORE_B = ''

async function svc(query: string, params: unknown[] = []) {
  const result = await db.query<Record<string, unknown>>(query, params)
  return result.rows
}

async function cliente(tenant: typeof TENANT_A, code: string): Promise<string> {
  const rows = await svc(
    `insert into public.customers (organization_id, company_id, kind, code, name)
     values ($1, $2, 'company', $3, $3) returning id`,
    [tenant.organizationId, tenant.companyId, code],
  )
  return rows[0]?.id as string
}

/** En borrador: la cotizacion no depende de que el producto este publicado. */
async function producto(tenant: typeof TENANT_A, store: string, sku: string): Promise<string> {
  const rows = await svc(
    `insert into public.products
       (organization_id, company_id, store_id, sku, slug, name, price, currency, stock, status)
     values ($1, $2, $3, $4, lower($4), $4, '10.00', 'PEN', 100, 'draft') returning id`,
    [tenant.organizationId, tenant.companyId, store, sku],
  )
  return rows[0]?.id as string
}

async function cotizacion(
  tenant: typeof TENANT_A,
  store: string,
  customer: string,
  numero: string,
): Promise<string> {
  const rows = await svc(
    `insert into public.quotes
       (organization_id, company_id, store_id, customer_id, quote_number, currency, valid_until)
     values ($1, $2, $3, $4, $5, 'PEN', current_date + 30) returning id`,
    [tenant.organizationId, tenant.companyId, store, customer, numero],
  )
  return rows[0]?.id as string
}

function linea(tenant: typeof TENANT_A, quote: string, product: string, qty = '2') {
  return svc(
    `insert into public.quote_items
       (organization_id, company_id, quote_id, product_id, quantity, unit_price, tax_rate,
        tax_amount, line_total)
     values ($1, $2, $3, $4, $5, '10.00', 0.18, '3.60', '23.60')`,
    [tenant.organizationId, tenant.companyId, quote, product, qty],
  )
}

beforeAll(async () => {
  db = await createTestDatabase()
  for (const tenant of [TENANT_A, TENANT_B]) {
    await svc(`select public.bootstrap_tenant($1, $2, $3, $4, $5, $6, $7, 'Tienda', 'PEN')`, [
      tenant.organizationId,
      tenant.companyId,
      tenant.slug,
      tenant.slug,
      tenant.adminEmail,
      tenant.ownerId,
      tenant.storeSlug,
    ])
    const tienda = await svc(`select id from public.stores where organization_id = $1`, [
      tenant.organizationId,
    ])
    if (tenant === TENANT_A) STORE_A = tienda[0]?.id as string
    else STORE_B = tienda[0]?.id as string
    await svc(
      `select public.sync_platform_context($1, $2, true, $3, 'hub'::public.entitlement_source, null)`,
      [tenant.organizationId, tenant.companyId, ['ecommerce.trade.quotes']],
    )
  }
}, 240_000)

afterAll(async () => {
  await db?.close()
})

describe('la cotización, mientras se prepara', () => {
  it('admite líneas en borrador', async () => {
    const c = await cliente(TENANT_A, 'CLI-Q1')
    const p = await producto(TENANT_A, STORE_A, 'SKU-Q1')
    const q = await cotizacion(TENANT_A, STORE_A, c, 'COT-001')

    await linea(TENANT_A, q, p)
    const rows = await svc(`select count(*)::int as n from public.quote_items where quote_id = $1`, [q])
    expect(rows[0]?.n).toBe(1)
  })

  it('el mismo producto no entra dos veces', async () => {
    const c = await cliente(TENANT_A, 'CLI-Q2')
    const p = await producto(TENANT_A, STORE_A, 'SKU-Q2')
    const q = await cotizacion(TENANT_A, STORE_A, c, 'COT-002')

    await linea(TENANT_A, q, p)
    // Dos líneas del mismo item son una cantidad partida por error, y al
    // convertir se cobrarían las dos.
    const message = await expectFailure(() => linea(TENANT_A, q, p))
    expect(message).toMatch(/quote_items_unique|duplicate key/i)
  })

  it('enviada, todavía se puede corregir', async () => {
    const c = await cliente(TENANT_A, 'CLI-Q3')
    const p = await producto(TENANT_A, STORE_A, 'SKU-Q3')
    const q = await cotizacion(TENANT_A, STORE_A, c, 'COT-003')
    await svc(`update public.quotes set status = 'sent' where id = $1`, [q])

    // El vendedor se equivocó y reenvía: eso es normal y tiene que caber.
    await expect(linea(TENANT_A, q, p)).resolves.toBeDefined()
  })
})

describe('un documento que el cliente ya vio no se edita por detrás', () => {
  it('aceptada, no admite una línea más', async () => {
    const c = await cliente(TENANT_A, 'CLI-Q4')
    const p = await producto(TENANT_A, STORE_A, 'SKU-Q4')
    const q = await cotizacion(TENANT_A, STORE_A, c, 'COT-004')
    await svc(`update public.quotes set status = 'accepted' where id = $1`, [q])

    const message = await expectFailure(() => linea(TENANT_A, q, p))
    expect(message).toMatch(/COTIZACION_CERRADA/)
  })

  it('aceptada, tampoco deja borrar lo que ya tenía', async () => {
    const c = await cliente(TENANT_A, 'CLI-Q5')
    const p = await producto(TENANT_A, STORE_A, 'SKU-Q5')
    const q = await cotizacion(TENANT_A, STORE_A, c, 'COT-005')
    await linea(TENANT_A, q, p)
    await svc(`update public.quotes set status = 'accepted' where id = $1`, [q])

    const message = await expectFailure(() =>
      svc(`delete from public.quote_items where quote_id = $1`, [q]),
    )
    expect(message).toMatch(/COTIZACION_CERRADA/)
  })

  it('el estado avanza y no retrocede', async () => {
    const c = await cliente(TENANT_A, 'CLI-Q6')
    const q = await cotizacion(TENANT_A, STORE_A, c, 'COT-006')

    await svc(`update public.quotes set status = 'sent' where id = $1`, [q])
    // Volver a borrador borraría el rastro de que el cliente ya la recibió.
    const aBorrador = await expectFailure(() =>
      svc(`update public.quotes set status = 'draft' where id = $1`, [q]),
    )
    expect(aBorrador).toMatch(/COTIZACION_CERRADA/)

    await svc(`update public.quotes set status = 'rejected' where id = $1`, [q])
    const deRechazada = await expectFailure(() =>
      svc(`update public.quotes set status = 'sent' where id = $1`, [q]),
    )
    expect(deRechazada).toMatch(/COTIZACION_CERRADA/)
  })

  it('la vigencia no termina antes de empezar', async () => {
    const c = await cliente(TENANT_A, 'CLI-Q7')
    const message = await expectFailure(() =>
      svc(
        `insert into public.quotes
           (organization_id, company_id, store_id, customer_id, quote_number, currency,
            issued_at, valid_until)
         values ($1, $2, $3, $4, 'COT-MAL', 'PEN', current_date, current_date - 1)`,
        [TENANT_A.organizationId, TENANT_A.companyId, STORE_A, c],
      ),
    )
    expect(message).toMatch(/valid_after_issue|violates check/i)
  })
})

describe('aislamiento', () => {
  it('el admin de A no ve las cotizaciones de B', async () => {
    const deB = await cliente(TENANT_B, 'CLI-B')
    await cotizacion(TENANT_B, STORE_B, deB, 'COT-B-001')

    const vistas = await asRole(db, 'authenticated', claimsFor(TENANT_A), () =>
      svc(`select quote_number from public.quotes where quote_number = 'COT-B-001'`),
    )
    expect(vistas).toEqual([])
  })

  it('el anónimo no puede ni mirar: un precio negociado no es catálogo', async () => {
    const message = await expectFailure(() =>
      asRole(db, 'anon', null, () => svc(`select quote_number from public.quotes`)),
    )
    expect(message).toMatch(/permission denied/i)
  })
})
