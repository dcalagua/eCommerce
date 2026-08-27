// @vitest-environment node
/**
 * P07 · Gestión de pedidos y personalización de tienda sobre Postgres REAL.
 *
 * Lo que se prueba aquí no es «que el SQL parezca correcto», sino que la base:
 *  - escriba la bitácora sola, en la misma transacción que el cambio de estado;
 *  - no deje que nadie invente, edite ni borre un evento de esa bitácora;
 *  - no deje que el tenant de al lado la lea;
 *  - no acepte un asset de branding que apunte al bucket de otro tenant.
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

let db: PGlite
let storeA: string
let storeB: string
let orderA: string
let orderB: string

const ORDERS_USER = '0a000000-0000-4000-8000-0000000000e1'
const VIEWER_USER = '0a000000-0000-4000-8000-0000000000d1'

async function svc<T = Row>(query: string, params: unknown[] = []): Promise<T[]> {
  return asRole(db, 'service_role', null, async () => {
    const result = await db.query<T>(query, params)
    return result.rows
  })
}

const ordersClaims = () =>
  claimsFor(TENANT_A, {
    sub: ORDERS_USER,
    email: 'pedidos@tenant-a.com',
    companies: [{ id: TENANT_A.companyId, role: 'orders' }],
  })

const viewerClaims = () =>
  claimsFor(TENANT_A, {
    sub: VIEWER_USER,
    email: 'lector@tenant-a.com',
    companies: [{ id: TENANT_A.companyId, role: 'viewer' }],
  })

async function bootstrap(tenant: typeof TENANT_A): Promise<string> {
  await svc(
    `select public.bootstrap_tenant($1, $2, $3, $4, $5, $6, $7, 'Tienda', 'PEN')`,
    [
      tenant.organizationId,
      tenant.companyId,
      tenant.slug,
      tenant.slug,
      tenant.adminEmail,
      tenant.ownerId,
      tenant.storeSlug,
    ],
  )
  const [store] = await svc(`select id from public.stores where slug = $1`, [tenant.storeSlug])
  const storeId = String(store?.id)
  await svc(`update public.stores set status = 'active' where id = $1`, [storeId])
  return storeId
}

/** Alta de pedido por el mismo camino que usa el comprador anónimo. */
async function placeOrder(tenant: typeof TENANT_A, storeId: string): Promise<string> {
  const [product] = await svc(
    `insert into public.products
       (organization_id, company_id, store_id, sku, slug, name, price, currency, stock, status, published_at)
     values ($1, $2, $3, $4, $4, $4, '100.00', 'PEN', 20, 'published', now())
     returning id`,
    [tenant.organizationId, tenant.companyId, storeId, `sku-${tenant.slug}`],
  )

  const rows = await svc(
    `select public.create_order_for_slug(
        $1, 'ana@compradora.com', $2::jsonb, 'Ana Compradora', '+51 999 111 222',
        $3::jsonb, null) as result`,
    [
      tenant.storeSlug,
      JSON.stringify([{ product_id: String(product?.id), quantity: 2 }]),
      JSON.stringify({ address: 'Av. Primavera 120', reference: 'Portón verde' }),
    ],
  )
  return String((rows[0]?.result as Row)?.order_id)
}

async function eventsOf(orderId: string): Promise<Row[]> {
  return svc(
    `select from_status, to_status, note, actor_id, actor_email
       from public.order_status_events where order_id = $1 order by created_at, to_status`,
    [orderId],
  )
}

beforeAll(async () => {
  db = await createTestDatabase()

  storeA = await bootstrap(TENANT_A)
  storeB = await bootstrap(TENANT_B)

  await svc(
    `insert into public.tenant_members (organization_id, company_id, user_id, email, role, status)
     values ($1, $2, $3, 'pedidos@tenant-a.com', 'orders', 'active'),
            ($1, $2, $4, 'lector@tenant-a.com',  'viewer', 'active')`,
    [TENANT_A.organizationId, TENANT_A.companyId, ORDERS_USER, VIEWER_USER],
  )

  orderA = await placeOrder(TENANT_A, storeA)
  orderB = await placeOrder(TENANT_B, storeB)
}, 180_000)

