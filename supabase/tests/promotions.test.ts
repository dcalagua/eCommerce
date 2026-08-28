// @vitest-environment node
/**
 * P10-SaaS · El motor de promociones, contra Postgres REAL.
 *
 * Lo que se prueba aqui es lo que hace que un descuento sea defendible ante
 * quien lo cobra y ante quien lo paga:
 *
 *  · **determinismo** — la misma campana, el mismo carrito y el mismo instante
 *    dan el mismo importe, y el orden de evaluacion no depende del plan de
 *    ejecucion sino de `priority desc, created_at, id`;
 *  · **explicabilidad** — toda respuesta trae que se aplico y, sobre todo, que
 *    NO se aplico y por que;
 *  · **combinacion explicita** — exclusiva, grupo excluyente y remanente;
 *  · **limites** — global, por cliente y con la fila bloqueada;
 *  · **aislamiento** — el mismo codigo de cupon en dos tiendas son dos cupones;
 *  · **aritmetica** — `subtotal + impuesto - descuento = total` es una
 *    identidad en las dos modalidades fiscales, y la suma de los descuentos de
 *    linea es EXACTAMENTE el descuento del pedido.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { TENANT_A, TENANT_B, asRole, claimsFor, createTestDatabase, expectFailure } from './harness.ts'

type Row = Record<string, unknown>
type Json = Record<string, unknown>

let db: PGlite

const STORE_A_SLUG = 'tienda-a'
const STORE_B_SLUG = 'tienda-b'
const PROMOS = 'ecommerce.promotions'

let storeA: string
let storeB: string
let channelB2b: string
let catHogar: string
let catRopa: string
let brandAcme: string
let jabon: string
let toalla: string
let camiseta: string
let camisetaRoja: string
let camisetaAzul: string
let lamparaB: string
let segmentoMayorista: string
let clienteX: string

async function sql(query: string, params: unknown[] = []): Promise<Row[]> {
  return (await db.query<Row>(query, params)).rows
}

async function svc(query: string, params: unknown[] = []): Promise<Row[]> {
  return asRole(db, 'service_role', null, () => sql(query, params))
}

/**
 * El simulador del backoffice exige MEMBRESIA (`ebim.can_access`), asi que se
 * llama como `authenticated` con los claims del tenant y nunca con
 * `service_role`: con `service_role` no hay JWT del que sacar la membresia y la
 * funcion contesta SIN_PERMISO, que es justo lo que tiene que hacer.
 */
async function simulate(query: string, params: unknown[] = []): Promise<Row[]> {
  return asRole(db, 'authenticated', claimsFor(TENANT_A), () => sql(query, params))
}

async function id(query: string, params: unknown[] = []): Promise<string> {
  const rows = await svc(query, params)
  return String(rows[0]?.id)
}

interface Item {
  product: string
  variant?: string | null
  quantity: number
}

function payload(items: Item[]): unknown {
  return JSON.stringify(
    items.map((item) => ({
      product_id: item.product,
      ...(item.variant ? { variant_id: item.variant } : {}),
      quantity: item.quantity,
    })),
  )
}

/** La cotizacion PUBLICA con promociones: la que ve el carrito de la vitrina. */
async function quote(items: Item[], coupons: string[] = [], slug = STORE_A_SLUG): Promise<Json> {
  const rows = await svc(
    `select public.promotion_quote_for_slug($1, $2::jsonb, $3::text[]) as q`,
    [slug, payload(items), coupons],
  )
  return rows[0]?.q as Json
}

function applied(result: Json): string[] {
  const promos = (result.promotions ?? {}) as Json
  return ((promos.applied ?? []) as Json[]).map((entry) => String(entry.code))
}

function skipped(result: Json): Record<string, string> {
  const promos = (result.promotions ?? {}) as Json
  const out: Record<string, string> = {}
  for (const entry of (promos.skipped ?? []) as Json[]) out[String(entry.code)] = String(entry.reason)
  return out
}

function coupons(result: Json): Record<string, string> {
  const promos = (result.promotions ?? {}) as Json
  const out: Record<string, string> = {}
  for (const entry of (promos.coupons ?? []) as Json[]) {
    out[String(entry.normalized ?? entry.code)] = String(entry.status)
  }
  return out
}

function lineDiscounts(result: Json): string[] {
  return ((result.lines ?? []) as Json[]).map((line) => String(line.discount))
}

interface PromoInput {
  code: string
  kind?: 'percentage' | 'fixed_amount' | 'volume_tier' | 'x_for_y' | 'bundle'
  percent?: string | null
  amount?: string | null
  cap?: string | null
  priority?: number
  status?: 'draft' | 'active' | 'paused' | 'archived'
  exclusive?: boolean
  stackGroup?: string | null
  requiresCoupon?: boolean
  minSubtotal?: string | null
  minQuantity?: string | null
  validFrom?: string | null
  validTo?: string | null
  usageLimit?: number | null
  usageLimitPerCustomer?: number | null
  buyQuantity?: string | null
  freeQuantity?: string | null
  store?: string
  tenant?: typeof TENANT_A
}

async function createPromotion(input: PromoInput): Promise<string> {
  const tenant = input.tenant ?? TENANT_A
  return id(
    `insert into public.promotions (
       organization_id, company_id, store_id, code, name, kind, status, priority,
       stack_group, is_exclusive, requires_coupon,
       value_percent, value_amount, max_discount_amount,
       buy_quantity, free_quantity, min_subtotal, min_quantity,
       valid_from, valid_to, usage_limit, usage_limit_per_customer)
     values ($1, $2, $3, $4, $5, $6::public.promotion_kind, $7::public.promotion_status, $8,
             $9, $10, $11, $12, $13, $14, $15, $16, $17, $18,
             coalesce($19::timestamptz, now() - interval '1 day'), $20, $21, $22)
     returning id`,
    [
      tenant.organizationId, tenant.companyId, input.store ?? storeA,
      input.code, input.code, input.kind ?? 'percentage', input.status ?? 'active',
      input.priority ?? 0, input.stackGroup ?? null, input.exclusive ?? false,
      input.requiresCoupon ?? false,
      input.percent ?? null, input.amount ?? null, input.cap ?? null,
      input.buyQuantity ?? null, input.freeQuantity ?? null,
      input.minSubtotal ?? null, input.minQuantity ?? null,
      input.validFrom ?? null, input.validTo ?? null,
      input.usageLimit ?? null, input.usageLimitPerCustomer ?? null,
    ],
  )
}

interface ScopeInput {
  promotion: string
  kind?: 'all' | 'product' | 'variant' | 'category' | 'brand'
  product?: string | null
  variant?: string | null
  category?: string | null
  brand?: string | null
  requiredQuantity?: string | null
  exclusion?: boolean
  store?: string
  tenant?: typeof TENANT_A
  promotionKind?: string
}

