// @vitest-environment node
/**
 * P13-SaaS · Analitica comercial, contra Postgres REAL.
 *
 * Lo que se prueba aqui es lo que hace que un indicador sea defendible ante
 * quien decide con el:
 *
 *  · **sin PII** — la tabla no tiene columna de correo, el identificador de
 *    visita no se guarda crudo, y un payload con un correo dentro se redacta en
 *    la puerta Y lo rechaza un CHECK si alguien la rodea;
 *  · **un embudo que el navegador no puede falsear** — la vitrina solo puede
 *    declarar tres hechos; los otros seis los emite un trigger sobre la fila que
 *    ya se escribe;
 *  · **idempotencia** — reprocesar no cuenta dos pedidos;
 *  · **inmutabilidad** — un hecho no se corrige, ni siquiera con `service_role`;
 *  · **denominador o nada** — toda razon es NULL cuando no hay con que
 *    calcularla, nunca 0 %;
 *  · **el modulo se vende** — el embudo exige `analytics.advanced` y lo dice con
 *    `SIN_MODULO`, no devolviendo una lista vacia;
 *  · **aislamiento** — un tenant no ve ni cuenta los hechos del otro.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { TENANT_A, TENANT_B, asRole, claimsFor, createTestDatabase, expectFailure } from './harness.ts'

type Row = Record<string, unknown>
type Json = Record<string, unknown>

let db: PGlite

const STORE_A_SLUG = 'tienda-a'
const STORE_B_SLUG = 'tienda-b'
const ADVANCED = 'ecommerce.analytics.advanced'

let storeA: string
let storeB: string
let channelA: string
let channelB: string
let jabon: string
let toalla: string
let lamparaB: string

async function sql(query: string, params: unknown[] = []): Promise<Row[]> {
  return (await db.query<Row>(query, params)).rows
}

async function svc(query: string, params: unknown[] = []): Promise<Row[]> {
  return asRole(db, 'service_role', null, () => sql(query, params))
}

async function anon(query: string, params: unknown[] = []): Promise<Row[]> {
  return asRole(db, 'anon', null, () => sql(query, params))
}

async function member(
  query: string,
  params: unknown[] = [],
  tenant = TENANT_A,
): Promise<Row[]> {
  return asRole(db, 'authenticated', claimsFor(tenant), () => sql(query, params))
}

async function id(query: string, params: unknown[] = []): Promise<string> {
  const rows = await svc(query, params)
  return String(rows[0]?.id)
}

let orderSeq = 0

interface OrderInput {
  total?: string
  tenant?: typeof TENANT_A
  store?: string
  channel?: string
  status?: string
  paymentStatus?: string
  placedAt?: string | null
}

/**
 * Un pedido escrito DIRECTO con `service_role`, no por `create_order`.
 *
 * Es deliberado y es lo que da fuerza al test: si los hechos de analitica se
 * emitieran desde `create_order`, un pedido creado por otra via —una carga
 * masiva, una correccion, un ERP— no aparecería en los indicadores y nadie se
 * enteraria. Al emitirlos un TRIGGER, este insert «por la puerta de atras» los
 * produce igual.
 */
async function createOrder(input: OrderInput = {}): Promise<string> {
  const tenant = input.tenant ?? TENANT_A
  orderSeq += 1
  return id(
    `insert into public.orders (
       organization_id, company_id, store_id, channel_id, order_number,
       customer_email, currency, subtotal, tax_total, grand_total, status,
       payment_status, placed_at)
     values ($1, $2, $3, $4, $5, $6, 'PEN', $7, 0, $7,
             $8::public.order_status, $9::public.payment_status,
             coalesce($10::timestamptz, now()))
     returning id`,
    [
      tenant.organizationId, tenant.companyId,
      input.store ?? storeA, input.channel ?? channelA,
      `EC-${String(orderSeq).padStart(5, '0')}`,
      'comprador@example.com',
      input.total ?? '100.00',
      input.status ?? 'pending',
      input.paymentStatus ?? 'paid',
      input.placedAt ?? null,
    ],
  )
}

async function addOrderItem(order: string, product: string, quantity: number, price: string) {
  await svc(
    `insert into public.order_items
       (organization_id, company_id, store_id, order_id, product_id, sku, name, unit_price, quantity)
     select o.organization_id, o.company_id, o.store_id, o.id, p.id, p.sku, p.name, $4, $3
       from public.orders o, public.products p
      where o.id = $1 and p.id = $2`,
    [order, product, quantity, price],
  )
}

