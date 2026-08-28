// @vitest-environment node
/**
 * Operaciones de servidor sobre Postgres real: alta atómica de tenant y
 * creación de pedido con precios recalculados en la base.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { TENANT_A, asRole, createTestDatabase, expectFailure } from './harness.ts'

type Row = Record<string, unknown>

let db: PGlite

const ORG = TENANT_A.organizationId
const COMPANY = TENANT_A.companyId
const OWNER = TENANT_A.ownerId

async function svc<T = Row>(query: string, params: unknown[] = []): Promise<T[]> {
  return asRole(db, 'service_role', null, async () => {
    const result = await db.query<T>(query, params)
    return result.rows
  })
}

async function bootstrap(overrides: Partial<Record<string, unknown>> = {}): Promise<Row> {
  const args = {
    org: ORG,
    company: COMPANY,
    tenantSlug: 'cuenta-demo',
    tenantName: 'Cuenta Demo',
    adminEmail: 'admin@cuenta-demo.com',
    owner: OWNER,
    storeSlug: 'tienda-demo',
    storeName: 'Tienda Demo',
    ...overrides,
  }
  const rows = await svc(
    `select public.bootstrap_tenant($1, $2, $3, $4, $5, $6, $7, $8, 'PEN') as result`,
    [
      args.org, args.company, args.tenantSlug, args.tenantName,
      args.adminEmail, args.owner, args.storeSlug, args.storeName,
    ],
  )
  return rows[0]?.result as Row
}

beforeAll(async () => {
  db = await createTestDatabase()
}, 120_000)

// El limite de tasa del checkout (P10) cuenta por correo y por tienda en una
// ventana de una hora. Estos tests hacen decenas de pedidos en segundos, que es
// justo lo que el limite existe para cortar: se reinicia el contador entre
// tests en vez de subir el techo, que dejaria el guard sin probar en produccion.
beforeEach(async () => {
  await svc(`delete from public.checkout_attempts`)
})

afterAll(async () => {
  await db?.close()
})

describe('bootstrap_tenant', () => {
  it('crea tenant, membresia owner, tienda y settings de una vez', async () => {
    const result = await bootstrap()

    expect(result.store_id).toBeTruthy()
    expect(result.owner_member_id).toBeTruthy()

    const [counts] = await svc<Row>(`
      select
        (select count(*) from public.tenants) as tenants,
        (select count(*) from public.tenant_members where role = 'owner') as owners,
        (select count(*) from public.stores) as stores,
        (select count(*) from public.store_settings) as settings
    `)
    expect(counts).toEqual({ tenants: 1, owners: 1, stores: 1, settings: 1 })
  })

  it('la tienda nace en borrador: nada se publica solo', async () => {
    const [store] = await svc(`select status from public.stores`)
    expect(store?.status).toBe('draft')
  })

  it('rechaza el alta sin correo de administrador (contrato §3.2)', async () => {
    const message = await expectFailure(() => bootstrap({ org: crypto.randomUUID(), adminEmail: '' }))
    expect(message).toMatch(/ADMIN_EMAIL_REQUERIDO/)
  })

  it('rechaza un correo @ebim.pe como administrador de tenant (contrato §13)', async () => {
    const message = await expectFailure(() =>
      bootstrap({ org: crypto.randomUUID(), adminEmail: 'dcalagua@ebim.pe' }),
    )
    expect(message).toMatch(/ADMIN_EMAIL_INVALIDO/)
  })

  it('es atomico: un slug de tienda invalido no deja tenant huerfano', async () => {
    const otherOrg = crypto.randomUUID()
    const message = await expectFailure(() =>
      bootstrap({ org: otherOrg, tenantSlug: 'otra-cuenta', storeSlug: 'X' }),
    )
    expect(message).toMatch(/stores_slug_format|violates check constraint/i)

    const [row] = await svc(`select count(*)::int as n from public.tenants where organization_id = $1`, [
      otherOrg,
    ])
    expect(row?.n).toBe(0)
  })

  it('no da de alta dos veces la misma organizacion', async () => {
    const message = await expectFailure(() => bootstrap({ tenantSlug: 'cuenta-demo-2', storeSlug: 'tienda-demo-2' }))
    expect(message).toMatch(/TENANT_YA_EXISTE/)
  })

  it('anon y authenticated no pueden invocarla', async () => {
    for (const role of ['anon', 'authenticated'] as const) {
      const message = await asRole(db, role, null, () =>
        expectFailure(() =>
          db.query(`select public.bootstrap_tenant($1,$2,'x','x','a@b.com',$3,'y','y','PEN')`, [
            crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID(),
          ]),
        ),
      )
      expect(message, `rol ${role}`).toMatch(/permission denied/i)
    }
  })
})

describe('create_order — el precio lo pone la base', () => {
  let storeId: string
  let productId: string

  beforeAll(async () => {
    const [store] = await svc(`select id from public.stores limit 1`)
    storeId = String(store?.id)
    await svc(`update public.stores set status = 'active' where id = $1`, [storeId])
    await svc(`update public.store_settings set tax_rate = 0.1800 where store_id = $1`, [storeId])

    const [product] = await svc(
      `insert into public.products
         (organization_id, company_id, store_id, sku, slug, name, price, currency, stock, status, published_at)
       values ($1, $2, $3, 'SKU-1', 'producto-1', 'Producto 1', '100.00', 'PEN', 50, 'published', now())
       returning id`,
      [ORG, COMPANY, storeId],
    )
    productId = String(product?.id)
  })

  it('ignora por completo el precio y calcula subtotal, impuesto y total', async () => {
    const [row] = await svc(
      `select public.create_order($1, 'cliente@ejemplo.com',
              jsonb_build_array(jsonb_build_object('product_id', $2::text, 'quantity', 3))) as result`,
      [storeId, productId],
    )
    const result = row?.result as Row

    // Texto, no numero JSON: el importe no pasa por un float en ningun punto.
    expect(result.subtotal).toBe('300.00')
    expect(result.tax_total).toBe('54.00')
    expect(result.grand_total).toBe('354.00')
    expect(typeof result.grand_total).toBe('string')
    expect(String(result.order_number)).toMatch(/^EC-\d{8}-\d{5}$/)
  })

  it('rechaza un payload que intenta fijar el precio (contrato §2.6)', async () => {
    const message = await expectFailure(() =>
      svc(
        `select public.create_order($1, 'cliente@ejemplo.com',
                jsonb_build_array(jsonb_build_object(
                  'product_id', $2::text, 'quantity', 1, 'unit_price', '0.01')))`,
        [storeId, productId],
      ),
    )
    expect(message).toMatch(/CAMPO_NO_PERMITIDO/)
  })

  it('descuenta stock y lo respeta', async () => {
    const [before] = await svc(`select stock from public.products where id = $1`, [productId])
    expect(before?.stock).toBe(47) // 50 - 3 del pedido anterior

    const message = await expectFailure(() =>
      svc(
        `select public.create_order($1, 'cliente@ejemplo.com',
                jsonb_build_array(jsonb_build_object('product_id', $2::text, 'quantity', 999)))`,
        [storeId, productId],
      ),
    )
    expect(message).toMatch(/STOCK_INSUFICIENTE/)

    const [after] = await svc(`select stock from public.products where id = $1`, [productId])
    expect(after?.stock).toBe(47)
  })

  it('no vende un producto en borrador', async () => {
    const [draft] = await svc(
      `insert into public.products
         (organization_id, company_id, store_id, sku, slug, name, price, currency, stock, status)
       values ($1, $2, $3, 'SKU-DRAFT', 'borrador', 'Borrador', '10.00', 'PEN', 5, 'draft')
       returning id`,
      [ORG, COMPANY, storeId],
    )
    const message = await expectFailure(() =>
      svc(
        `select public.create_order($1, 'cliente@ejemplo.com',
                jsonb_build_array(jsonb_build_object('product_id', $2::text, 'quantity', 1)))`,
        [storeId, String(draft?.id)],
      ),
    )
    expect(message).toMatch(/PRODUCTO_NO_DISPONIBLE/)
  })

  it('no vende en una tienda que no esta activa', async () => {
    await svc(`update public.stores set status = 'suspended' where id = $1`, [storeId])
    const message = await expectFailure(() =>
      svc(
        `select public.create_order($1, 'cliente@ejemplo.com',
                jsonb_build_array(jsonb_build_object('product_id', $2::text, 'quantity', 1)))`,
        [storeId, productId],
      ),
    )
    expect(message).toMatch(/TIENDA_NO_DISPONIBLE/)
    await svc(`update public.stores set status = 'active' where id = $1`, [storeId])
  })

  it('agrupa lineas repetidas del mismo producto', async () => {
    const [row] = await svc(
      `select public.create_order($1, 'cliente@ejemplo.com',
              jsonb_build_array(
                jsonb_build_object('product_id', $2::text, 'quantity', 2),
                jsonb_build_object('product_id', $2::text, 'quantity', 3))) as result`,
      [storeId, productId],
    )
    const result = row?.result as Row
    expect((result.items as unknown[]).length).toBe(1)
    expect(result.subtotal).toBe('500.00')
  })

  it('el total de linea es GENERATED: no se puede escribir a mano', async () => {
    const message = await expectFailure(() =>
      svc(`update public.order_items set line_total = '0.01'`),
    )
    expect(message).toMatch(/can only be updated to DEFAULT|generated/i)
  })

  it('todo el dinero es numeric, nunca float', async () => {
    const rows = await svc<Row>(`
      select table_name, column_name, data_type
      from information_schema.columns
      where table_schema = 'public'
        and (column_name like '%price%' or column_name like '%total%'
             or column_name = 'subtotal' or column_name = 'tax_rate')
      order by table_name, column_name
    `)
    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) {
      const name = String(row.column_name)
      const signature = `${row.table_name}.${name}:${row.data_type}`
      // P04-SaaS: el filtro por nombre atrapa ahora tambien REFERENCIAS a una
      // lista de precio (`price_list_id`) y el origen del precio
      // (`price_source`), que no son importes. En vez de sacarlos del filtro
      // —que dejaria un hueco por donde colar un importe con ese nombre— se
      // comprueba que cada uno sea del tipo que le toca. La regla queda mas
      // fuerte: un uuid llamado `unit_price` tambien falla aqui.
      if (name.endsWith('_id')) {
        expect(signature).toMatch(/:uuid$/)
      } else if (name === 'price_source') {
        expect(signature).toMatch(/:text$/)
      } else if (name.endsWith('_code')) {
        // P08-SaaS: el snapshot de la linea guarda el CODIGO de la lista que
        // fijo el precio (`price_list_code`), que sobrevive al borrado de la
        // lista. Es un identificador legible, no un importe. Igual que arriba,
        // no se saca del filtro: se le exige ser `text`, asi que un importe
        // llamado `..._code` seguiria fallando aqui.
        expect(signature).toMatch(/:text$/)
      } else {
        expect(signature).toMatch(/:numeric$/)
      }
    }
  })
})

describe('maquina de estados del pedido', () => {
  let orderId: string

  beforeAll(async () => {
    const [order] = await svc(`select id from public.orders order by created_at limit 1`)
    orderId = String(order?.id)
  })

  it('pending -> paid -> fulfilled es valido', async () => {
    await svc(`update public.orders set status = 'paid' where id = $1`, [orderId])
    await svc(`update public.orders set status = 'fulfilled' where id = $1`, [orderId])
    const [row] = await svc(`select status from public.orders where id = $1`, [orderId])
    expect(row?.status).toBe('fulfilled')
  })

  it('un pedido entregado no vuelve a pendiente', async () => {
    const message = await expectFailure(() =>
      svc(`update public.orders set status = 'pending' where id = $1`, [orderId]),
    )
    expect(message).toMatch(/ORDER_TRANSICION_INVALIDA/)
  })

  it('los importes de un pedido son inmutables', async () => {
    const message = await expectFailure(() =>
      svc(`update public.orders set grand_total = '1.00', subtotal = '1.00' where id = $1`, [
        orderId,
      ]),
    )
    expect(message).toMatch(/ORDER_IMPORTES_INMUTABLES/)
  })

  it('el tenant de un pedido es inmutable', async () => {
    const message = await expectFailure(() =>
      svc(`update public.orders set organization_id = gen_random_uuid() where id = $1`, [orderId]),
    )
    expect(message).toMatch(/ORDER_IMPORTES_INMUTABLES/)
  })
})