async function addScope(input: ScopeInput): Promise<string> {
  const tenant = input.tenant ?? TENANT_A
  return id(
    `insert into public.promotion_scopes (
       organization_id, company_id, store_id, promotion_id, promotion_kind,
       scope_kind, product_id, variant_id, category_id, brand_id,
       required_quantity, is_exclusion)
     values ($1, $2, $3, $4, $5::public.promotion_kind, $6::public.promotion_scope_kind,
             $7, $8, $9, $10, $11, $12)
     returning id`,
    [
      tenant.organizationId, tenant.companyId, input.store ?? storeA, input.promotion,
      input.promotionKind ?? 'percentage', input.kind ?? 'all',
      input.product ?? null, input.variant ?? null, input.category ?? null, input.brand ?? null,
      input.requiredQuantity ?? null, input.exclusion ?? false,
    ],
  )
}

async function addAudience(input: {
  promotion: string
  kind: 'all' | 'channel' | 'segment' | 'customer' | 'business_account'
  channel?: string | null
  segment?: string | null
  customer?: string | null
  account?: string | null
  store?: string
  tenant?: typeof TENANT_A
}): Promise<string> {
  const tenant = input.tenant ?? TENANT_A
  return id(
    `insert into public.promotion_audiences (
       organization_id, company_id, store_id, promotion_id, audience_kind,
       channel_id, segment_id, customer_id, business_account_id)
     values ($1, $2, $3, $4, $5::public.promotion_audience_kind, $6, $7, $8, $9)
     returning id`,
    [
      tenant.organizationId, tenant.companyId, input.store ?? storeA, input.promotion,
      input.kind, input.channel ?? null, input.segment ?? null,
      input.customer ?? null, input.account ?? null,
    ],
  )
}

async function addTier(input: {
  promotion: string
  minQuantity: string
  percent?: string | null
  amount?: string | null
  store?: string
  tenant?: typeof TENANT_A
}): Promise<string> {
  const tenant = input.tenant ?? TENANT_A
  return id(
    `insert into public.promotion_tiers (
       organization_id, company_id, store_id, promotion_id, promotion_kind,
       min_quantity, discount_percent, discount_amount)
     values ($1, $2, $3, $4, 'volume_tier', $5, $6, $7)
     returning id`,
    [
      tenant.organizationId, tenant.companyId, input.store ?? storeA, input.promotion,
      input.minQuantity, input.percent ?? null, input.amount ?? null,
    ],
  )
}

async function addCoupon(input: {
  promotion: string
  code: string
  active?: boolean
  validFrom?: string | null
  validTo?: string | null
  usageLimit?: number | null
  usageLimitPerCustomer?: number | null
  store?: string
  tenant?: typeof TENANT_A
}): Promise<string> {
  const tenant = input.tenant ?? TENANT_A
  return id(
    `insert into public.coupons (
       organization_id, company_id, store_id, promotion_id, code, is_active,
       valid_from, valid_to, usage_limit, usage_limit_per_customer)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     returning id`,
    [
      tenant.organizationId, tenant.companyId, input.store ?? storeA, input.promotion,
      input.code, input.active ?? true, input.validFrom ?? null, input.validTo ?? null,
      input.usageLimit ?? null, input.usageLimitPerCustomer ?? null,
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
  }
  await svc(`update public.stores set status = 'active'`)
  // Sin impuesto por defecto: la aritmetica fiscal tiene su propio bloque, y
  // mezclarla con la de combinacion haria que un fallo pudiera ser de dos sitios.
  await svc(`update public.store_settings set tax_rate = 0, tax_inclusive = false`)

  for (const tenant of [TENANT_A, TENANT_B]) {
    await svc(
      `select public.sync_platform_context($1, $2, true, $3, 'hub'::public.entitlement_source, null)`,
      [tenant.organizationId, tenant.companyId, [PROMOS]],
    )
  }

  const stores = await svc(`select id, slug from public.stores order by slug`)
  storeA = String(stores.find((s) => s.slug === STORE_A_SLUG)?.id)
  storeB = String(stores.find((s) => s.slug === STORE_B_SLUG)?.id)

  channelB2b = await id(
    `insert into public.channels
       (organization_id, company_id, store_id, code, name, kind, is_default, requires_auth)
     values ($1, $2, $3, 'b2b', 'Mayoristas', 'b2b', false, true) returning id`,
    [TENANT_A.organizationId, TENANT_A.companyId, storeA],
  )

  const insertCategory = `
    insert into public.categories (organization_id, company_id, store_id, slug, name)
    values ($1, $2, $3, $4, $5) returning id`
  catHogar = await id(insertCategory, [
    TENANT_A.organizationId, TENANT_A.companyId, storeA, 'hogar', 'Hogar',
  ])
  catRopa = await id(insertCategory, [
    TENANT_A.organizationId, TENANT_A.companyId, storeA, 'ropa', 'Ropa',
  ])

  brandAcme = await id(
    `insert into public.brands (organization_id, company_id, code, name)
     values ($1, $2, 'acme', 'Acme') returning id`,
    [TENANT_A.organizationId, TENANT_A.companyId],
  )

  const insertProduct = `
    insert into public.products
      (organization_id, company_id, store_id, sku, slug, name, price, currency, stock,
       status, published_at, kind, category_id, brand_id)
    values ($1, $2, $3, $4, $5, $6, $7, 'PEN', $8, 'published', now(), $9::public.product_kind, $10, $11)
    returning id`

  jabon = await id(insertProduct, [
    TENANT_A.organizationId, TENANT_A.companyId, storeA, 'A-JABON', 'jabon', 'Jabón',
    '10.00', 1000, 'simple', catHogar, brandAcme,
  ])
  toalla = await id(insertProduct, [
    TENANT_A.organizationId, TENANT_A.companyId, storeA, 'A-TOALLA', 'toalla', 'Toalla',
    '25.00', 1000, 'simple', catHogar, null,
  ])
  camiseta = await id(insertProduct, [
    TENANT_A.organizationId, TENANT_A.companyId, storeA, 'A-CAMISETA', 'camiseta', 'Camiseta',
    '60.00', 0, 'variant', catRopa, null,
  ])
  lamparaB = await id(insertProduct, [
    TENANT_B.organizationId, TENANT_B.companyId, storeB, 'B-LAMPARA', 'lampara', 'Lámpara',
    '55.00', 500, 'simple', null, null,
  ])

  const insertVariant = `
    insert into public.product_variants
      (organization_id, company_id, store_id, product_id, sku, name, price, stock, is_active, is_default)
    values ($1, $2, $3, $4, $5, $6, $7, $8, true, $9) returning id`
  camisetaRoja = await id(insertVariant, [
    TENANT_A.organizationId, TENANT_A.companyId, storeA, camiseta, 'A-CAM-ROJA', 'Roja',
    null, 100, true,
  ])
  camisetaAzul = await id(insertVariant, [
    TENANT_A.organizationId, TENANT_A.companyId, storeA, camiseta, 'A-CAM-AZUL', 'Azul',
    '80.00', 100, false,
  ])

  segmentoMayorista = await id(
    `insert into public.customer_segments (organization_id, company_id, code, name)
     values ($1, $2, 'mayorista', 'Mayorista') returning id`,
    [TENANT_A.organizationId, TENANT_A.companyId],
  )
  clienteX = await id(
    `insert into public.customers (organization_id, company_id, kind, code, name, segment_id)
     values ($1, $2, 'company', 'CLI-X', 'Cliente X', $3) returning id`,
    [TENANT_A.organizationId, TENANT_A.companyId, segmentoMayorista],
  )
}, 180_000)

