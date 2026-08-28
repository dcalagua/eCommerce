// @vitest-environment node
/**
 * P10-SaaS · El motor de promociones visto desde el PEDIDO.
 *
 * El archivo hermano (`promotions.test.ts`) prueba el motor; éste prueba lo que
 * pasa cuando ese motor decide dinero de verdad:
 *
 *  · **lo que el carrito cotiza y lo que el pedido cobra es el mismo número**,
 *    porque salen de la misma función. Dos implementaciones que «deberían
 *    coincidir» son dos que un día no coinciden, y ese día lo descubre un
 *    comprador;
 *  · **el pedido se explica solo**: cada línea guarda cuánto le quitó cada
 *    campaña, y el canje queda apuntado con el comprador y el importe;
 *  · **los límites de uso se cumplen de verdad**, porque se cuentan con la fila
 *    bloqueada dentro de la misma transacción que crea el pedido;
 *  · **el navegador no puede declarar un descuento**: lo único que entra de
 *    fuera son los códigos de cupón;
 *  · y **la factura cuadra consigo misma** — `grand_total = subtotal + impuesto
 *    − descuento` es el CHECK de P02, y con descuentos sigue siendo cierto.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { TENANT_A, TENANT_B, asRole, createTestDatabase, expectFailure } from './harness.ts'

type Row = Record<string, unknown>
type Json = Record<string, unknown>

let db: PGlite

const STORE_A_SLUG = 'tienda-a'
const STORE_B_SLUG = 'tienda-b'
const PROMOS = 'ecommerce.promotions'

let storeA: string
let storeB: string
let jabon: string
let toalla: string
let lamparaB: string

async function sql(query: string, params: unknown[] = []): Promise<Row[]> {
  return (await db.query<Row>(query, params)).rows
}

async function svc(query: string, params: unknown[] = []): Promise<Row[]> {
  return asRole(db, 'service_role', null, () => sql(query, params))
}

async function id(query: string, params: unknown[] = []): Promise<string> {
  const rows = await svc(query, params)
  return String(rows[0]?.id)
}

interface Item {
  product_id: string
  quantity: number
}

/** El checkout público con cupones. Es la puerta real de la vitrina. */
async function checkout(
  items: Item[],
  options: { coupons?: string[]; email?: string; slug?: string } = {},
): Promise<Json> {
  const rows = await svc(
    `select public.create_order_for_slug(
       p_store_slug     => $1,
       p_customer_email => $2,
       p_items          => $3::jsonb,
       p_coupon_codes   => $4::text[]) as o`,
    [
      options.slug ?? STORE_A_SLUG,
      options.email ?? 'ana@compradora.com',
      JSON.stringify(items),
      options.coupons ?? null,
    ],
  )
  return rows[0]?.o as Json
}

/** La cotización pública: lo que el comprador VE antes de comprar. */
async function quote(items: Item[], coupons: string[] | null = null): Promise<Json> {
  const rows = await svc(
    `select public.promotion_quote_for_slug($1, $2::jsonb, $3::text[]) as q`,
    [STORE_A_SLUG, JSON.stringify(items), coupons],
  )
  return rows[0]?.q as Json
}

async function createPromotion(input: {
  code: string
  percent?: string
  amount?: string
  kind?: string
  requiresCoupon?: boolean
  usageLimit?: number | null
  usageLimitPerCustomer?: number | null
  store?: string
  tenant?: typeof TENANT_A
}): Promise<string> {
  const tenant = input.tenant ?? TENANT_A
  const promo = await id(
    `insert into public.promotions
       (organization_id, company_id, store_id, code, name, kind, status,
        value_percent, value_amount, requires_coupon,
        usage_limit, usage_limit_per_customer, valid_from)
     values ($1, $2, $3, $4, $4, $5::public.promotion_kind, 'active', $6, $7, $8, $9, $10,
             now() - interval '1 day')
     returning id`,
    [
      tenant.organizationId, tenant.companyId, input.store ?? storeA, input.code,
      input.kind ?? 'percentage', input.percent ?? null, input.amount ?? null,
      input.requiresCoupon ?? false, input.usageLimit ?? null,
      input.usageLimitPerCustomer ?? null,
    ],
  )
  await svc(
    `insert into public.promotion_scopes
       (organization_id, company_id, store_id, promotion_id, promotion_kind, scope_kind)
     values ($1, $2, $3, $4, $5::public.promotion_kind, 'all')`,
    [
      tenant.organizationId, tenant.companyId, input.store ?? storeA, promo,
      input.kind ?? 'percentage',
    ],
  )
  return promo
}

