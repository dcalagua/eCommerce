// @vitest-environment node
/**
 * Checkout público sobre Postgres real (P06).
 *
 * `create_order_for_slug` es la puerta por la que entra un comprador ANÓNIMO,
 * así que lo que se prueba aquí es exactamente lo que no puede fallar:
 *  - la tienda la resuelve el servidor a partir del slug, y solo si está activa;
 *  - el precio, el impuesto y el total salen de la base, no del carrito;
 *  - un producto de otra tienda no se cuela aunque se conozca su uuid;
 *  - el pedido y sus líneas se insertan en la MISMA transacción, o no se
 *    inserta nada;
 *  - el número de pedido lo genera la base y el estado inicial es `pending`;
 *  - ni `anon` ni `authenticated` pueden invocar la función.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { TENANT_A, TENANT_B, asRole, createTestDatabase, expectFailure } from './harness.ts'

type Row = Record<string, unknown>

let db: PGlite

const STORE_A_SLUG = 'tienda-a'
const STORE_B_SLUG = 'tienda-b'

let storeA: string
let storeB: string
let sillaA: string
let mesaA: string
let borradorA: string
let productoB: string

async function svc<T = Row>(query: string, params: unknown[] = []): Promise<T[]> {
  return asRole(db, 'service_role', null, async () => {
    const result = await db.query<T>(query, params)
    return result.rows
  })
}

/** Alta de un tenant con su tienda, ya activa y con impuesto configurado. */
async function bootstrap(
  tenant: typeof TENANT_A,
  storeSlug: string,
  taxRate: string,
): Promise<string> {
  await svc(
    `select public.bootstrap_tenant($1, $2, $3, $4, $5, $6, $7, 'Tienda', 'PEN')`,
    [
      tenant.organizationId,
      tenant.companyId,
      tenant.slug,
      tenant.slug,
      tenant.adminEmail,
      tenant.ownerId,
      storeSlug,
    ],
  )
  const [store] = await svc(`select id from public.stores where slug = $1`, [storeSlug])
  const storeId = String(store?.id)
  await svc(`update public.stores set status = 'active' where id = $1`, [storeId])
  await svc(`update public.store_settings set tax_rate = $2 where store_id = $1`, [
    storeId,
    taxRate,
  ])
  return storeId
}

async function addProduct(
  tenant: typeof TENANT_A,
  storeId: string,
  values: { sku: string; slug: string; price: string; stock: number; status?: string },
): Promise<string> {
  const [row] = await svc(
    `insert into public.products
       (organization_id, company_id, store_id, sku, slug, name, price, currency, stock, status, published_at)
     values ($1, $2, $3, $4, $5, $5, $6, 'PEN', $7, $8::public.product_status,
             case when $8::text = 'published' then now() else null end)
     returning id`,
    [
      tenant.organizationId,
      tenant.companyId,
      storeId,
      values.sku,
      values.slug,
      values.price,
      values.stock,
      values.status ?? 'published',
    ],
  )
  return String(row?.id)
}

/** Llama al checkout tal y como lo hace la Edge Function. */
async function checkout(
  slug: string,
  items: Array<{ product_id: string; quantity: number }>,
  options: { email?: string; address?: Row } = {},
): Promise<Row> {
  const rows = await svc(
    `select public.create_order_for_slug(
        $1, $2, $3::jsonb, 'Ana Compradora', '+51 999 111 222', $4::jsonb, null) as result`,
    [
      slug,
      options.email ?? 'ana@compradora.com',
      JSON.stringify(items),
      JSON.stringify(options.address ?? { address: 'Av. Primavera 120', reference: 'Portón verde' }),
    ],
  )
  return rows[0]?.result as Row
}