afterAll(async () => {
  await db?.close()
})

/**
 * Cada bloque monta sus propias campanas. Arrastrarlas de un test a otro haria
 * que el resultado dependiera del orden de ejecucion — que es exactamente lo
 * que estos tests niegan.
 */
beforeEach(async () => {
  await svc(`delete from public.promotion_redemptions`)
  await svc(`delete from public.coupons`)
  await svc(`delete from public.promotion_tiers`)
  await svc(`delete from public.promotion_audiences`)
  await svc(`delete from public.promotion_scopes`)
  await svc(`delete from public.promotions`)
  await svc(`delete from public.promotion_events`)
  await svc(`update public.store_settings set tax_rate = 0, tax_inclusive = false`)
})

// ===========================================================================
describe('lo basico: el descuento sale del servidor y viene explicado', () => {
  it('sin campanas el descuento es cero y el total es el de siempre', async () => {
    const result = await quote([{ product: jabon, quantity: 3 }])
    expect(result.subtotal).toBe('30.00')
    expect(result.discount_total).toBe('0.00')
    expect(result.grand_total).toBe('30.00')
    expect(applied(result)).toEqual([])
  })

  it('un porcentaje sobre todo el carrito descuenta y se explica', async () => {
    const promo = await createPromotion({ code: 'verano', percent: '10' })
    await addScope({ promotion: promo, kind: 'all' })

    const result = await quote([{ product: jabon, quantity: 3 }, { product: toalla, quantity: 2 }])
    expect(result.subtotal).toBe('80.00')
    expect(result.discount_total).toBe('8.00')
    expect(result.grand_total).toBe('72.00')
    expect(applied(result)).toEqual(['verano'])

    const promos = result.promotions as Json
    const entry = ((promos.applied ?? []) as Json[])[0]
    expect(entry?.amount).toBe('8.00')
    expect(entry?.kind).toBe('percentage')
    expect(entry?.label).toBe('verano')
  })

  it('la suma de los descuentos de linea es EXACTAMENTE el del pedido', async () => {
    const promo = await createPromotion({ code: 'tercio', percent: '33.3333' })
    await addScope({ promotion: promo, kind: 'all' })

    const result = await quote([
      { product: jabon, quantity: 1 },
      { product: toalla, quantity: 1 },
      { product: camiseta, variant: camisetaRoja, quantity: 1 },
    ])
    const sum = lineDiscounts(result).reduce((acc, value) => acc + Number(value), 0)
    expect(sum.toFixed(2)).toBe(String(result.discount_total))
  })

  it('cada linea dice que campana la toco y cuanto', async () => {
    const promo = await createPromotion({ code: 'hogar10', percent: '10' })
    await addScope({ promotion: promo, kind: 'category', category: catHogar })

    const result = await quote([
      { product: jabon, quantity: 1 },
      { product: camiseta, variant: camisetaRoja, quantity: 1 },
    ])
    const lines = (result.lines ?? []) as Json[]
    const jabonLine = lines.find((line) => line.product_id === jabon)
    const camisetaLine = lines.find((line) => line.product_id === camiseta)

    expect(jabonLine?.discount).toBe('1.00')
    expect((jabonLine?.adjustments as Json[])[0]?.code).toBe('hogar10')
    expect(camisetaLine?.discount).toBe('0')
    expect(camisetaLine?.adjustments).toEqual([])
  })

  it('un importe fijo se reparte entre las lineas alcanzadas sin perder un centimo', async () => {
    const promo = await createPromotion({ code: 'menos7', kind: 'fixed_amount', amount: '7.00' })
    await addScope({ promotion: promo, kind: 'all', promotionKind: 'fixed_amount' })

    const result = await quote([{ product: jabon, quantity: 1 }, { product: toalla, quantity: 1 }])
    expect(result.discount_total).toBe('7.00')
    const sum = lineDiscounts(result).reduce((acc, value) => acc + Number(value), 0)
    expect(sum.toFixed(2)).toBe('7.00')
  })

  it('un importe fijo mayor que el carrito no lo deja en negativo', async () => {
    const promo = await createPromotion({ code: 'menos500', kind: 'fixed_amount', amount: '500.00' })
    await addScope({ promotion: promo, kind: 'all', promotionKind: 'fixed_amount' })

    const result = await quote([{ product: jabon, quantity: 1 }])
    expect(result.discount_total).toBe('10.00')
    expect(result.grand_total).toBe('0.00')
  })

  it('el tope de un porcentaje se respeta', async () => {
    const promo = await createPromotion({ code: 'veinte', percent: '20', cap: '5.00' })
    await addScope({ promotion: promo, kind: 'all' })

    const result = await quote([{ product: toalla, quantity: 4 }])
    // 20 % de 100 serian 20; el tope lo deja en 5.
    expect(result.discount_total).toBe('5.00')
  })
})