afterAll(async () => {
  await db?.close()
})

describe('bitacora de pedidos — la escribe la base, no la aplicacion', () => {
  it('el alta del pedido deja el primer evento, sin autor inventado', async () => {
    const events = await eventsOf(orderA)
    expect(events).toHaveLength(1)
    expect(events[0]?.from_status).toBeNull()
    expect(events[0]?.to_status).toBe('pending')
    // El comprador es anónimo: no hay JWT, así que no hay actor. Poner uno
    // sería atribuirle el pedido a alguien que no lo hizo.
    expect(events[0]?.actor_id).toBeNull()
    expect(events[0]?.actor_email).toBeNull()
  })

  it('un cambio de estado del backoffice queda firmado con quien lo hizo', async () => {
    await asRole(db, 'authenticated', ordersClaims(), () =>
      db.query(`update public.orders set status = 'paid', notes = 'Pago confirmado' where id = $1`, [
        orderA,
      ]),
    )

    const events = await eventsOf(orderA)
    expect(events).toHaveLength(2)
    expect(events[1]).toMatchObject({
      from_status: 'pending',
      to_status: 'paid',
      note: 'Pago confirmado',
      actor_id: ORDERS_USER,
      actor_email: 'pedidos@tenant-a.com',
    })
  })

  it('una transicion imposible no cambia el estado NI deja evento', async () => {
    const message = await expectFailure(() =>
      asRole(db, 'authenticated', ordersClaims(), () =>
        db.query(`update public.orders set status = 'pending' where id = $1`, [orderA]),
      ),
    )
    expect(message).toMatch(/ORDER_TRANSICION_INVALIDA/)
    expect(await eventsOf(orderA)).toHaveLength(2)
  })

  it('tocar la nota sin mover el estado no inventa un cambio de estado', async () => {
    await asRole(db, 'authenticated', ordersClaims(), () =>
      db.query(`update public.orders set status = 'paid', notes = 'Otra nota' where id = $1`, [
        orderA,
      ]),
    )
    expect(await eventsOf(orderA)).toHaveLength(2)
  })
})

describe('la bitacora es append-only de verdad', () => {
  it('un rol de pedidos puede leerla', async () => {
    const rows = await asRole(db, 'authenticated', ordersClaims(), async () =>
      (await db.query<Row>(`select id from public.order_status_events`)).rows,
    )
    expect(rows.length).toBeGreaterThanOrEqual(2)
  })

  it('nadie autenticado puede insertar un evento a mano', async () => {
    const message = await expectFailure(() =>
      asRole(db, 'authenticated', ordersClaims(), () =>
        db.query(
          `insert into public.order_status_events
             (organization_id, company_id, store_id, order_id, from_status, to_status)
           values ($1, $2, $3, $4, 'paid', 'fulfilled')`,
          [TENANT_A.organizationId, TENANT_A.companyId, storeA, orderA],
        ),
      ),
    )
    expect(message).toMatch(/permission denied|policy/i)
  })

  it('tampoco puede editar ni borrar lo ya escrito', async () => {
    const update = await expectFailure(() =>
      asRole(db, 'authenticated', ordersClaims(), () =>
        db.query(`update public.order_status_events set note = 'reescrito'`),
      ),
    )
    expect(update).toMatch(/permission denied|policy/i)

    const remove = await expectFailure(() =>
      asRole(db, 'authenticated', ordersClaims(), () =>
        db.query(`delete from public.order_status_events`),
      ),
    )
    expect(remove).toMatch(/permission denied|policy/i)
  })

  it('el comprador anonimo no la ve', async () => {
    const message = await expectFailure(() =>
      asRole(db, 'anon', null, () => db.query(`select * from public.order_status_events`)),
    )
    expect(message).toMatch(/permission denied/i)
  })

  it('nadie puede invocar el escritor de la bitacora a mano', async () => {
    for (const role of ['anon', 'authenticated'] as const) {
      const message = await expectFailure(() =>
        asRole(db, role, role === 'anon' ? null : ordersClaims(), () =>
          db.query(`select ebim.log_order_status_event()`),
        ),
      )
      expect(message).toMatch(/permission denied/i)
    }
  })
})