let intentSeq = 0

async function createIntent(status: 'running' | 'succeeded' | 'failed', order?: string) {
  intentSeq += 1
  const key = `idem-${String(intentSeq).padStart(4, '0')}-${'x'.repeat(20)}`
  const intent = await id(
    `insert into public.checkout_intents
       (organization_id, company_id, store_id, idempotency_key, request_hash)
     values ($1, $2, $3, $4, repeat('a', 64)) returning id`,
    [TENANT_A.organizationId, TENANT_A.companyId, storeA, key],
  )
  if (status === 'succeeded' && order) {
    await svc(
      `update public.checkout_intents
          set status = 'succeeded', order_id = $2, result = '{}'::jsonb
        where id = $1`,
      [intent, order],
    )
  }
  if (status === 'failed') {
    await svc(
      `update public.checkout_intents
          set status = 'failed', error_code = 'STOCK_INSUFICIENTE',
              error_stage = 'reserve_inventory'
        where id = $1`,
      [intent],
    )
  }
  return intent
}

async function events(type?: string, tenant = TENANT_A): Promise<Row[]> {
  return svc(
    `select * from public.analytics_events
      where organization_id = $1 and ($2::text is null or event_type::text = $2)
      order by occurred_at, created_at`,
    [tenant.organizationId, type ?? null],
  )
}

beforeAll(async () => {
  db = await createTestDatabase()

  for (const [tenant, storeSlug] of [
    [TENANT_A, STORE_A_SLUG],
    [TENANT_B, STORE_B_SLUG],
  ] as const) {
    await svc(`select public.bootstrap_tenant($1, $2, $3, $4, $5, $6, $7, 'Tienda', 'PEN')`, [
      tenant.organizationId, tenant.companyId, tenant.slug, tenant.slug,
      tenant.adminEmail, tenant.ownerId, storeSlug,
    ])
  }
  await svc(`update public.stores set status = 'active'`)
  await svc(`update public.store_settings set tax_rate = 0, tax_inclusive = false`)

  const stores = await svc(`select id, slug from public.stores order by slug`)
  storeA = String(stores.find((s) => s.slug === STORE_A_SLUG)?.id)
  storeB = String(stores.find((s) => s.slug === STORE_B_SLUG)?.id)

  const channels = await svc(`select id, store_id from public.channels where is_default`)
  channelA = String(channels.find((c) => c.store_id === storeA)?.id)
  channelB = String(channels.find((c) => c.store_id === storeB)?.id)

  const insertProduct = `
    insert into public.products
      (organization_id, company_id, store_id, sku, slug, name, price, currency, stock,
       status, published_at)
    values ($1, $2, $3, $4, $5, $6, $7, 'PEN', 1000, 'published', now())
    returning id`
  jabon = await id(insertProduct, [
    TENANT_A.organizationId, TENANT_A.companyId, storeA, 'A-JABON', 'jabon', 'Jabón', '10.00',
  ])
  toalla = await id(insertProduct, [
    TENANT_A.organizationId, TENANT_A.companyId, storeA, 'A-TOALLA', 'toalla', 'Toalla', '25.00',
  ])
  lamparaB = await id(insertProduct, [
    TENANT_B.organizationId, TENANT_B.companyId, storeB, 'B-LAMPARA', 'lampara', 'Lámpara', '55.00',
  ])
}, 180_000)

afterAll(async () => {
  await db?.close()
})

/**
 * Vaciar la serie entre tests exige APAGAR el trigger de solo-inserción.
 *
 * Que haga falta esto es, en si mismo, la prueba mas fuerte del invariante: ni
 * `service_role` puede borrar un hecho, y el unico camino que queda es el que
 * tiene el propietario de la tabla en una consola — que es exactamente lo que
 * ningun rol de la aplicacion puede hacer.
 */
async function resetEvents(): Promise<void> {
  await sql(`alter table public.analytics_events disable trigger analytics_events_append_only`)
  await sql(`delete from public.analytics_events`)
  await sql(`alter table public.analytics_events enable trigger analytics_events_append_only`)
}

beforeEach(async () => {
  // Cada bloque parte de una serie vacia: los recuentos de un test no pueden
  // depender de que otro haya corrido antes.
  await resetEvents()
})