// ===========================================================================
describe('alcance: producto, variante, categoria, marca y exclusiones', () => {
  it('por producto solo toca ese producto', async () => {
    const promo = await createPromotion({ code: 'solo-jabon', percent: '50' })
    await addScope({ promotion: promo, kind: 'product', product: jabon })

    const result = await quote([{ product: jabon, quantity: 1 }, { product: toalla, quantity: 1 }])
    expect(result.discount_total).toBe('5.00')
  })

  it('por variante solo toca esa variante', async () => {
    const promo = await createPromotion({ code: 'solo-roja', percent: '50' })
    await addScope({ promotion: promo, kind: 'variant', product: camiseta, variant: camisetaRoja })

    const result = await quote([
      { product: camiseta, variant: camisetaRoja, quantity: 1 },
      { product: camiseta, variant: camisetaAzul, quantity: 1 },
    ])
    // Roja hereda 60.00 y Azul tiene precio propio 80.00: solo la roja baja.
    expect(result.discount_total).toBe('30.00')
  })

  it('por marca alcanza a los productos de esa marca y a ninguno mas', async () => {
    const promo = await createPromotion({ code: 'acme', percent: '10' })
    await addScope({ promotion: promo, kind: 'brand', brand: brandAcme })

    const result = await quote([{ product: jabon, quantity: 1 }, { product: toalla, quantity: 1 }])
    expect(result.discount_total).toBe('1.00')
  })

  it('una exclusion resta dentro de la categoria y gana siempre', async () => {
    const promo = await createPromotion({ code: 'hogar-sin-acme', percent: '10' })
    await addScope({ promotion: promo, kind: 'category', category: catHogar })
    await addScope({ promotion: promo, kind: 'brand', brand: brandAcme, exclusion: true })

    const result = await quote([{ product: jabon, quantity: 1 }, { product: toalla, quantity: 1 }])
    // El jabon es Acme y queda fuera; solo baja la toalla.
    expect(result.discount_total).toBe('2.50')
  })

  it('una campana sin alcance declarado no descuenta nada y lo dice', async () => {
    const promo = await createPromotion({ code: 'huerfana', percent: '10' })

    const result = await quote([{ product: jabon, quantity: 1 }])
    expect(result.discount_total).toBe('0.00')
    expect(skipped(result).huerfana).toBe('sin_alcance')
    expect(promo).toBeTruthy()
  })
})

// ===========================================================================
describe('vigencia y estado', () => {
  it('una campana en borrador no aplica', async () => {
    const promo = await createPromotion({ code: 'borrador', percent: '50', status: 'draft' })
    await addScope({ promotion: promo, kind: 'all' })
    expect((await quote([{ product: jabon, quantity: 1 }])).discount_total).toBe('0.00')
  })

  it('una campana pausada no aplica', async () => {
    const promo = await createPromotion({ code: 'pausada', percent: '50', status: 'paused' })
    await addScope({ promotion: promo, kind: 'all' })
    expect((await quote([{ product: jabon, quantity: 1 }])).discount_total).toBe('0.00')
  })

  it('una campana programada a futuro NO adelanta el descuento', async () => {
    const promo = await createPromotion({
      code: 'futura', percent: '50',
      validFrom: new Date(Date.now() + 86_400_000).toISOString(),
    })
    await addScope({ promotion: promo, kind: 'all' })
    expect((await quote([{ product: jabon, quantity: 1 }])).discount_total).toBe('0.00')
  })

  it('una campana caducada no arrastra el descuento', async () => {
    const promo = await createPromotion({
      code: 'vieja', percent: '50',
      validFrom: new Date(Date.now() - 172_800_000).toISOString(),
      validTo: new Date(Date.now() - 86_400_000).toISOString(),
    })
    await addScope({ promotion: promo, kind: 'all' })
    expect((await quote([{ product: jabon, quantity: 1 }])).discount_total).toBe('0.00')
  })

  it('el simulador responde a una FECHA: lo que pasaria manana', async () => {
    const manana = new Date(Date.now() + 86_400_000).toISOString()
    const promo = await createPromotion({ code: 'futura', percent: '50', validFrom: manana })
    await addScope({ promotion: promo, kind: 'all' })

    const [hoy] = await simulate(
      `select public.promotion_simulate($1, $2::jsonb, null, null, null, null, now()) as q`,
      [storeA, payload([{ product: jabon, quantity: 1 }])],
    )
    const [futuro] = await simulate(
      `select public.promotion_simulate($1, $2::jsonb, null, null, null, null,
              now() + interval '2 days') as q`,
      [storeA, payload([{ product: jabon, quantity: 1 }])],
    )
    expect((hoy?.q as Json).discount_total).toBe('0.00')
    expect((futuro?.q as Json).discount_total).toBe('5.00')
  })
})

// ===========================================================================
describe('prioridad, solapamiento y combinacion', () => {
  it('dos campanas que se solapan se aplican sobre el REMANENTE, no sobre el bruto', async () => {
    const alta = await createPromotion({ code: 'alta', percent: '50', priority: 100 })
    await addScope({ promotion: alta, kind: 'all' })
    const baja = await createPromotion({ code: 'baja', percent: '50', priority: 10 })
    await addScope({ promotion: baja, kind: 'all' })

    const result = await quote([{ product: toalla, quantity: 4 }])
    // 100 -> 50 (alta) -> 25 (baja sobre lo que queda). Nunca 100 % de descuento.
    expect(result.discount_total).toBe('75.00')
    expect(result.grand_total).toBe('25.00')
    expect(applied(result)).toEqual(['alta', 'baja'])
  })

  it('el orden lo manda la PRIORIDAD y el resultado es reproducible', async () => {
    const fijo = await createPromotion({ code: 'fijo', kind: 'fixed_amount', amount: '30.00', priority: 900 })
    await addScope({ promotion: fijo, kind: 'all', promotionKind: 'fixed_amount' })
    const pct = await createPromotion({ code: 'pct', percent: '50', priority: 100 })
    await addScope({ promotion: pct, kind: 'all' })

    const first = await quote([{ product: toalla, quantity: 4 }])
    const second = await quote([{ product: toalla, quantity: 4 }])
    // 100 - 30 = 70, y 50 % de 70 = 35. Total 65.
    expect(first.discount_total).toBe('65.00')
    expect(applied(first)).toEqual(['fijo', 'pct'])
    // Reproducible: lo unico que cambia entre dos cotizaciones es el instante.
    expect({ ...second, quoted_at: null }).toEqual({ ...first, quoted_at: null })
  })

  it('una exclusiva de mayor prioridad deja fuera a todas las demas', async () => {
    const sola = await createPromotion({ code: 'sola', percent: '20', priority: 500, exclusive: true })
    await addScope({ promotion: sola, kind: 'all' })
    const otra = await createPromotion({ code: 'otra', percent: '50', priority: 100 })
    await addScope({ promotion: otra, kind: 'all' })

    const result = await quote([{ product: toalla, quantity: 4 }])
    expect(applied(result)).toEqual(['sola'])
    expect(skipped(result).otra).toBe('exclusiva_previa')
    expect(result.discount_total).toBe('20.00')
  })

  it('una exclusiva de MENOR prioridad no entra si ya se aplico algo', async () => {
    const primera = await createPromotion({ code: 'primera', percent: '10', priority: 500 })
    await addScope({ promotion: primera, kind: 'all' })
    const sola = await createPromotion({ code: 'sola', percent: '50', priority: 100, exclusive: true })
    await addScope({ promotion: sola, kind: 'all' })

    const result = await quote([{ product: toalla, quantity: 4 }])
    expect(applied(result)).toEqual(['primera'])
    expect(skipped(result).sola).toBe('no_combina')
  })

  it('de un mismo grupo excluyente solo gana una', async () => {
    const a = await createPromotion({ code: 'rebajas-a', percent: '30', priority: 200, stackGroup: 'rebajas' })
    await addScope({ promotion: a, kind: 'all' })
    const b = await createPromotion({ code: 'rebajas-b', percent: '10', priority: 100, stackGroup: 'rebajas' })
    await addScope({ promotion: b, kind: 'all' })
    const libre = await createPromotion({ code: 'bienvenida', percent: '5', priority: 50 })
    await addScope({ promotion: libre, kind: 'all' })

    const result = await quote([{ product: toalla, quantity: 4 }])
    expect(applied(result)).toEqual(['rebajas-a', 'bienvenida'])
    expect(skipped(result)['rebajas-b']).toBe('grupo_excluyente')
  })

  it('un descuento que no puede quitar nada mas se marca sin_efecto', async () => {
    const todo = await createPromotion({ code: 'todo', percent: '100', priority: 900 })
    await addScope({ promotion: todo, kind: 'all' })
    const mas = await createPromotion({ code: 'mas', percent: '10', priority: 100 })
    await addScope({ promotion: mas, kind: 'all' })

    const result = await quote([{ product: toalla, quantity: 1 }])
    expect(result.grand_total).toBe('0.00')
    expect(skipped(result).mas).toBe('sin_efecto')
  })
})