beforeAll(async () => {
  db = await createTestDatabase()
  storeA = await bootstrap(TENANT_A, STORE_A_SLUG, '0.1800')
  storeB = await bootstrap(TENANT_B, STORE_B_SLUG, '0.0000')

  sillaA = await addProduct(TENANT_A, storeA, { sku: 'A-SILLA', slug: 'silla', price: '100.00', stock: 20 })
  mesaA = await addProduct(TENANT_A, storeA, { sku: 'A-MESA', slug: 'mesa', price: '49.90', stock: 5 })
  borradorA = await addProduct(TENANT_A, storeA, {
    sku: 'A-BORRADOR',
    slug: 'borrador',
    price: '10.00',
    stock: 9,
    status: 'draft',
  })
  productoB = await addProduct(TENANT_B, storeB, { sku: 'B-LAMPARA', slug: 'lampara', price: '80.00', stock: 7 })
}, 120_000)

afterAll(async () => {
  await db?.close()
})

describe('la tienda la resuelve el servidor', () => {
  it('el slug de la URL basta: el pedido queda en la tienda y el tenant correctos', async () => {
    const result = await checkout(STORE_A_SLUG, [{ product_id: sillaA, quantity: 1 }])

    const [order] = await svc(
      `select store_id, organization_id, company_id, status, currency
         from public.orders where id = $1`,
      [result.order_id],
    )
    expect(order?.store_id).toBe(storeA)
    expect(order?.organization_id).toBe(TENANT_A.organizationId)
    expect(order?.company_id).toBe(TENANT_A.companyId)
    expect(order?.status).toBe('pending')
    expect(order?.currency).toBe('PEN')
  })

  it('el slug se normaliza: mayúsculas y espacios no despistan al servidor', async () => {
    const result = await checkout(`  ${STORE_A_SLUG.toUpperCase()}  `, [
      { product_id: sillaA, quantity: 1 },
    ])
    expect(result.order_id).toBeTruthy()
  })

  it('una tienda que no existe no vende', async () => {
    const message = await expectFailure(() =>
      checkout('tienda-inventada', [{ product_id: sillaA, quantity: 1 }]),
    )
    expect(message).toMatch(/TIENDA_NO_DISPONIBLE/)
  })

  it('una tienda que no está activa tampoco vende', async () => {
    await svc(`update public.stores set status = 'draft' where id = $1`, [storeB])
    const message = await expectFailure(() =>
      checkout(STORE_B_SLUG, [{ product_id: productoB, quantity: 1 }]),
    )
    expect(message).toMatch(/TIENDA_NO_DISPONIBLE/)
    await svc(`update public.stores set status = 'active' where id = $1`, [storeB])
  })

  it('un producto de OTRA tienda no se cuela aunque se conozca su uuid', async () => {
    const message = await expectFailure(() =>
      checkout(STORE_A_SLUG, [{ product_id: productoB, quantity: 1 }]),
    )
    expect(message).toMatch(/PRODUCTO_NO_DISPONIBLE/)

    // Y no dejó rastro: ni pedido en la tienda A, ni stock movido en la B.
    const [stock] = await svc(`select stock from public.products where id = $1`, [productoB])
    expect(stock?.stock).toBe(7)
  })
})