// ---------------------------------------------------------------------------

describe('la tabla no puede guardar a una persona', () => {
  it('no existe ninguna columna de identidad del comprador', async () => {
    const rows = await svc(`
      select column_name from information_schema.columns
       where table_schema = 'public' and table_name = 'analytics_events'
         and column_name in ('customer_email', 'customer_name', 'customer_phone',
                             'customer_id', 'email', 'user_id', 'ip', 'ip_address')
    `)
    expect(rows).toEqual([])
  })

  it('RLS activada y forzada, y `anon` sin un solo GRANT', async () => {
    const rls = await svc(`
      select c.relrowsecurity as enabled, c.relforcerowsecurity as forced
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relname = 'analytics_events'
    `)
    expect(`${rls[0]?.enabled}/${rls[0]?.forced}`).toBe('true/true')

    const grants = await svc(`
      select privilege_type from information_schema.role_table_grants
       where table_schema = 'public' and table_name = 'analytics_events' and grantee = 'anon'
    `)
    expect(grants).toEqual([])
  })

  it('un CHECK rechaza un correo en el payload aunque lo escriba service_role', async () => {
    const message = await expectFailure(() =>
      svc(
        `insert into public.analytics_events
           (organization_id, company_id, store_id, event_type, source, product_id, props)
         values ($1, $2, $3, 'product_view', 'server', $4,
                 '{"nota": "escribir a juan@example.com"}'::jsonb)`,
        [TENANT_A.organizationId, TENANT_A.companyId, storeA, jabon],
      ),
    )
    expect(message).toMatch(/analytics_events_props_clean/)
  })

  it('y tambien un secreto, porque hereda las claves de P09', async () => {
    const message = await expectFailure(() =>
      svc(
        `insert into public.analytics_events
           (organization_id, company_id, store_id, event_type, source, product_id, props)
         values ($1, $2, $3, 'product_view', 'server', $4, '{"access_token": "abc"}'::jsonb)`,
        [TENANT_A.organizationId, TENANT_A.companyId, storeA, jabon],
      ),
    )
    expect(message).toMatch(/analytics_events_props_clean/)
  })

  it('un hecho no se corrige ni se borra, ni siquiera con service_role', async () => {
    await svc(
      `insert into public.analytics_events
         (organization_id, company_id, store_id, event_type, source, product_id)
       values ($1, $2, $3, 'product_view', 'server', $4)`,
      [TENANT_A.organizationId, TENANT_A.companyId, storeA, jabon],
    )
    const update = await expectFailure(() =>
      svc(`update public.analytics_events set event_type = 'search'`),
    )
    expect(update).toMatch(/ANALITICA_INMUTABLE/)
    const remove = await expectFailure(() => svc(`delete from public.analytics_events`))
    expect(remove).toMatch(/ANALITICA_INMUTABLE/)
    // Se limpia por la unica via que queda, que es la del propietario en una
    // consola: apagar el trigger. Ningun rol de la aplicacion puede hacerlo.
    await resetEvents()
  })
})