describe('aislamiento entre tenants', () => {
  it('el tenant A no ve la bitacora del tenant B', async () => {
    const rows = await asRole(db, 'authenticated', ordersClaims(), async () =>
      (await db.query<Row>(`select order_id from public.order_status_events`)).rows,
    )
    const ids = rows.map((row) => String(row.order_id))
    expect(ids).toContain(orderA)
    expect(ids).not.toContain(orderB)
  })

  it('un viewer del tenant A lee pedidos pero no los mueve', async () => {
    const rows = await asRole(db, 'authenticated', viewerClaims(), async () =>
      (await db.query<Row>(`select id from public.orders`)).rows,
    )
    expect(rows).toHaveLength(1)

    // Sin rol de pedidos la policy deja el UPDATE en cero filas: no cambia el
    // estado y, por tanto, tampoco aparece un evento nuevo.
    const before = await eventsOf(orderA)
    await asRole(db, 'authenticated', viewerClaims(), () =>
      db.query(`update public.orders set status = 'fulfilled' where id = $1`, [orderA]),
    )
    const [order] = await svc(`select status from public.orders where id = $1`, [orderA])
    expect(order?.status).toBe('paid')
    expect(await eventsOf(orderA)).toHaveLength(before.length)
  })
})

describe('personalizacion de la tienda — assets de branding', () => {
  const brandingPath = (org: string, store: string) => `${org}/${store}/branding/logo-x.png`

  it('acepta la ruta del PROPIO tenant', async () => {
    await asRole(db, 'authenticated', claimsFor(TENANT_A), () =>
      db.query(`update public.store_settings set logo_url = $2 where store_id = $1`, [
        storeA,
        brandingPath(TENANT_A.organizationId, storeA),
      ]),
    )
    const [row] = await svc(`select logo_url from public.store_settings where store_id = $1`, [
      storeA,
    ])
    expect(row?.logo_url).toBe(brandingPath(TENANT_A.organizationId, storeA))
  })

  it('acepta una URL https externa (logo-auto del contrato §4.3)', async () => {
    await asRole(db, 'authenticated', claimsFor(TENANT_A), () =>
      db.query(`update public.store_settings set logo_url = $2 where store_id = $1`, [
        storeA,
        'https://logo.clearbit.com/tenant-a.com',
      ]),
    )
    const [row] = await svc(`select logo_url from public.store_settings where store_id = $1`, [
      storeA,
    ])
    expect(row?.logo_url).toBe('https://logo.clearbit.com/tenant-a.com')
  })

  it('RECHAZA apuntar al bucket de otro tenant', async () => {
    const message = await expectFailure(() =>
      asRole(db, 'authenticated', claimsFor(TENANT_A), () =>
        db.query(`update public.store_settings set banner_url = $2 where store_id = $1`, [
          storeA,
          brandingPath(TENANT_B.organizationId, storeB),
        ]),
      ),
    )
    expect(message).toMatch(/store_settings_banner_ref/)
  })

  it('RECHAZA un esquema que no es https (javascript:, http:, data:)', async () => {
    for (const value of ['javascript:alert(1)', 'http://inseguro.test/logo.png', 'data:image/png;base64,AAA']) {
      const message = await expectFailure(() =>
        asRole(db, 'authenticated', claimsFor(TENANT_A), () =>
          db.query(`update public.store_settings set logo_url = $2 where store_id = $1`, [
            storeA,
            value,
          ]),
        ),
      )
      expect(message).toMatch(/store_settings_logo_ref/)
    }
  })

  it('un viewer no puede cambiar la configuracion de la tienda', async () => {
    const [before] = await svc(`select accent_color from public.store_settings where store_id = $1`, [
      storeA,
    ])
    await asRole(db, 'authenticated', viewerClaims(), () =>
      db.query(`update public.store_settings set accent_color = '#000000' where store_id = $1`, [
        storeA,
      ]),
    )
    const [after] = await svc(`select accent_color from public.store_settings where store_id = $1`, [
      storeA,
    ])
    expect(after?.accent_color).toBe(before?.accent_color)
  })
})