describe('el importe lo calcula la base', () => {
  it('recalcula subtotal, impuesto y total con los precios vigentes', async () => {
    // 2 sillas a 100.00 + 3 mesas a 49.90 = 349.70; 18 % = 62.95; total 412.65.
    const result = await checkout(STORE_A_SLUG, [
      { product_id: sillaA, quantity: 2 },
      { product_id: mesaA, quantity: 3 },
    ])

    expect(result.subtotal).toBe('349.70')
    expect(result.tax_total).toBe('62.95')
    expect(result.grand_total).toBe('412.65')
    // Texto, no número JSON: el céntimo no pasa por un float.
    expect(typeof result.grand_total).toBe('string')

    const [order] = await svc(
      `select subtotal::text, tax_total::text, grand_total::text
         from public.orders where id = $1`,
      [result.order_id],
    )
    expect(order).toEqual({ subtotal: '349.70', tax_total: '62.95', grand_total: '412.65' })
  })

  it('el precio que manda el cliente se RECHAZA, no se ignora', async () => {
    const message = await expectFailure(() =>
      svc(
        `select public.create_order_for_slug($1, 'ana@compradora.com',
           jsonb_build_array(jsonb_build_object(
             'product_id', $2::text, 'quantity', 1, 'unit_price', '0.01')))`,
        [STORE_A_SLUG, sillaA],
      ),
    )
    expect(message).toMatch(/CAMPO_NO_PERMITIDO/)
  })

  it('un cambio de precio en el catálogo se refleja en el pedido siguiente', async () => {
    await svc(`update public.products set price = '120.00' where id = $1`, [sillaA])
    const result = await checkout(STORE_A_SLUG, [{ product_id: sillaA, quantity: 1 }])
    expect(result.subtotal).toBe('120.00')

    const [item] = await svc(
      `select unit_price::text, line_total::text from public.order_items where order_id = $1`,
      [result.order_id],
    )
    expect(item).toEqual({ unit_price: '120.00', line_total: '120.00' })
    await svc(`update public.products set price = '100.00' where id = $1`, [sillaA])
  })

  it('la línea repetida se agrupa: dos veces "1 silla" es una línea de 2', async () => {
    const result = await checkout(STORE_A_SLUG, [
      { product_id: sillaA, quantity: 1 },
      { product_id: sillaA, quantity: 1 },
    ])

    const items = await svc(`select quantity from public.order_items where order_id = $1`, [
      result.order_id,
    ])
    expect(items).toHaveLength(1)
    expect(items[0]?.quantity).toBe(2)
  })
})

describe('validaciones de producto y cantidad', () => {
  it('un producto en borrador no se vende', async () => {
    const message = await expectFailure(() =>
      checkout(STORE_A_SLUG, [{ product_id: borradorA, quantity: 1 }]),
    )
    expect(message).toMatch(/PRODUCTO_NO_DISPONIBLE/)
  })

  it('no se venden más unidades de las que hay', async () => {
    const message = await expectFailure(() =>
      checkout(STORE_A_SLUG, [{ product_id: mesaA, quantity: 9999 }]),
    )
    expect(message).toMatch(/STOCK_INSUFICIENTE/)
  })

  it('una cantidad de cero o negativa no pasa', async () => {
    for (const quantity of [0, -2]) {
      const message = await expectFailure(() =>
        checkout(STORE_A_SLUG, [{ product_id: sillaA, quantity }]),
      )
      expect(message, `cantidad ${quantity}`).toMatch(/CANTIDAD_INVALIDA/)
    }
  })

  it('un pedido sin líneas no es un pedido', async () => {
    const message = await expectFailure(() => checkout(STORE_A_SLUG, []))
    expect(message).toMatch(/ITEMS_REQUERIDOS/)
  })

  it('un correo que no lo es se rechaza', async () => {
    const message = await expectFailure(() =>
      checkout(STORE_A_SLUG, [{ product_id: sillaA, quantity: 1 }], { email: 'sin-arroba' }),
    )
    expect(message).toMatch(/EMAIL_REQUERIDO/)
  })
})