// ===========================================================================
describe('condiciones de entrada', () => {
  it('el minimo de compra se mide sobre el bruto y no se desactiva a si mismo', async () => {
    const promo = await createPromotion({ code: 'desde50', percent: '50', minSubtotal: '50.00' })
    await addScope({ promotion: promo, kind: 'all' })

    const corto = await quote([{ product: toalla, quantity: 1 }])
    expect(corto.discount_total).toBe('0.00')
    expect(skipped(corto).desde50).toBe('minimo_no_alcanzado')

    // 50 exactos entran, y el descuento los baja a 25 sin desactivarse.
    const justo = await quote([{ product: toalla, quantity: 2 }])
    expect(justo.discount_total).toBe('25.00')
  })

  it('la cantidad minima se mide sobre las lineas ALCANZADAS', async () => {
    const promo = await createPromotion({ code: 'tres-jabones', percent: '10', minQuantity: '3' })
    await addScope({ promotion: promo, kind: 'product', product: jabon })

    const pocos = await quote([{ product: jabon, quantity: 2 }, { product: toalla, quantity: 10 }])
    expect(skipped(pocos)['tres-jabones']).toBe('cantidad_minima_no_alcanzada')

    const suficientes = await quote([{ product: jabon, quantity: 3 }])
    expect(suficientes.discount_total).toBe('3.00')
  })

  it('la audiencia por canal deja fuera al canal que no es', async () => {
    const promo = await createPromotion({ code: 'solo-b2b', percent: '50' })
    await addScope({ promotion: promo, kind: 'all' })
    await addAudience({ promotion: promo, kind: 'channel', channel: channelB2b })

    const publico = await quote([{ product: toalla, quantity: 1 }])
    expect(publico.discount_total).toBe('0.00')
    expect(skipped(publico)['solo-b2b']).toBe('fuera_de_publico')

    const [b2b] = await simulate(
      `select public.promotion_simulate($1, $2::jsonb, null, $3) as q`,
      [storeA, payload([{ product: toalla, quantity: 1 }]), channelB2b],
    )
    expect((b2b?.q as Json).discount_total).toBe('12.50')
  })

  it('la audiencia por segmento se deriva de la ficha del cliente', async () => {
    const promo = await createPromotion({ code: 'mayorista', percent: '20' })
    await addScope({ promotion: promo, kind: 'all' })
    await addAudience({ promotion: promo, kind: 'segment', segment: segmentoMayorista })

    const anonimo = await quote([{ product: toalla, quantity: 1 }])
    expect(anonimo.discount_total).toBe('0.00')

    // Ni segmento declarado ni nada: solo el cliente. El motor lo deriva.
    const [conCliente] = await simulate(
      `select public.promotion_simulate($1, $2::jsonb, null, null, null, $3) as q`,
      [storeA, payload([{ product: toalla, quantity: 1 }]), clienteX],
    )
    expect((conCliente?.q as Json).discount_total).toBe('5.00')
  })
})

// ===========================================================================
describe('volumen y X por Y', () => {
  it('la escala aplicada es la mas alta que la cantidad alcanza', async () => {
    const promo = await createPromotion({ code: 'volumen', kind: 'volume_tier' })
    await addScope({ promotion: promo, kind: 'product', product: jabon, promotionKind: 'volume_tier' })
    await addTier({ promotion: promo, minQuantity: '10', percent: '5' })
    await addTier({ promotion: promo, minQuantity: '50', percent: '10' })

    expect((await quote([{ product: jabon, quantity: 9 }])).discount_total).toBe('0.00')
    expect((await quote([{ product: jabon, quantity: 10 }])).discount_total).toBe('5.00')
    expect((await quote([{ product: jabon, quantity: 50 }])).discount_total).toBe('50.00')
  })

  it('una escala por importe descuenta POR UNIDAD', async () => {
    const promo = await createPromotion({ code: 'dos-por-unidad', kind: 'volume_tier' })
    await addScope({ promotion: promo, kind: 'product', product: jabon, promotionKind: 'volume_tier' })
    await addTier({ promotion: promo, minQuantity: '5', amount: '2.00' })

    expect((await quote([{ product: jabon, quantity: 5 }])).discount_total).toBe('10.00')
  })

  it('3x2 descuenta un bloque completo y solo los bloques completos', async () => {
    const promo = await createPromotion({
      code: 'tres-x-dos', kind: 'x_for_y', buyQuantity: '3', freeQuantity: '1',
    })
    await addScope({ promotion: promo, kind: 'product', product: jabon, promotionKind: 'x_for_y' })

    expect((await quote([{ product: jabon, quantity: 2 }])).discount_total).toBe('0.00')
    expect((await quote([{ product: jabon, quantity: 3 }])).discount_total).toBe('10.00')
    expect((await quote([{ product: jabon, quantity: 5 }])).discount_total).toBe('10.00')
    expect((await quote([{ product: jabon, quantity: 6 }])).discount_total).toBe('20.00')
  })

  it('un combo solo descuenta si estan TODOS sus componentes', async () => {
    const promo = await createPromotion({ code: 'combo', kind: 'bundle', amount: '5.00' })
    await addScope({
      promotion: promo, kind: 'product', product: jabon,
      promotionKind: 'bundle', requiredQuantity: '2',
    })
    await addScope({
      promotion: promo, kind: 'product', product: toalla,
      promotionKind: 'bundle', requiredQuantity: '1',
    })

    const incompleto = await quote([{ product: jabon, quantity: 2 }])
    expect(incompleto.discount_total).toBe('0.00')
    expect(skipped(incompleto).combo).toBe('combo_incompleto')

    const completo = await quote([{ product: jabon, quantity: 2 }, { product: toalla, quantity: 1 }])
    expect(completo.discount_total).toBe('5.00')

    // Dos conjuntos completos descuentan dos veces.
    const doble = await quote([{ product: jabon, quantity: 4 }, { product: toalla, quantity: 2 }])
    expect(doble.discount_total).toBe('10.00')
  })
})