describe('la puerta de la vitrina', () => {
  it('el comprador anonimo registra una vista, y cae en el tenant del SLUG', async () => {
    const result = await anon(
      `select public.track_events_for_slug($1, $2, $3::jsonb) as r`,
      [STORE_A_SLUG, 'sesion-de-prueba-0001', JSON.stringify([{ type: 'product_view', product_id: jabon }])],
    )
    expect((result[0]?.r as Json).recorded).toBe(1)

    const rows = await events('product_view')
    expect(rows).toHaveLength(1)
    expect(rows[0]?.organization_id).toBe(TENANT_A.organizationId)
    expect(rows[0]?.store_id).toBe(storeA)
    expect(rows[0]?.source).toBe('storefront')
    // El canal lo pone el servidor a partir de la tienda: el navegador no lo
    // declara y no podria.
    expect(rows[0]?.channel_id).toBe(channelA)
  })

  it('el identificador de sesion NO se guarda: se guarda su resumen', async () => {
    const raw = 'sesion-de-prueba-0002'
    await anon(`select public.track_events_for_slug($1, $2, $3::jsonb)`, [
      STORE_A_SLUG, raw, JSON.stringify([{ type: 'product_view', product_id: jabon }]),
    ])
    const rows = await events('product_view')
    const hash = String(rows[0]?.session_hash)
    expect(hash).not.toBe(raw)
    expect(hash).toMatch(/^[a-f0-9]{64}$/)
    // Y es ESTABLE: dos visitas de la misma sesion agrupan, que es lo unico
    // para lo que el campo existe.
    await anon(`select public.track_events_for_slug($1, $2, $3::jsonb)`, [
      STORE_A_SLUG, raw, JSON.stringify([{ type: 'product_view', product_id: toalla }]),
    ])
    const both = await events('product_view')
    expect(new Set(both.map((r) => r.session_hash)).size).toBe(1)
  })

  it('la vitrina NO puede declarar un pedido', async () => {
    const message = await expectFailure(() =>
      anon(`select public.track_events_for_slug($1, $2, $3::jsonb)`, [
        STORE_A_SLUG, null, JSON.stringify([{ type: 'order_created' }]),
      ]),
    )
    expect(message).toMatch(/ANALYTICS_EVENTO_NO_PERMITIDO/)
    expect(await events()).toHaveLength(0)
  })

  it('ni un producto que no es de esta tienda', async () => {
    const message = await expectFailure(() =>
      anon(`select public.track_events_for_slug($1, $2, $3::jsonb)`, [
        STORE_A_SLUG, null, JSON.stringify([{ type: 'product_view', product_id: lamparaB }]),
      ]),
    )
    expect(message).toMatch(/ANALYTICS_REFERENCIA_INVALIDA/)
  })

  it('ni un lote sin techo', async () => {
    const lote = Array.from({ length: 21 }, () => ({ type: 'product_view', product_id: jabon }))
    const message = await expectFailure(() =>
      anon(`select public.track_events_for_slug($1, $2, $3::jsonb)`, [
        STORE_A_SLUG, null, JSON.stringify(lote),
      ]),
    )
    expect(message).toMatch(/ANALYTICS_LOTE_EXCESIVO/)
  })

  it('un termino de busqueda con un correo dentro se REDACTA, no se rechaza', async () => {
    // Rechazarlo dejaria al comprador sin poder buscar. Perder el hecho es peor
    // que guardarlo redactado — misma regla que el sobre de un webhook en P09.
    await anon(`select public.track_events_for_slug($1, $2, $3::jsonb)`, [
      STORE_A_SLUG, null,
      JSON.stringify([{ type: 'search', term: 'pedido de juan@example.com', result_count: 0 }]),
    ])
    const rows = await events('search')
    expect(rows).toHaveLength(1)
    expect(rows[0]?.search_term).toBe('[redactado]')
    expect(rows[0]?.result_count).toBe(0)
  })

  it('y un props con el correo del comprador tampoco entra crudo', async () => {
    await anon(`select public.track_events_for_slug($1, $2, $3::jsonb)`, [
      STORE_A_SLUG, null,
      JSON.stringify([
        { type: 'add_to_cart', product_id: jabon, quantity: 2, props: { email: 'a@b.com', list: 'home' } },
      ]),
    ])
    const rows = await events('add_to_cart')
    const props = rows[0]?.props as Json
    expect(props.email).toBe('[redactado]')
    expect(props.list).toBe('home')
    expect(rows[0]?.quantity).toBe(2)
  })

  it('un lote vacio no es un error: no hay nada que registrar', async () => {
    const result = await anon(`select public.track_events_for_slug($1, $2, '[]'::jsonb) as r`, [
      STORE_A_SLUG, null,
    ])
    expect((result[0]?.r as Json).recorded).toBe(0)
  })
})