async function addCoupon(input: {
  promotion: string
  code: string
  usageLimit?: number | null
  usageLimitPerCustomer?: number | null
  store?: string
  tenant?: typeof TENANT_A
}): Promise<string> {
  const tenant = input.tenant ?? TENANT_A
  return id(
    `insert into public.coupons
       (organization_id, company_id, store_id, promotion_id, code,
        usage_limit, usage_limit_per_customer)
     values ($1, $2, $3, $4, $5, $6, $7) returning id`,
    [
      tenant.organizationId, tenant.companyId, input.store ?? storeA, input.promotion,
      input.code, input.usageLimit ?? null, input.usageLimitPerCustomer ?? null,
    ],
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
    await svc(
      `select public.sync_platform_context($1, $2, true, $3, 'hub'::public.entitlement_source, null)`,
      [tenant.organizationId, tenant.companyId, [PROMOS]],
    )
  }
  await svc(`update public.stores set status = 'active'`)
  await svc(`update public.store_settings set tax_rate = 0, tax_inclusive = false`)

  const stores = await svc(`select id, slug from public.stores order by slug`)
  storeA = String(stores.find((s) => s.slug === STORE_A_SLUG)?.id)
  storeB = String(stores.find((s) => s.slug === STORE_B_SLUG)?.id)

  const insertProduct = `
    insert into public.products
      (organization_id, company_id, store_id, sku, slug, name, price, currency, stock,
       status, published_at)
    values ($1, $2, $3, $4, $5, $6, $7, 'PEN', 100000, 'published', now())
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

beforeEach(async () => {
  await svc(`delete from public.promotion_redemptions`)
  await svc(`delete from public.coupons`)
  await svc(`delete from public.promotion_scopes`)
  await svc(`delete from public.promotions`)
  await svc(`delete from public.order_items`)
  await svc(`delete from public.orders`)
  await svc(`delete from public.checkout_attempts`)
  await svc(`update public.store_settings set tax_rate = 0, tax_inclusive = false`)
})

// ===========================================================================
describe('sin campañas nada cambia', () => {
  it('un pedido sin promociones cuesta exactamente lo de siempre', async () => {
    const order = await checkout([{ product_id: jabon, quantity: 3 }])
    expect(order.subtotal).toBe('30.00')
    expect(order.discount_total).toBe('0.00')
    expect(order.grand_total).toBe('30.00')
  })

  it('los importes del pedido siguen cuadrando con el CHECK de P02', async () => {
    await svc(`update public.store_settings set tax_rate = 0.18`)
    const order = await checkout([{ product_id: toalla, quantity: 3 }])
    const [row] = await svc(
      `select subtotal::text, tax_total::text, discount_total::text, grand_total::text
         from public.orders where id = $1`,
      [order.order_id],
    )
    expect(Number(row?.subtotal) + Number(row?.tax_total) - Number(row?.discount_total))
      .toBeCloseTo(Number(row?.grand_total), 2)
  })
})

// ===========================================================================
describe('la cotización y el pedido dicen el mismo número', () => {
  it('el descuento que enseña el carrito es el que se cobra', async () => {
    const promo = await createPromotion({ code: 'verano', percent: '15', requiresCoupon: true })
    await addCoupon({ promotion: promo, code: 'VERANO15' })

    const items = [{ product_id: jabon, quantity: 3 }, { product_id: toalla, quantity: 2 }]
    const cotizado = await quote(items, ['VERANO15'])
    const cobrado = await checkout(items, { coupons: ['VERANO15'] })

    expect(cotizado.discount_total).toBe('12.00')
    expect(cobrado.discount_total).toBe(cotizado.discount_total)
    expect(cobrado.grand_total).toBe(cotizado.grand_total)
    expect(cobrado.subtotal).toBe(cotizado.subtotal)
  })

  it('con impuesto incluido tampoco discrepan', async () => {
    await svc(`update public.store_settings set tax_rate = 0.18, tax_inclusive = true`)
    await createPromotion({ code: 'diez', percent: '10' })

    const items = [{ product_id: toalla, quantity: 7 }, { product_id: jabon, quantity: 3 }]
    const cotizado = await quote(items)
    const cobrado = await checkout(items)

    expect(cobrado.subtotal).toBe(cotizado.subtotal)
    expect(cobrado.tax_total).toBe(cotizado.tax_total)
    expect(cobrado.discount_total).toBe(cotizado.discount_total)
    expect(cobrado.grand_total).toBe(cotizado.grand_total)
  })
})

// ===========================================================================
describe('el pedido se explica solo', () => {
  it('cada línea guarda su descuento y QUÉ campaña se lo hizo', async () => {
    await createPromotion({ code: 'rebaja', percent: '20' })

    const order = await checkout([
      { product_id: jabon, quantity: 2 },
      { product_id: toalla, quantity: 1 },
    ])

    const items = await svc(
      `select sku, discount_amount::text as discount, discount_snapshot,
              amount_after_discount::text as after
         from public.order_items where order_id = $1 order by sku`,
      [order.order_id],
    )
    expect(items).toHaveLength(2)
    const jabonLine = items.find((row) => row.sku === 'A-JABON')
    expect(jabonLine?.discount).toBe('4.00')
    expect(jabonLine?.after).toBe('16.00')
    const snapshot = jabonLine?.discount_snapshot as Json[]
    expect(snapshot).toHaveLength(1)
    expect(snapshot[0]?.code).toBe('rebaja')
    expect(snapshot[0]?.amount).toBe('4.00')

    // La suma de las líneas es EXACTAMENTE el descuento del pedido.
    const total = items.reduce((acc, row) => acc + Number(row.discount), 0)
    expect(total.toFixed(2)).toBe(String(order.discount_total))
  })

  it('el snapshot del descuento sobrevive al borrado de la campaña', async () => {
    const promo = await createPromotion({ code: 'efimera', percent: '10' })
    const order = await checkout([{ product_id: toalla, quantity: 4 }])
    await svc(`delete from public.promotions where id = $1`, [promo])

    const [line] = await svc(
      `select discount_amount::text as discount, discount_snapshot
         from public.order_items where order_id = $1`,
      [order.order_id],
    )
    expect(line?.discount).toBe('10.00')
    expect((line?.discount_snapshot as Json[])[0]?.label).toBe('efimera')
  })

  it('el canje queda apuntado con el comprador, el importe y la moneda', async () => {
    const promo = await createPromotion({ code: 'bienvenida', percent: '10', requiresCoupon: true })
    const coupon = await addCoupon({ promotion: promo, code: 'HOLA10' })

    const order = await checkout([{ product_id: toalla, quantity: 4 }], {
      coupons: ['HOLA10'],
      email: 'nueva@compradora.com',
    })

    const [redemption] = await svc(
      `select promotion_id, coupon_id, customer_email,
              discount_amount::text as amount, currency
         from public.promotion_redemptions where order_id = $1`,
      [order.order_id],
    )
    expect(redemption?.promotion_id).toBe(promo)
    expect(redemption?.coupon_id).toBe(coupon)
    expect(redemption?.customer_email).toBe('nueva@compradora.com')
    expect(redemption?.amount).toBe('10.00')
    expect(redemption?.currency).toBe('PEN')
  })

  it('el contador de usos sube en la misma transacción, y solo una vez', async () => {
    const promo = await createPromotion({ code: 'contada', percent: '10', requiresCoupon: true })
    const coupon = await addCoupon({ promotion: promo, code: 'CUENTA10' })

    await checkout([{ product_id: toalla, quantity: 1 }], { coupons: ['CUENTA10'] })
    await checkout([{ product_id: toalla, quantity: 1 }], {
      coupons: ['CUENTA10'],
      email: 'otra@compradora.com',
    })

    const [row] = await svc(`select usage_count from public.promotions where id = $1`, [promo])
    const [couponRow] = await svc(`select usage_count from public.coupons where id = $1`, [coupon])
    expect(row?.usage_count).toBe(2)
    expect(couponRow?.usage_count).toBe(2)
  })
})

// ===========================================================================
describe('los límites de uso se cumplen de verdad', () => {
  it('agotado el tope global, la siguiente compra no lleva descuento', async () => {
    await createPromotion({ code: 'primeros', percent: '50', usageLimit: 1 })

    const primera = await checkout([{ product_id: toalla, quantity: 1 }])
    const segunda = await checkout([{ product_id: toalla, quantity: 1 }], {
      email: 'segunda@compradora.com',
    })

    expect(primera.discount_total).toBe('12.50')
    expect(segunda.discount_total).toBe('0.00')
    expect(segunda.grand_total).toBe('25.00')
  })

  it('el tope POR CLIENTE distingue a un comprador de otro', async () => {
    await createPromotion({ code: 'una-por-cliente', percent: '20', usageLimitPerCustomer: 1 })

    const primera = await checkout([{ product_id: toalla, quantity: 1 }], {
      email: 'ana@compradora.com',
    })
    const repetida = await checkout([{ product_id: toalla, quantity: 1 }], {
      email: 'ana@compradora.com',
    })
    const otra = await checkout([{ product_id: toalla, quantity: 1 }], {
      email: 'otro@comprador.com',
    })

    expect(primera.discount_total).toBe('5.00')
    expect(repetida.discount_total).toBe('0.00')
    expect(otra.discount_total).toBe('5.00')
  })

  it('el mismo cupón repetido por el mismo comprador solo cuenta una vez por pedido', async () => {
    const promo = await createPromotion({ code: 'una-vez', percent: '10', requiresCoupon: true })
    await addCoupon({ promotion: promo, code: 'UNAVEZ' })

    // El mismo código dos veces en el mismo carrito: el motor lo deduplica.
    const order = await checkout([{ product_id: toalla, quantity: 4 }], {
      coupons: ['UNAVEZ', 'una-vez'],
    })
    expect(order.discount_total).toBe('10.00')

    const canjes = await svc(
      `select count(*)::int as n from public.promotion_redemptions where order_id = $1`,
      [order.order_id],
    )
    expect(canjes[0]?.n).toBe(1)
    const [promoRow] = await svc(`select usage_count from public.promotions where id = $1`, [promo])
    expect(promoRow?.usage_count).toBe(1)
  })
})

// ===========================================================================
describe('el navegador no decide el descuento', () => {
  const PROHIBIDOS = [
    'discount',
    'discount_amount',
    'discount_total',
    'discount_snapshot',
    'promotion_id',
    'promotion_code',
    'coupon_id',
    'gift_card_id',
  ]

  for (const field of PROHIBIDOS) {
    it(`el payload no puede declarar \`${field}\``, async () => {
      const message = await expectFailure(() =>
        svc(
          `select public.create_order_for_slug($1, 'ana@compradora.com', $2::jsonb)`,
          [
            STORE_A_SLUG,
            JSON.stringify([{ product_id: jabon, quantity: 1, [field]: '999' }]),
          ],
        ),
      )
      expect(message).toMatch(/CAMPO_NO_PERMITIDO/)
    })
  }

  it('no existe forma de pedir un descuento que la campaña no da', async () => {
    await createPromotion({ code: 'diez', percent: '10' })
    // Lo único que entra de fuera son códigos. Uno inventado no descuenta nada
    // extra: el 10 % sigue siendo 10 %.
    const order = await checkout([{ product_id: toalla, quantity: 4 }], {
      coupons: ['INVENTADO'],
    })
    expect(order.discount_total).toBe('10.00')
  })
})