describe('pedido y líneas, todo o nada', () => {
  it('un fallo a media compra no deja pedido, ni líneas, ni stock movido', async () => {
    const [antes] = await svc(
      `select (select count(*) from public.orders where store_id = $1) as pedidos,
              (select stock from public.products where id = $2) as stock`,
      [storeA, sillaA],
    )

    // La primera línea es válida y la segunda revienta: si la transacción no
    // fuera atómica, la silla se habría descontado igual.
    const message = await expectFailure(() =>
      checkout(STORE_A_SLUG, [
        { product_id: sillaA, quantity: 1 },
        { product_id: mesaA, quantity: 9999 },
      ]),
    )
    expect(message).toMatch(/STOCK_INSUFICIENTE/)

    const [despues] = await svc(
      `select (select count(*) from public.orders where store_id = $1) as pedidos,
              (select stock from public.products where id = $2) as stock`,
      [storeA, sillaA],
    )
    expect(despues).toEqual(antes)
  })

  it('el pedido guarda sus líneas con el snapshot del producto', async () => {
    const result = await checkout(STORE_A_SLUG, [{ product_id: mesaA, quantity: 2 }])

    const items = await svc(
      `select product_id, sku, name, unit_price::text, quantity, line_total::text,
              organization_id, company_id, store_id
         from public.order_items where order_id = $1`,
      [result.order_id],
    )
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      product_id: mesaA,
      sku: 'A-MESA',
      unit_price: '49.90',
      quantity: 2,
      line_total: '99.80',
      organization_id: TENANT_A.organizationId,
      company_id: TENANT_A.companyId,
      store_id: storeA,
    })
  })

  it('descuenta stock exactamente lo pedido', async () => {
    const [antes] = await svc(`select stock from public.products where id = $1`, [sillaA])
    await checkout(STORE_A_SLUG, [{ product_id: sillaA, quantity: 3 }])
    const [despues] = await svc(`select stock from public.products where id = $1`, [sillaA])

    expect(Number(despues?.stock)).toBe(Number(antes?.stock) - 3)
  })
})

describe('numeración y estado', () => {
  it('el número lo genera la base, es correlativo por tienda y único', async () => {
    const primero = await checkout(STORE_A_SLUG, [{ product_id: sillaA, quantity: 1 }])
    const segundo = await checkout(STORE_A_SLUG, [{ product_id: sillaA, quantity: 1 }])

    expect(String(primero.order_number)).toMatch(/^EC-\d{8}-\d{5}$/)
    expect(segundo.order_number).not.toBe(primero.order_number)

    const seq = (value: unknown) => Number(String(value).split('-')[2])
    expect(seq(segundo.order_number)).toBe(seq(primero.order_number) + 1)

    // La numeración es por tienda: la tienda B empieza por su cuenta.
    const otro = await checkout(STORE_B_SLUG, [{ product_id: productoB, quantity: 1 }])
    expect(seq(otro.order_number)).toBe(1)
  })

  it('el estado inicial es `pending` (estándar EBIM de pedidos)', async () => {
    const result = await checkout(STORE_A_SLUG, [{ product_id: sillaA, quantity: 1 }])
    expect(result.status).toBe('pending')

    const [order] = await svc(`select status from public.orders where id = $1`, [result.order_id])
    expect(order?.status).toBe('pending')
  })

  it('la dirección y la referencia se guardan tal cual las mandó el checkout', async () => {
    const result = await checkout(STORE_A_SLUG, [{ product_id: sillaA, quantity: 1 }], {
      address: { address: 'Jr. Lima 45', reference: 'Frente al parque' },
    })

    const [order] = await svc(
      `select shipping_address, customer_name, customer_phone, customer_email
         from public.orders where id = $1`,
      [result.order_id],
    )
    expect(order?.shipping_address).toEqual({
      address: 'Jr. Lima 45',
      reference: 'Frente al parque',
    })
    expect(order?.customer_name).toBe('Ana Compradora')
    expect(order?.customer_phone).toBe('+51 999 111 222')
    expect(order?.customer_email).toBe('ana@compradora.com')
  })
})

describe('quién puede llamarla', () => {
  it('ni `anon` ni `authenticated` pueden crear un pedido por su cuenta', async () => {
    for (const role of ['anon', 'authenticated'] as const) {
      const message = await expectFailure(() =>
        asRole(db, role, null, () =>
          db.query(
            `select public.create_order_for_slug($1, 'ana@compradora.com',
               jsonb_build_array(jsonb_build_object('product_id', $2::text, 'quantity', 1)))`,
            [STORE_A_SLUG, sillaA],
          ),
        ),
      )
      expect(message, `rol ${role}`).toMatch(/permission denied/i)
    }
  })

  it('un comprador anónimo tampoco puede leer los pedidos que crea', async () => {
    const message = await expectFailure(() =>
      asRole(db, 'anon', null, () => db.query(`select * from public.orders`)),
    )
    expect(message).toMatch(/permission denied/i)
  })
})