// ===========================================================================
describe('cupones', () => {
  it('una campana con cupon NO existe sin el, y no se anuncia', async () => {
    const promo = await createPromotion({ code: 'bienvenida', percent: '20', requiresCoupon: true })
    await addScope({ promotion: promo, kind: 'all' })
    await addCoupon({ promotion: promo, code: 'HOLA20' })

    const sinCupon = await quote([{ product: toalla, quantity: 1 }])
    expect(sinCupon.discount_total).toBe('0.00')
    // Y NO aparece en `skipped`: enumerar los cupones que hay seria regalar el folleto.
    expect(Object.keys(skipped(sinCupon))).toEqual([])

    const conCupon = await quote([{ product: toalla, quantity: 1 }], ['HOLA20'])
    expect(conCupon.discount_total).toBe('5.00')
    expect(coupons(conCupon).HOLA20).toBe('aplicado')
  })

  it('el codigo se normaliza: espacios, guiones y mayusculas son el mismo cupon', async () => {
    const promo = await createPromotion({ code: 'verano', percent: '10', requiresCoupon: true })
    await addScope({ promotion: promo, kind: 'all' })
    await addCoupon({ promotion: promo, code: 'VERANO-25' })

    for (const typed of ['verano25', ' Verano 25 ', 'VeRaNo-25']) {
      const result = await quote([{ product: toalla, quantity: 1 }], [typed])
      expect(result.discount_total).toBe('2.50')
    }
  })

  it('dar de alta el mismo codigo normalizado dos veces en la misma tienda falla', async () => {
    const promo = await createPromotion({ code: 'verano', percent: '10', requiresCoupon: true })
    await addScope({ promotion: promo, kind: 'all' })
    await addCoupon({ promotion: promo, code: 'VERANO-25' })

    const message = await expectFailure(() => addCoupon({ promotion: promo, code: 'verano 25' }))
    expect(message).toMatch(/coupons_code_key|duplicate key/i)
  })

  it('un cupon inexistente, inactivo o caducado se explica, no se ignora', async () => {
    const promo = await createPromotion({ code: 'x', percent: '10', requiresCoupon: true })
    await addScope({ promotion: promo, kind: 'all' })
    await addCoupon({ promotion: promo, code: 'INACTIVO', active: false })
    await addCoupon({
      promotion: promo, code: 'CADUCADO',
      validTo: new Date(Date.now() - 86_400_000).toISOString(),
    })

    const result = await quote(
      [{ product: toalla, quantity: 1 }],
      ['NOEXISTE', 'INACTIVO', 'CADUCADO'],
    )
    expect(result.discount_total).toBe('0.00')
    expect(coupons(result)).toEqual({
      NOEXISTE: 'no_existe',
      INACTIVO: 'inactivo',
      CADUCADO: 'fuera_de_vigencia',
    })
  })

  it('dos cupones de la MISMA campana: gana uno y el otro se marca duplicado', async () => {
    const promo = await createPromotion({ code: 'una-sola', percent: '10', requiresCoupon: true })
    await addScope({ promotion: promo, kind: 'all' })
    await addCoupon({ promotion: promo, code: 'AAA111' })
    await addCoupon({ promotion: promo, code: 'BBB222' })

    const result = await quote([{ product: toalla, quantity: 1 }], ['AAA111', 'BBB222'])
    expect(result.discount_total).toBe('2.50')
    const status = coupons(result)
    expect([status.AAA111, status.BBB222].sort()).toEqual(['aplicado', 'duplicado'])
  })

  it('un cupon valido cuya campana no alcanza nada es no_aplicable, no aplicado', async () => {
    const promo = await createPromotion({ code: 'solo-ropa', percent: '10', requiresCoupon: true })
    await addScope({ promotion: promo, kind: 'category', category: catRopa })
    await addCoupon({ promotion: promo, code: 'ROPA10' })

    const result = await quote([{ product: jabon, quantity: 1 }], ['ROPA10'])
    expect(result.discount_total).toBe('0.00')
    expect(coupons(result).ROPA10).toBe('no_aplicable')
  })

  it('mas de cinco codigos en un carrito se rechaza', async () => {
    const message = await expectFailure(() =>
      quote([{ product: toalla, quantity: 1 }], ['A11', 'B22', 'C33', 'D44', 'E55', 'F66']),
    )
    expect(message).toMatch(/CUPONES_EXCESIVOS/)
  })

  it('el mismo codigo en dos tiendas son DOS cupones distintos', async () => {
    const promoA = await createPromotion({ code: 'a10', percent: '10', requiresCoupon: true })
    await addScope({ promotion: promoA, kind: 'all' })
    await addCoupon({ promotion: promoA, code: 'MISMO' })

    const promoB = await createPromotion({
      code: 'b50', percent: '50', requiresCoupon: true, store: storeB, tenant: TENANT_B,
    })
    await addScope({ promotion: promoB, kind: 'all', store: storeB, tenant: TENANT_B })
    await addCoupon({ promotion: promoB, code: 'MISMO', store: storeB, tenant: TENANT_B })

    const enA = await quote([{ product: toalla, quantity: 1 }], ['MISMO'])
    const enB = await quote([{ product: lamparaB, quantity: 1 }], ['MISMO'], STORE_B_SLUG)
    expect(enA.discount_total).toBe('2.50')
    expect(enB.discount_total).toBe('27.50')
  })
})