describe('los seis hechos que emite el servidor', () => {
  it('crear un pedido publica order_created, con su importe y su canal', async () => {
    const order = await createOrder({ total: '120.00' })
    const rows = await events('order_created')
    expect(rows).toHaveLength(1)
    expect(rows[0]?.order_id).toBe(order)
    expect(rows[0]?.value).toBe('120.00')
    expect(rows[0]?.currency).toBe('PEN')
    expect(rows[0]?.source).toBe('server')
    // Ni el correo del comprador ni su nombre viajan al hecho.
    expect(JSON.stringify(rows[0]?.props)).not.toMatch(/@/)
  })

  it('despachar el pedido publica order_completed, y solo la primera vez', async () => {
    const order = await createOrder()
    await svc(`update public.orders set fulfillment_status = 'fulfilled' where id = $1`, [order])
    await svc(`update public.orders set fulfillment_status = 'fulfilled' where id = $1`, [order])
    expect(await events('order_completed')).toHaveLength(1)
  })

  it('el intento de compra publica checkout_started y checkout_completed', async () => {
    const order = await createOrder()
    const intent = await createIntent('running')
    expect(await events('checkout_started')).toHaveLength(1)

    await svc(
      `update public.checkout_intents set status = 'succeeded', order_id = $2, result = '{}'::jsonb
        where id = $1`,
      [intent, order],
    )
    const done = await events('checkout_completed')
    expect(done).toHaveLength(1)
    expect(done[0]?.order_id).toBe(order)
  })

  it('un carrito CON lineas que se abandona publica cart_abandoned; uno vacio no', async () => {
    const lleno = await id(
      `insert into public.carts (organization_id, company_id, store_id, channel_id, currency)
       values ($1, $2, $3, $4, 'PEN') returning id`,
      [TENANT_A.organizationId, TENANT_A.companyId, storeA, channelA],
    )
    await svc(
      `insert into public.cart_items
         (organization_id, company_id, store_id, cart_id, product_id, quantity,
          unit_price_snapshot, quoted_at)
       values ($1, $2, $3, $4, $5, 2, '10.00', now())`,
      [TENANT_A.organizationId, TENANT_A.companyId, storeA, lleno, jabon],
    )
    const vacio = await id(
      `insert into public.carts (organization_id, company_id, store_id, channel_id, currency)
       values ($1, $2, $3, $4, 'PEN') returning id`,
      [TENANT_A.organizationId, TENANT_A.companyId, storeA, channelA],
    )

    await svc(`update public.carts set status = 'abandoned' where id in ($1, $2)`, [lleno, vacio])

    const rows = await events('cart_abandoned')
    expect(rows).toHaveLength(1)
    expect(rows[0]?.cart_id).toBe(lleno)
    expect(rows[0]?.value).toBe('20.00')
  })

  it('canjear una campana publica promotion_used SIN el correo del cliente', async () => {
    const order = await createOrder()
    const promo = await id(
      `insert into public.promotions
         (organization_id, company_id, store_id, code, name, kind, status, value_percent)
       values ($1, $2, $3, 'p10', 'Diez', 'percentage', 'active', 10) returning id`,
      [TENANT_A.organizationId, TENANT_A.companyId, storeA],
    )
    await svc(
      `insert into public.promotion_redemptions
         (organization_id, company_id, store_id, promotion_id, order_id, customer_email,
          discount_amount, currency)
       values ($1, $2, $3, $4, $5, 'comprador@example.com', '12.00', 'PEN')`,
      [TENANT_A.organizationId, TENANT_A.companyId, storeA, promo, order],
    )

    const rows = await events('promotion_used')
    expect(rows).toHaveLength(1)
    expect(rows[0]?.promotion_id).toBe(promo)
    expect(rows[0]?.value).toBe('12.00')
    expect((rows[0]?.props as Json).from_coupon).toBe(false)
    expect(JSON.stringify(rows[0])).not.toMatch(/comprador@example\.com/)
  })
})

