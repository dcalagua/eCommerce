// @vitest-environment node
/**
 * `dashboard_kpis` sobre Postgres real.
 *
 * Un panel que agrega datos es el sitio más fácil para filtrar información
 * entre tenants sin que se note: nadie ve las filas ajenas, solo un total un
 * poco más alto de lo que debería. Por eso la función es SECURITY INVOKER y por
 * eso estos tests cuentan lo mismo desde los dos tenants.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import {
  TENANT_A,
  TENANT_B,
  asRole,
  claimsFor,
  createTestDatabase,
  expectFailure,
} from './harness.ts'

type Row = Record<string, unknown>

interface Kpis {
  products: number
  published: number
  orders: number
  sales: string | null
  currency: string | null
}

let db: PGlite
const storeOf: Record<string, string> = {}

async function svc<T = Row>(query: string, params: unknown[] = []): Promise<T[]> {
  return asRole(db, 'service_role', null, async () => {
    const result = await db.query<T>(query, params)
    return result.rows
  })
}

async function kpisFor(tenant: typeof TENANT_A, storeId: string | null): Promise<Kpis> {
  return asRole(db, 'authenticated', claimsFor(tenant), async () => {
    const result = await db.query<{ kpis: Kpis }>('select public.dashboard_kpis($1) as kpis', [
      storeId,
    ])
    return result.rows[0]!.kpis
  })
}

async function seedTenant(
  tenant: typeof TENANT_A,
  options: { products: number; published: number; orders: Array<{ total: string; status: string; currency?: string }> },
): Promise<void> {
  await svc(
    `select public.bootstrap_tenant($1, $2, $3, $4, $5, $6, $7, $8, 'PEN')`,
    [
      tenant.organizationId,
      tenant.companyId,
      tenant.slug,
      `Cuenta ${tenant.slug}`,
      tenant.adminEmail,
      tenant.ownerId,
      tenant.storeSlug,
      `Tienda ${tenant.slug}`,
    ],
  )

  const [store] = await svc<{ id: string }>('select id from public.stores where slug = $1', [
    tenant.storeSlug,
  ])
  const storeId = store!.id
  storeOf[tenant.slug] = storeId

  for (let index = 0; index < options.products; index += 1) {
    const published = index < options.published
    await svc(
      `insert into public.products
         (organization_id, company_id, store_id, sku, slug, name, price, currency, status, published_at)
       values ($1, $2, $3, $4, $5, $6, $7, 'PEN', $8, $9)`,
      [
        tenant.organizationId,
        tenant.companyId,
        storeId,
        `SKU-${tenant.slug}-${index}`,
        `producto-${index}`,
        `Producto ${index}`,
        '10.00',
        published ? 'published' : 'draft',
        published ? new Date('2026-08-01T00:00:00Z').toISOString() : null,
      ],
    )
  }

  for (const [index, order] of options.orders.entries()) {
    await svc(
      `insert into public.orders
         (organization_id, company_id, store_id, channel_id, order_number, status, customer_email,
          currency, subtotal, grand_total)
       values ($1, $2, $3, (select c.id from public.channels c where c.store_id = $3 and c.is_default), $4, $5, $6, $7, $8, $8)`,
      [
        tenant.organizationId,
        tenant.companyId,
        storeId,
        `${tenant.slug}-${index}`,
        order.status,
        'cliente@correo.com',
        order.currency ?? 'PEN',
        order.total,
      ],
    )
  }
}

beforeAll(async () => {
  db = await createTestDatabase()
  await seedTenant(TENANT_A, {
    products: 4,
    published: 3,
    orders: [
      { total: '100.00', status: 'paid' },
      { total: '50.00', status: 'pending' },
      { total: '999.00', status: 'cancelled' },
    ],
  })
  await seedTenant(TENANT_B, {
    products: 7,
    published: 7,
    orders: [{ total: '7777.00', status: 'paid' }],
  })
}, 120_000)

afterAll(async () => {
  await db?.close()
})

describe('dashboard_kpis', () => {
  it('cuenta el catálogo y los pedidos del tenant que pregunta', async () => {
    const kpis = await kpisFor(TENANT_A, storeOf[TENANT_A.slug]!)
    expect(kpis.products).toBe(4)
    expect(kpis.published).toBe(3)
    expect(kpis.orders).toBe(3)
  })

  it('las ventas excluyen los pedidos anulados', async () => {
    const kpis = await kpisFor(TENANT_A, storeOf[TENANT_A.slug]!)
    expect(Number(kpis.sales)).toBe(150)
    expect(kpis.currency).toBe('PEN')
  })

  it('el dinero sale como texto, no como número JSON', async () => {
    const kpis = await kpisFor(TENANT_A, storeOf[TENANT_A.slug]!)
    expect(typeof kpis.sales).toBe('string')
  })

  it('un tenant NO ve las cifras del otro ni pidiendo su tienda por id', async () => {
    const ajena = storeOf[TENANT_B.slug]!
    const kpis = await kpisFor(TENANT_A, ajena)
    expect(kpis).toMatchObject({ products: 0, published: 0, orders: 0, sales: null })
  })

  it('sin tienda concreta, cada tenant suma solo lo suyo', async () => {
    const a = await kpisFor(TENANT_A, null)
    const b = await kpisFor(TENANT_B, null)
    expect(a.products).toBe(4)
    expect(b.products).toBe(7)
    expect(Number(b.sales)).toBe(7777)
  })

  it('con monedas mezcladas no inventa un total: devuelve null', async () => {
    await svc(
      `insert into public.orders
         (organization_id, company_id, store_id, channel_id, order_number, status, customer_email,
          currency, subtotal, grand_total)
       values ($1, $2, $3, (select c.id from public.channels c where c.store_id = $3 and c.is_default), 'mixto-1', 'paid', 'cliente@correo.com', 'USD', '20.00', '20.00')`,
      [TENANT_B.organizationId, TENANT_B.companyId, storeOf[TENANT_B.slug]!],
    )
    const kpis = await kpisFor(TENANT_B, storeOf[TENANT_B.slug]!)
    expect(kpis.sales).toBeNull()
    expect(kpis.currency).toBeNull()
    // Los conteos sí siguen siendo reales.
    expect(kpis.orders).toBe(2)
  })

  it('un JWT con el org_id ajeno no cuenta nada', async () => {
    const forged = claimsFor(TENANT_A, {
      org_id: TENANT_B.organizationId,
      companies: [{ id: TENANT_B.companyId, role: 'admin' }],
      active_company: TENANT_B.companyId,
    })
    const kpis = await asRole(db, 'authenticated', forged, async () => {
      const result = await db.query<{ kpis: Kpis }>('select public.dashboard_kpis(null) as kpis')
      return result.rows[0]!.kpis
    })
    expect(kpis).toMatchObject({ products: 0, orders: 0, sales: null })
  })

  it('el comprador anónimo del storefront no puede ejecutarla', async () => {
    const message = await expectFailure(() =>
      asRole(db, 'anon', null, () => db.query('select public.dashboard_kpis(null)')),
    )
    expect(message).toMatch(/permission denied/i)
  })
})