// ===========================================================================
describe('limites de uso', () => {
  it('el limite global se cuenta contra los canjes ya escritos', async () => {
    const promo = await createPromotion({ code: 'primeros', percent: '10', usageLimit: 2 })
    await addScope({ promotion: promo, kind: 'all' })

    expect((await quote([{ product: toalla, quantity: 1 }])).discount_total).toBe('2.50')

    await svc(`update public.promotions set usage_count = 2 where id = $1`, [promo])
    const agotada = await quote([{ product: toalla, quantity: 1 }])
    expect(agotada.discount_total).toBe('0.00')
    expect(skipped(agotada).primeros).toBe('limite_global_agotado')
  })

  it('sin correo, un limite POR CLIENTE se niega en vez de ignorarse', async () => {
    const promo = await createPromotion({ code: 'uno-por-cliente', percent: '10', usageLimitPerCustomer: 1 })
    await addScope({ promotion: promo, kind: 'all' })

    // La cotizacion publica no lleva correo: no hay forma de cumplir el tope.
    const result = await quote([{ product: toalla, quantity: 1 }])
    expect(result.discount_total).toBe('0.00')
    expect(skipped(result)['uno-por-cliente']).toBe('sin_identidad')
  })
})

// ===========================================================================
describe('aritmetica fiscal', () => {
  it('con impuesto EXCLUIDO el impuesto se calcula sobre lo pagadero', async () => {
    await svc(`update public.store_settings set tax_rate = 0.18, tax_inclusive = false`)
    const promo = await createPromotion({ code: 'diez', percent: '10' })
    await addScope({ promotion: promo, kind: 'all' })

    const result = await quote([{ product: toalla, quantity: 4 }])
    // Bruto 100, descuento 10, base 90, IGV 16.20, total 106.20.
    expect(result.subtotal).toBe('100.00')
    expect(result.discount_total).toBe('10.00')
    expect(result.tax_total).toBe('16.20')
    expect(result.grand_total).toBe('106.20')
  })

  it('con impuesto INCLUIDO el descuento tambien rebaja el impuesto', async () => {
    await svc(`update public.store_settings set tax_rate = 0.18, tax_inclusive = true`)
    const promo = await createPromotion({ code: 'diez', percent: '10' })
    await addScope({ promotion: promo, kind: 'all' })

    const result = await quote([{ product: toalla, quantity: 4 }])
    // Bruto 100 con IGV dentro; se descuenta 10, se pagan 90.
    expect(result.grand_total).toBe('90.00')
    expect(Number(result.subtotal) + Number(result.tax_total) - Number(result.discount_total))
      .toBeCloseTo(90, 2)
  })

  it('subtotal + impuesto - descuento = total, tambien con importes que no reparten redondo', async () => {
    for (const inclusive of [false, true]) {
      await svc(`update public.store_settings set tax_rate = 0.18, tax_inclusive = $1`, [inclusive])
      await svc(`delete from public.promotion_scopes`)
      await svc(`delete from public.promotions`)
      const promo = await createPromotion({ code: 'tercio', percent: '33.3333' })
      await addScope({ promotion: promo, kind: 'all' })

      const result = await quote([
        { product: jabon, quantity: 3 },
        { product: toalla, quantity: 7 },
        { product: camiseta, variant: camisetaRoja, quantity: 11 },
      ])
      expect(
        (Number(result.subtotal) + Number(result.tax_total) - Number(result.discount_total)).toFixed(2),
      ).toBe(String(result.grand_total))
    }
  })

  it('el impuesto de las lineas suma EXACTAMENTE el del pedido', async () => {
    await svc(`update public.store_settings set tax_rate = 0.18, tax_inclusive = false`)
    const promo = await createPromotion({ code: 'siete', percent: '7' })
    await addScope({ promotion: promo, kind: 'all' })

    const result = await quote([
      { product: jabon, quantity: 3 },
      { product: toalla, quantity: 7 },
      { product: camiseta, variant: camisetaRoja, quantity: 11 },
    ])
    const sum = ((result.lines ?? []) as Json[])
      .reduce((acc, line) => acc + Number(line.tax_amount), 0)
    expect(sum.toFixed(2)).toBe(String(result.tax_total))
  })

  it('sin promociones los totales son los mismos que daba price_quote_for_slug', async () => {
    await svc(`update public.store_settings set tax_rate = 0.18, tax_inclusive = true`)
    const items = payload([{ product: jabon, quantity: 3 }, { product: toalla, quantity: 7 }])

    const [base] = await svc(`select public.price_quote_for_slug($1, $2::jsonb) as q`, [
      STORE_A_SLUG, items,
    ])
    const [conMotor] = await svc(
      `select public.promotion_quote_for_slug($1, $2::jsonb, null) as q`,
      [STORE_A_SLUG, items],
    )
    const antes = base?.q as Json
    const ahora = conMotor?.q as Json
    expect(ahora.subtotal).toBe(antes.subtotal)
    expect(ahora.tax_total).toBe(antes.tax_total)
    expect(ahora.grand_total).toBe(antes.grand_total)
  })
})

// ===========================================================================
describe('aislamiento y entitlement', () => {
  it('las campanas de A no descuentan en la tienda de B', async () => {
    const promo = await createPromotion({ code: 'solo-a', percent: '50' })
    await addScope({ promotion: promo, kind: 'all' })

    expect((await quote([{ product: lamparaB, quantity: 1 }], [], STORE_B_SLUG)).discount_total)
      .toBe('0.00')
  })

  it('un miembro de B no ve ni una campana de A', async () => {
    await createPromotion({ code: 'privada', percent: '50' })
    const rows = await asRole(db, 'authenticated', claimsFor(TENANT_B), () =>
      sql(`select id from public.promotions`),
    )
    expect(rows).toEqual([])
  })

  it('un JWT con el org_id ajeno no escribe una campana en la tienda del vecino', async () => {
    const message = await expectFailure(() =>
      asRole(db, 'authenticated', claimsFor(TENANT_B, { org_id: TENANT_A.organizationId }), () =>
        sql(
          `insert into public.promotions
             (organization_id, company_id, store_id, code, name, kind, value_percent)
           values ($1, $2, $3, 'intruso', 'Intruso', 'percentage', 10)`,
          [TENANT_A.organizationId, TENANT_A.companyId, storeA],
        ),
      ),
    )
    expect(message).toMatch(/row-level security|violates/i)
  })

  it('`anon` no lee ni una campana, ni un cupon, ni un canje', async () => {
    const promo = await createPromotion({ code: 'oculta', percent: '50' })
    await addCoupon({ promotion: promo, code: 'SECRETO1' })

    for (const table of ['promotions', 'coupons', 'promotion_redemptions', 'promotion_events']) {
      const message = await expectFailure(() =>
        asRole(db, 'anon', null, () => sql(`select * from public.${table}`)),
      )
      expect(`${table}: ${message}`).toMatch(/permission denied/i)
    }
  })

  it('sin el modulo contratado la campana existe y NO se aplica', async () => {
    const promo = await createPromotion({ code: 'no-contratada', percent: '50' })
    await addScope({ promotion: promo, kind: 'all' })
    expect((await quote([{ product: toalla, quantity: 1 }])).discount_total).toBe('12.50')

    await svc(
      `select public.sync_platform_context($1, $2, true, '{}'::text[],
              'hub'::public.entitlement_source, null)`,
      [TENANT_A.organizationId, TENANT_A.companyId],
    )
    try {
      const result = await quote([{ product: toalla, quantity: 1 }])
      expect(result.discount_total).toBe('0.00')
      expect((result.promotions as Json).entitled).toBe(false)
      // Y se sigue VIENDO desde el backoffice: una baja comercial no es una
      // perdida de datos.
      const visible = await asRole(db, 'authenticated', claimsFor(TENANT_A), () =>
        sql(`select code from public.promotions`),
      )
      expect(visible.map((row) => row.code)).toContain('no-contratada')
    } finally {
      await svc(
        `select public.sync_platform_context($1, $2, true, $3,
                'hub'::public.entitlement_source, null)`,
        [TENANT_A.organizationId, TENANT_A.companyId, [PROMOS]],
      )
    }
  })
})