// ===========================================================================
describe('aislamiento entre tenants', () => {
  it('el cupón de B no descuenta en la tienda de A', async () => {
    const promoB = await createPromotion({
      code: 'b-mitad', percent: '50', requiresCoupon: true,
      store: storeB, tenant: TENANT_B,
    })
    await addCoupon({
      promotion: promoB, code: 'MITAD', store: storeB, tenant: TENANT_B,
    })

    const enA = await checkout([{ product_id: toalla, quantity: 1 }], { coupons: ['MITAD'] })
    expect(enA.discount_total).toBe('0.00')

    const enB = await svc(
      `select public.create_order_for_slug(
         p_store_slug => $1, p_customer_email => 'b@compradora.com',
         p_items => $2::jsonb, p_coupon_codes => $3::text[]) as o`,
      [STORE_B_SLUG, JSON.stringify([{ product_id: lamparaB, quantity: 1 }]), ['MITAD']],
    )
    expect((enB[0]?.o as Json).discount_total).toBe('27.50')
  })

  it('el canje se escribe en el tenant del PEDIDO, no en otro', async () => {
    await createPromotion({ code: 'diez', percent: '10' })
    const order = await checkout([{ product_id: toalla, quantity: 4 }])
    const [row] = await svc(
      `select organization_id, company_id, store_id
         from public.promotion_redemptions where order_id = $1`,
      [order.order_id],
    )
    expect(row?.organization_id).toBe(TENANT_A.organizationId)
    expect(row?.company_id).toBe(TENANT_A.companyId)
    expect(row?.store_id).toBe(storeA)
  })
})

// ===========================================================================
describe('el desglose viaja en la respuesta del pedido', () => {
  it('el pedido dice qué campaña se aplicó y por qué el cupón no hizo nada', async () => {
    const activa = await createPromotion({ code: 'activa', percent: '10' })
    const conCupon = await createPromotion({
      code: 'con-cupon', percent: '50', requiresCoupon: true,
    })
    await addCoupon({ promotion: conCupon, code: 'CADUCADO' })
    await svc(`update public.coupons set valid_to = now() - interval '1 day'`)

    const order = await checkout([{ product_id: toalla, quantity: 4 }], {
      coupons: ['CADUCADO'],
    })

    const promotions = order.promotions as Json
    const applied = promotions.applied as Json[]
    const coupons = promotions.coupons as Json[]
    expect(applied).toHaveLength(1)
    expect(applied[0]?.promotion_id).toBe(activa)
    expect(coupons[0]?.status).toBe('fuera_de_vigencia')
    expect(order.discount_total).toBe('10.00')
    expect(conCupon).toBeTruthy()
  })
})