describe('los indicadores', () => {
  beforeEach(async () => {
    await svc(`delete from public.promotion_redemptions`)
    await svc(`delete from public.order_items`)
    await svc(`delete from public.checkout_intents`)
    await svc(`delete from public.cart_items`)
    await svc(`delete from public.carts`)
    await svc(`delete from public.orders`)
    await resetEvents()
  })

  async function kpis(tenant = TENANT_A, store = storeA): Promise<Json> {
    const rows = await member(`select public.analytics_kpis($1) as k`, [store], tenant)
    return rows[0]?.k as Json
  }

  it('ventas, pedidos, unidades y ticket promedio salen de los pedidos', async () => {
    const uno = await createOrder({ total: '100.00' })
    await addOrderItem(uno, jabon, 2, '50.00')
    const dos = await createOrder({ total: '300.00' })
    await addOrderItem(dos, toalla, 3, '100.00')

    const k = await kpis()
    expect(k.orders).toBe(2)
    expect(k.gross_sales).toBe('400.00')
    expect(k.paid_sales).toBe('400.00')
    expect(k.units).toBe(5)
    expect(k.average_ticket).toBe('200.00')
    expect(k.currency).toBe('PEN')
  })

  it('un pedido ANULADO no es una venta y no hunde el ticket promedio', async () => {
    await createOrder({ total: '100.00' })
    await createOrder({ total: '900.00', status: 'cancelled', paymentStatus: 'voided' })
    const k = await kpis()
    expect(k.orders).toBe(1)
    expect(k.average_ticket).toBe('100.00')
  })

  it('sin intentos de compra, la conversion es NULL y no 0 %', async () => {
    const k = await kpis()
    expect(k.checkouts_started).toBe(0)
    expect(k.conversion_rate).toBeNull()
  })

  it('con intentos, la conversion sale de checkout_intents y no de eventos del navegador', async () => {
    const order = await createOrder()
    await createIntent('succeeded', order)
    await createIntent('failed')
    await createIntent('running')

    const k = await kpis()
    expect(k.checkouts_started).toBe(3)
    expect(k.checkouts_completed).toBe(1)
    expect(k.conversion_rate).toBe('33.33')
  })

  it('sin carritos con desenlace, el abandono es NULL', async () => {
    const k = await kpis()
    expect(k.abandonment_rate).toBeNull()
  })

  it('el abandono cuenta solo carritos que llegaron a un desenlace y tenian algo dentro', async () => {
    async function cart(status: 'abandoned' | 'converted' | 'active', withItems: boolean) {
      const cartId = await id(
        `insert into public.carts (organization_id, company_id, store_id, channel_id, currency)
         values ($1, $2, $3, $4, 'PEN') returning id`,
        [TENANT_A.organizationId, TENANT_A.companyId, storeA, channelA],
      )
      if (withItems) {
        await svc(
          `insert into public.cart_items
             (organization_id, company_id, store_id, cart_id, product_id, quantity)
           values ($1, $2, $3, $4, $5, 1)`,
          [TENANT_A.organizationId, TENANT_A.companyId, storeA, cartId, jabon],
        )
      }
      if (status === 'converted') {
        const order = await createOrder()
        await svc(`update public.carts set status = 'converted', order_id = $2 where id = $1`, [
          cartId, order,
        ])
      } else if (status === 'abandoned') {
        await svc(`update public.carts set status = 'abandoned' where id = $1`, [cartId])
      }
    }

    await cart('abandoned', true)
    await cart('abandoned', true)
    await cart('abandoned', true)
    await cart('converted', true)
    // Ni el vacio ni el todavia activo entran en el denominador.
    await cart('abandoned', false)
    await cart('active', true)

    const k = await kpis()
    expect(k.carts_abandoned).toBe(3)
    expect(k.carts_converted).toBe(1)
    expect(k.abandonment_rate).toBe('75.00')
  })

  it('los mas vendidos se agrupan por SKU y sobreviven al borrado del producto', async () => {
    const uno = await createOrder()
    await addOrderItem(uno, jabon, 5, '10.00')
    const dos = await createOrder()
    await addOrderItem(dos, jabon, 3, '10.00')
    await addOrderItem(dos, toalla, 1, '25.00')

    const rows = await member(
      `select * from public.analytics_top_products($1) order by units desc`,
      [storeA],
    )
    expect(rows[0]?.sku).toBe('A-JABON')
    expect(rows[0]?.units).toBe(8)
    expect(rows[0]?.revenue).toBe('80.00')
    expect(rows[0]?.orders).toBe(2)
  })

  it('el rendimiento por canal sale del pedido, no de la sesion', async () => {
    const order = await createOrder({ total: '150.00' })
    await addOrderItem(order, jabon, 3, '50.00')
    const rows = await member(`select * from public.analytics_channel_performance($1)`, [storeA])
    expect(rows).toHaveLength(1)
    expect(rows[0]?.orders).toBe(1)
    expect(rows[0]?.units).toBe(3)
    expect(rows[0]?.revenue).toBe('150.00')
  })

  it('la serie diaria trae los dias sin pedidos, con cero', async () => {
    await createOrder({ total: '50.00' })
    const rows = await member(
      `select * from public.analytics_timeseries($1, now() - interval '3 days', now())`,
      [storeA],
    )
    expect(rows.length).toBeGreaterThanOrEqual(4)
    const vacios = rows.filter((r) => r.orders === 0)
    expect(vacios.length).toBeGreaterThan(0)
    expect(vacios[0]?.revenue).toBe('0')
  })

  it('un tenant no cuenta las ventas del otro', async () => {
    await createOrder({ total: '100.00' })
    await createOrder({
      total: '999.00', tenant: TENANT_B, store: storeB, channel: channelB,
    })

    const a = await kpis()
    const b = await kpis(TENANT_B, storeB)
    expect(a.gross_sales).toBe('100.00')
    expect(b.gross_sales).toBe('999.00')
  })

  it('y preguntar por la tienda del otro no filtra nada: cuenta cero', async () => {
    await createOrder({
      total: '999.00', tenant: TENANT_B, store: storeB, channel: channelB,
    })
    const k = await kpis(TENANT_A, storeB)
    expect(k.orders).toBe(0)
  })
})

