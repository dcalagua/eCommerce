// @vitest-environment node
/**
 * `dashboard_sales_trend` sobre Postgres real.
 *
 * Igual que `dashboard_kpis`, es un agregado: el sitio donde una fuga entre
 * tenants no se ve como una fila ajena sino como un total un poco más alto. Por
 * eso es SECURITY INVOKER y por eso estos tests suman lo mismo desde los dos
 * tenants, y con un JWT falsificado.
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

interface Trend {
  period: string
  unit: 'day' | 'month'
  currency: string | null
  sales: string | null
  previous_sales: string | null
  orders: number
  avg_ticket: string | null
  series: Array<{ date: string; sales: string }>
  best: { date: string; sales: string } | null
}

let db: PGlite
const storeOf: Record<string, string> = {}

async function svc<T = Row>(query: string, params: unknown[] = []): Promise<T[]> {
  return asRole(db, 'service_role', null, async () => {
    const result = await db.query<T>(query, params)
    return result.rows
  })
}

async function trendFor(
  tenant: typeof TENANT_A,
  storeId: string | null,
  period = '7d',
  tz = 'UTC',
): Promise<Trend> {
  return asRole(db, 'authenticated', claimsFor(tenant), async () => {
    const result = await db.query<{ t: Trend }>('select public.dashboard_sales_trend($1, $2, $3) as t', [
      storeId,
      period,
      tz,
    ])
    return result.rows[0]!.t
  })
}

async function bootstrap(tenant: typeof TENANT_A): Promise<string> {
  await svc(`select public.bootstrap_tenant($1, $2, $3, $4, $5, $6, $7, $8, 'PEN')`, [
    tenant.organizationId,
    tenant.companyId,
    tenant.slug,
    `Cuenta ${tenant.slug}`,
    tenant.adminEmail,
    tenant.ownerId,
    tenant.storeSlug,
    `Tienda ${tenant.slug}`,
  ])
  const [store] = await svc<{ id: string }>('select id from public.stores where slug = $1', [tenant.storeSlug])
  storeOf[tenant.slug] = store!.id
  return store!.id
}

let seq = 0
/** Un pedido hace `daysAgo` días (UTC), con su total, estado y moneda. */
async function order(
  tenant: typeof TENANT_A,
  daysAgo: number,
  total: string,
  status = 'paid',
  currency = 'PEN',
): Promise<void> {
  seq += 1
  await svc(
    `insert into public.orders
       (organization_id, company_id, store_id, channel_id, order_number, status, customer_email,
        currency, subtotal, grand_total, placed_at)
     values ($1, $2, $3, (select c.id from public.channels c where c.store_id = $3 and c.is_default),
             $4, $5, 'cliente@correo.com', $6, $7, $7, now() - make_interval(days => $8))`,
    [
      tenant.organizationId,
      tenant.companyId,
      storeOf[tenant.slug]!,
      `${tenant.slug}-t${seq}`,
      status,
      currency,
      total,
      daysAgo,
    ],
  )
}

beforeAll(async () => {
  db = await createTestDatabase()
  await bootstrap(TENANT_A)
  await bootstrap(TENANT_B)

  // Tenant A · ventana de 7 días: hoy 100, hace 2 días 50, hace 3 días un
  // anulado de 999 que NO cuenta. Ventana anterior (8–13 días): 40.
  await order(TENANT_A, 0, '100.00')
  await order(TENANT_A, 2, '50.00', 'pending')
  await order(TENANT_A, 3, '999.00', 'cancelled')
  await order(TENANT_A, 9, '40.00')
  // Fuera de las dos ventanas de 7 días, dentro de la de 12 meses.
  await order(TENANT_A, 60, '300.00')

  // Tenant B vende mucho más: si algo se filtrara, se notaría en A.
  await order(TENANT_B, 1, '7777.00')
}, 120_000)

afterAll(async () => {
  await db?.close()
})