// ===========================================================================
describe('la bitacora (regla 8)', () => {
  it('cada cambio sobre una campana viva queda anotado con su estado y su actor', async () => {
    const promo = await asRole(db, 'authenticated', claimsFor(TENANT_A), async () => {
      const rows = await sql(
        `insert into public.promotions
           (organization_id, company_id, store_id, code, name, kind, status, value_percent)
         values ($1, $2, $3, 'auditada', 'Auditada', 'percentage', 'active', 10)
         returning id`,
        [TENANT_A.organizationId, TENANT_A.companyId, storeA],
      )
      return String(rows[0]?.id)
    })

    await asRole(db, 'authenticated', claimsFor(TENANT_A), () =>
      sql(`update public.promotions set value_percent = 25 where id = $1`, [promo]),
    )

    const events = await svc(
      `select action, entity, promotion_status,
              before_state ->> 'value_percent' as antes,
              after_state  ->> 'value_percent' as despues,
              actor_email
         from public.promotion_events
        where promotion_id = $1
        order by occurred_at, action`,
      [promo],
    )
    expect(events).toHaveLength(2)
    const alta = events.find((row) => row.action === 'insert')
    const cambio = events.find((row) => row.action === 'update')
    expect(alta?.entity).toBe('promotion')
    expect(alta?.actor_email).toBe(TENANT_A.adminEmail)
    expect(cambio?.promotion_status).toBe('active')
    expect(String(cambio?.antes)).toMatch(/^10/)
    expect(String(cambio?.despues)).toMatch(/^25/)
  })

  it('la bitacora no se puede fabricar ni borrar desde el cliente', async () => {
    await createPromotion({ code: 'x', percent: '10' })
    const escribir = await expectFailure(() =>
      asRole(db, 'authenticated', claimsFor(TENANT_A), () =>
        sql(
          `insert into public.promotion_events
             (organization_id, company_id, store_id, entity, action)
           values ($1, $2, $3, 'promotion', 'insert')`,
          [TENANT_A.organizationId, TENANT_A.companyId, storeA],
        ),
      ),
    )
    expect(escribir).toMatch(/permission denied|row-level security/i)

    const borrar = await expectFailure(() =>
      asRole(db, 'authenticated', claimsFor(TENANT_A), () =>
        sql(`delete from public.promotion_events`),
      ),
    )
    expect(borrar).toMatch(/permission denied|row-level security/i)
  })

  it('el contador de usos no se puede tocar desde el cliente', async () => {
    const promo = await createPromotion({ code: 'contada', percent: '10', usageLimit: 1 })
    const message = await expectFailure(() =>
      asRole(db, 'authenticated', claimsFor(TENANT_A), () =>
        sql(`update public.promotions set usage_count = 0 where id = $1`, [promo]),
      ),
    )
    expect(message).toMatch(/permission denied/i)
  })
})

// ===========================================================================
describe('lo que el modelo hace imposible', () => {
  it('una campana de porcentaje sin porcentaje no se puede guardar', async () => {
    const message = await expectFailure(() => createPromotion({ code: 'malformada' }))
    expect(message).toMatch(/promotions_kind_shape/)
  })

  it('un 3x2 que regala tanto como cobra no se puede guardar', async () => {
    const message = await expectFailure(() =>
      createPromotion({ code: 'gratis', kind: 'x_for_y', buyQuantity: '3', freeQuantity: '3' }),
    )
    expect(message).toMatch(/promotions_free_below_buy/)
  })

  it('una escala colgada de una campana que no es de volumen no entra', async () => {
    const promo = await createPromotion({ code: 'pct', percent: '10' })
    const message = await expectFailure(() =>
      addTier({ promotion: promo, minQuantity: '5', percent: '5' }),
    )
    expect(message).toMatch(/promotion_tiers|foreign key|violates/i)
  })

  it('un componente de combo sin cantidad exigida no entra', async () => {
    const promo = await createPromotion({ code: 'combo', kind: 'bundle', amount: '5.00' })
    const message = await expectFailure(() =>
      addScope({ promotion: promo, kind: 'product', product: jabon, promotionKind: 'bundle' }),
    )
    expect(message).toMatch(/promotion_scopes_bundle_shape/)
  })

  it('una cantidad exigida fuera de un combo no entra', async () => {
    const promo = await createPromotion({ code: 'pct', percent: '10' })
    const message = await expectFailure(() =>
      addScope({ promotion: promo, kind: 'product', product: jabon, requiredQuantity: '2' }),
    )
    expect(message).toMatch(/promotion_scopes_qty_only_bundle/)
  })

  it('un alcance que apunta a la variante de OTRO producto no entra', async () => {
    const promo = await createPromotion({ code: 'cruzada', percent: '10' })
    const message = await expectFailure(() =>
      addScope({ promotion: promo, kind: 'variant', product: jabon, variant: camisetaRoja }),
    )
    expect(message).toMatch(/promotion_scopes_variant_fk|foreign key|violates/i)
  })

  it('dos escalas con el mismo minimo en la misma campana no conviven', async () => {
    const promo = await createPromotion({ code: 'volumen', kind: 'volume_tier' })
    await addTier({ promotion: promo, minQuantity: '10', percent: '5' })
    const message = await expectFailure(() =>
      addTier({ promotion: promo, minQuantity: '10', percent: '9' }),
    )
    expect(message).toMatch(/promotion_tiers_unique|duplicate key/i)
  })

  it('el mismo codigo de campana dos veces en la misma tienda no entra', async () => {
    await createPromotion({ code: 'repetida', percent: '10' })
    const message = await expectFailure(() => createPromotion({ code: 'repetida', percent: '20' }))
    expect(message).toMatch(/promotions_code_unique|duplicate key/i)
  })
})