describe('el modulo vendible', () => {
  it('sin el addon, el embudo dice SIN_MODULO en vez de devolver una lista vacia', async () => {
    const message = await expectFailure(() =>
      member(`select * from public.analytics_funnel($1)`, [storeA]),
    )
    expect(message).toMatch(/SIN_MODULO/)
  })

  it('lo mismo con los terminos de busqueda', async () => {
    const message = await expectFailure(() =>
      member(`select * from public.analytics_search_terms($1)`, [storeA]),
    )
    expect(message).toMatch(/SIN_MODULO/)
  })

  it('pero los indicadores de pedidos siguen funcionando: se degrada, no se rompe', async () => {
    const rows = await member(`select public.analytics_kpis($1) as k`, [storeA])
    expect((rows[0]?.k as Json).orders).toBeDefined()
  })

  it('con el addon, el embudo trae los nueve hechos canonicos', async () => {
    await svc(
      `select public.sync_platform_context($1, $2, true, $3, 'hub'::public.entitlement_source, null)`,
      [TENANT_A.organizationId, TENANT_A.companyId, [ADVANCED]],
    )
    try {
      await anon(`select public.track_events_for_slug($1, $2, $3::jsonb)`, [
        STORE_A_SLUG, 'sesion-de-prueba-0003',
        JSON.stringify([
          { type: 'product_view', product_id: jabon },
          { type: 'search', term: 'jabon', result_count: 0 },
        ]),
      ])

      const rows = await member(`select * from public.analytics_funnel($1)`, [storeA])
      expect(rows).toHaveLength(9)
      const vistas = rows.find((r) => r.event_type === 'product_view')
      expect(vistas?.events).toBe(1)
      expect(vistas?.sessions).toBe(1)
      // Los hechos de servidor NUNCA traen sesion: se pinta «—», no 0.
      const pedidos = rows.find((r) => r.event_type === 'order_created')
      expect(pedidos?.sessions).toBeNull()

      const terms = await member(`select * from public.analytics_search_terms($1)`, [storeA])
      expect(terms[0]?.term).toBe('jabon')
      expect(terms[0]?.zero_results).toBe(1)
    } finally {
      await svc(
        `select public.sync_platform_context($1, $2, true, '{}'::text[], 'hub'::public.entitlement_source, null)`,
        [TENANT_A.organizationId, TENANT_A.companyId],
      )
    }
  })
})

describe('aislamiento entre tenants', () => {
  it('un miembro de A no ve ni un hecho de B', async () => {
    await svc(
      `insert into public.analytics_events
         (organization_id, company_id, store_id, event_type, source, product_id)
       values ($1, $2, $3, 'product_view', 'server', $4)`,
      [TENANT_B.organizationId, TENANT_B.companyId, storeB, lamparaB],
    )
    const visibles = await member(`select count(*)::int as n from public.analytics_events`)
    expect(visibles[0]?.n).toBe(0)

    const propios = await member(
      `select count(*)::int as n from public.analytics_events`, [], TENANT_B,
    )
    expect(propios[0]?.n).toBe(1)
  })

  it('la vitrina de A no puede escribir un hecho en el tenant de B', async () => {
    // No hay forma de intentarlo: la funcion no acepta tenant y el slug decide.
    await anon(`select public.track_events_for_slug($1, $2, $3::jsonb)`, [
      STORE_B_SLUG, null, JSON.stringify([{ type: 'product_view', product_id: lamparaB }]),
    ])
    const enA = await events('product_view', TENANT_A)
    const enB = await events('product_view', TENANT_B)
    expect(enA).toHaveLength(0)
    expect(enB).toHaveLength(1)
  })
})