describe('dashboard_sales_trend', () => {
  it('suma el periodo y el anterior, sin anulados, y el dinero viaja como texto', async () => {
    const t = await trendFor(TENANT_A, storeOf[TENANT_A.slug]!)
    expect(t.currency).toBe('PEN')
    expect(t.sales).toBe('150.00')
    expect(t.previous_sales).toBe('40.00')
    expect(t.orders).toBe(2)
    expect(t.avg_ticket).toBe('75.00')
    expect(typeof t.sales).toBe('string')
  })

  it('la serie trae un punto por día, con los ceros, y el mejor día', async () => {
    const t = await trendFor(TENANT_A, storeOf[TENANT_A.slug]!)
    expect(t.unit).toBe('day')
    expect(t.series).toHaveLength(7)
    expect(t.series.at(-1)!.sales).toBe('100.00')
    expect(t.series.at(-3)!.sales).toBe('50.00')
    expect(t.series.filter((p) => p.sales === '0.00')).toHaveLength(5)
    expect(t.best).toMatchObject({ sales: '100.00', date: t.series.at(-1)!.date })
  })

  it('30 días son 30 puntos; 12 meses son 12 puntos por mes', async () => {
    const d30 = await trendFor(TENANT_A, storeOf[TENANT_A.slug]!, '30d')
    expect(d30.series).toHaveLength(30)
    expect(d30.sales).toBe('190.00')

    const m12 = await trendFor(TENANT_A, storeOf[TENANT_A.slug]!, '12m')
    expect(m12.unit).toBe('month')
    expect(m12.series).toHaveLength(12)
    expect(m12.series.every((p) => p.date.endsWith('-01'))).toBe(true)
    expect(m12.sales).toBe('490.00')
  })

  it('un tenant NO ve las ventas del otro ni pidiendo su tienda por id', async () => {
    const t = await trendFor(TENANT_A, storeOf[TENANT_B.slug]!)
    expect(t).toMatchObject({ sales: null, currency: null, orders: 0, series: [] })
  })

  it('sin tienda concreta, cada tenant suma solo lo suyo', async () => {
    const a = await trendFor(TENANT_A, null)
    const b = await trendFor(TENANT_B, null)
    expect(a.sales).toBe('150.00')
    expect(b.sales).toBe('7777.00')
  })

  it('un JWT con el org_id ajeno no suma nada', async () => {
    const forged = claimsFor(TENANT_A, {
      org_id: TENANT_B.organizationId,
      companies: [{ id: TENANT_B.companyId, role: 'admin' }],
      active_company: TENANT_B.companyId,
    })
    const t = await asRole(db, 'authenticated', forged, async () => {
      const result = await db.query<{ t: Trend }>("select public.dashboard_sales_trend(null, '7d', 'UTC') as t")
      return result.rows[0]!.t
    })
    expect(t).toMatchObject({ sales: null, orders: 0 })
  })

  it('una zona horaria desconocida no rompe: cae a UTC', async () => {
    const t = await trendFor(TENANT_A, storeOf[TENANT_A.slug]!, '7d', 'Marte/Olympus')
    expect(t.sales).toBe('150.00')
  })

  it('un periodo que no existe se rechaza en vez de adivinar', async () => {
    const message = await expectFailure(() => trendFor(TENANT_A, storeOf[TENANT_A.slug]!, '5y'))
    expect(message).toMatch(/periodo no valido/)
  })

  it('con monedas mezcladas no inventa un total: devuelve null', async () => {
    await order(TENANT_B, 3, '20.00', 'paid', 'USD')
    const t = await trendFor(TENANT_B, storeOf[TENANT_B.slug]!)
    expect(t.sales).toBeNull()
    expect(t.currency).toBeNull()
    expect(t.series).toEqual([])
  })

  it('el comprador anónimo del storefront no puede ejecutarla', async () => {
    const message = await expectFailure(() =>
      asRole(db, 'anon', null, () => db.query("select public.dashboard_sales_trend(null, '7d', 'UTC')")),
    )
    expect(message).toMatch(/permission denied/)
  })
})

describe('dashboard_sales_trend · tienda sin ventas', () => {
  it('sin pedidos, la venta del periodo es cero en la moneda de la tienda', async () => {
    const tenantC = { ...TENANT_A }
    // Se reutiliza A borrando sus pedidos: lo que importa es la regla, no el tenant.
    await svc('delete from public.orders where store_id = $1', [storeOf[tenantC.slug]!])
    const t = await trendFor(tenantC, storeOf[tenantC.slug]!)
    expect(t).toMatchObject({ currency: 'PEN', sales: '0.00', previous_sales: '0.00', orders: 0, best: null })
    expect(t.avg_ticket).toBeNull()
    expect(t.series).toHaveLength(7)
  })
})
