// @vitest-environment node
/**
 * P04-SaaS · El motor de precios, contra Postgres REAL.
 *
 * Lo que se prueba aqui es lo que hace que un precio sea defendible ante quien
 * lo paga:
 *
 *  · la PRECEDENCIA es total y documentada — cliente gana a segmento, segmento
 *    a canal, canal a tienda, y dentro del mismo alcance manda la prioridad;
 *  · la VIGENCIA se respeta en los dos bordes: una lista futura no adelanta
 *    precios y una caducada no los arrastra;
 *  · la MONEDA no se convierte sola: una lista en otra divisa no aplica;
 *  · el AISLAMIENTO se sostiene — un tenant no ve, no escribe y no cobra con
 *    las listas del otro;
 *  · y el FALLBACK al precio de catalogo funciona en los cuatro casos en que
 *    tiene que funcionar, incluido el tenant que no tiene el modulo contratado.
 *
 * El modelo se comprueba por lo que HACE IMPOSIBLE: un renglon que tarifa la
 * variante de otro producto, una presentacion que ese producto no tiene, dos
 * escalas iguales en la misma lista.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { TENANT_A, TENANT_B, asRole, claimsFor, createTestDatabase, expectFailure } from './harness.ts'

type Row = Record<string, unknown>

let db: PGlite

const STORE_A_SLUG = 'tienda-a'
const STORE_B_SLUG = 'tienda-b'
const PRICING = 'ecommerce.pricing.lists'

/**
 * Clientes B2B. Hasta P05 eran dos uuid sueltos porque `customers` no existia;
 * ahora existe y `price_list_assignments.customer_id` tiene FK contra ella, asi
 * que un uuid inventado ya no entra. La fixtura los da de alta de verdad: el
 * test no se debilita, se vuelve mas parecido a produccion.
 */
let customerX: string
let customerY: string

let storeA: string
let storeB: string
let channelB2c: string
let channelB2b: string
let jabon: string
let camiseta: string
let camisetaRoja: string
let camisetaAzul: string
let productoB: string
let uomUnit: string
let uomBox: string
let segmentoMayorista: string

let listaTienda: string
let listaCanal: string
let listaSegmento: string
let listaCliente: string

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

interface ResolveOptions {
  store?: string
  channel?: string | null
  variant?: string | null
  uom?: string | null
  quantity?: number
  currency?: string | null
  at?: string | null
  segment?: string | null
  customer?: string | null
}

/**
 * Una sola linea. Todo el dinero se pide ya en TEXTO desde SQL: pasar un
 * `numeric` por un `number` de JavaScript pierde los decimales de cola —"8.00"
 * se convierte en 8— y con ello la propiedad que estos tests comprueban.
 */
const RESOLUTION_COLUMNS = `
  line_key, product_id, variant_id, uom_id,
  quantity::text          as quantity,
  uom_factor::text        as uom_factor,
  quantity_base::text     as quantity_base,
  unit_price::text        as unit_price,
  compare_at_price::text  as compare_at_price,
  source, price_list_id, price_list_code, price_list_item_id, scope,
  min_quantity::text      as min_quantity,
  currency`

async function resolve(product: string, options: ResolveOptions = {}): Promise<Row> {
  const [row] = await svc(
    `select ${RESOLUTION_COLUMNS}
       from ebim.resolve_prices(
         $1, $2,
         jsonb_build_array(jsonb_build_object(
           'line_key', 'single', 'product_id', $3::uuid, 'variant_id', $4::uuid,
           'uom_id', $5::uuid, 'quantity', $6::numeric)),
         $7, coalesce($8::timestamptz, now()), $9, $10)`,
    [
      options.store ?? storeA,
      options.channel === undefined ? channelB2c : options.channel,
      product,
      options.variant ?? null,
      options.uom ?? null,
      options.quantity ?? 1,
      options.currency ?? 'PEN',
      options.at ?? null,
      options.segment ?? null,
      options.customer ?? null,
    ],
  )
  return (row ?? {}) as Row
}

async function priceOf(product: string, options: ResolveOptions = {}): Promise<string> {
  const result = await resolve(product, options)
  return String(result.unit_price)
}

/** Da de alta una lista con su asignacion. Devuelve el id de la lista. */
async function createList(input: {
  code: string
  currency?: string
  priority?: number
  validFrom?: string
  validTo?: string | null
  scope: 'store' | 'channel' | 'segment' | 'customer'
  target?: string | null
  store?: string
  tenant?: typeof TENANT_A
  active?: boolean
}): Promise<string> {
  const tenant = input.tenant ?? TENANT_A
  const store = input.store ?? storeA
  const listId = await id(
    `insert into public.price_lists
       (organization_id, company_id, store_id, code, name, currency, priority,
        valid_from, valid_to, is_active)
     values ($1, $2, $3, $4, $5, $6, $7, coalesce($8::timestamptz, now() - interval '1 day'), $9, $10)
     returning id`,
    [
      tenant.organizationId, tenant.companyId, store, input.code, input.code,
      input.currency ?? 'PEN', input.priority ?? 0,
      input.validFrom ?? null, input.validTo ?? null, input.active ?? true,
    ],
  )

  await svc(
    `insert into public.price_list_assignments
       (organization_id, company_id, store_id, price_list_id, scope,
        channel_id, segment_id, customer_id)
     values ($1, $2, $3, $4, $5::public.price_scope, $6, $7, $8)`,
    [
      tenant.organizationId, tenant.companyId, store, listId, input.scope,
      input.scope === 'channel' ? input.target : null,
      input.scope === 'segment' ? input.target : null,
      input.scope === 'customer' ? input.target : null,
    ],
  )

  return listId
}

async function addItem(input: {
  list: string
  product: string
  variant?: string | null
  uom?: string | null
  minQuantity?: number
  price: string
  compareAt?: string | null
  store?: string
  tenant?: typeof TENANT_A
}): Promise<string> {
  const tenant = input.tenant ?? TENANT_A
  return id(
    `insert into public.price_list_items
       (organization_id, company_id, store_id, price_list_id, product_id,
        variant_id, uom_id, min_quantity, unit_price, compare_at_price)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     returning id`,
    [
      tenant.organizationId, tenant.companyId, input.store ?? storeA, input.list,
      input.product, input.variant ?? null, input.uom ?? null,
      input.minQuantity ?? 1, input.price, input.compareAt ?? null,
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
  await svc(`update public.store_settings set tax_rate = 0`)

  // SOLO el tenant A contrata el modulo. El B es el control: sus listas
  // existiran y no se aplicaran, que es la mitad menos probada del gating.
  await svc(
    `select public.sync_platform_context($1, $2, true, $3, 'hub'::public.entitlement_source, null)`,
    [TENANT_A.organizationId, TENANT_A.companyId, [PRICING]],
  )

  const stores = await svc(`select id, slug from public.stores order by slug`)
  storeA = String(stores.find((s) => s.slug === STORE_A_SLUG)?.id)
  storeB = String(stores.find((s) => s.slug === STORE_B_SLUG)?.id)

  const channels = await svc(`select id from public.channels where store_id = $1`, [storeA])
  channelB2c = String(channels[0]?.id)

  channelB2b = await id(
    `insert into public.channels
       (organization_id, company_id, store_id, code, name, kind, is_default, requires_auth)
     values ($1, $2, $3, 'b2b', 'Mayoristas', 'b2b', false, true) returning id`,
    [TENANT_A.organizationId, TENANT_A.companyId, storeA],
  )

  const insertProduct = `
    insert into public.products
      (organization_id, company_id, store_id, sku, slug, name, price, compare_at_price,
       currency, stock, status, published_at, kind)
    values ($1, $2, $3, $4, $5, $6, $7, $8, 'PEN', $9, 'published', now(), $10::public.product_kind)
    returning id`

  jabon = await id(insertProduct, [
    TENANT_A.organizationId, TENANT_A.companyId, storeA, 'A-JABON', 'jabon', 'Jabón',
    '10.00', '12.00', 1000, 'simple',
  ])
  camiseta = await id(insertProduct, [
    TENANT_A.organizationId, TENANT_A.companyId, storeA, 'A-CAMISETA', 'camiseta', 'Camiseta',
    '60.00', null, 0, 'variant',
  ])
  productoB = await id(insertProduct, [
    TENANT_B.organizationId, TENANT_B.companyId, storeB, 'B-LAMPARA', 'lampara', 'Lámpara',
    '55.00', null, 40, 'simple',
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
    '69.90', 100, false,
  ])

  uomUnit = await id(
    `insert into public.units_of_measure (organization_id, company_id, code, name)
     values ($1, $2, 'UND', 'Unidad') returning id`,
    [TENANT_A.organizationId, TENANT_A.companyId],
  )
  uomBox = await id(
    `insert into public.units_of_measure (organization_id, company_id, code, name)
     values ($1, $2, 'CAJA', 'Caja x 12') returning id`,
    [TENANT_A.organizationId, TENANT_A.companyId],
  )

  await svc(
    `insert into public.product_uoms
       (organization_id, company_id, store_id, product_id, uom_id, factor, is_base, is_sellable, price)
     values ($1, $2, $3, $4, $5, 1,  true,  true, null),
            ($1, $2, $3, $4, $6, 12, false, true, '100.00')`,
    [TENANT_A.organizationId, TENANT_A.companyId, storeA, jabon, uomUnit, uomBox],
  )

  segmentoMayorista = await id(
    `insert into public.customer_segments (organization_id, company_id, code, name)
     values ($1, $2, 'mayorista', 'Mayorista') returning id`,
    [TENANT_A.organizationId, TENANT_A.companyId],
  )

  const insertCustomer = `
    insert into public.customers (organization_id, company_id, kind, code, name)
    values ($1, $2, 'company', $3, $4) returning id`

  customerX = await id(insertCustomer, [
    TENANT_A.organizationId, TENANT_A.companyId, 'CLI-X', 'Cliente X',
  ])
  customerY = await id(insertCustomer, [
    TENANT_A.organizationId, TENANT_A.companyId, 'CLI-Y', 'Cliente Y',
  ])
}, 180_000)

/**
 * Cada bloque monta sus propias listas: el motor decide por precedencia, y
 * arrastrar listas de un test a otro haria que el resultado dependiera del
 * orden de ejecucion, que es justo lo que estos tests niegan.
 */
beforeEach(async () => {
  await svc(`delete from public.price_list_items`)
  await svc(`delete from public.price_list_assignments`)
  await svc(`delete from public.price_lists`)
  await svc(`delete from public.price_change_events`)
})

afterAll(async () => {
  await db?.close()
})

// ---------------------------------------------------------------------------

describe('el modelo hace imposibles los estados que corrompen un precio', () => {
  it('un renglon no puede tarifar la variante de OTRO producto', async () => {
    const otro = await id(
      `insert into public.products
         (organization_id, company_id, store_id, sku, slug, name, price, currency, stock, status, kind)
       values ($1, $2, $3, 'A-OTRO', 'otro', 'Otro', '1.00', 'PEN', 1, 'draft', 'simple')
       returning id`,
      [TENANT_A.organizationId, TENANT_A.companyId, storeA],
    )
    const lista = await createList({ code: 'l-variante', scope: 'store' })

    const message = await expectFailure(() =>
      addItem({ list: lista, product: otro, variant: camisetaRoja, price: '1.00' }),
    )
    expect(message).toMatch(/price_list_items_variant_fk|foreign key/i)
  })

  it('un renglon no puede tarifar una presentacion que ese producto no tiene', async () => {
    const lista = await createList({ code: 'l-uom', scope: 'store' })
    const message = await expectFailure(() =>
      addItem({ list: lista, product: camiseta, uom: uomBox, price: '1.00' }),
    )
    expect(message).toMatch(/price_list_items_uom_fk|foreign key/i)
  })

  it('un tachado por debajo del precio se rechaza', async () => {
    const lista = await createList({ code: 'l-tachado', scope: 'store' })
    const message = await expectFailure(() =>
      addItem({ list: lista, product: jabon, price: '9.00', compareAt: '5.00' }),
    )
    expect(message).toMatch(/compare_above/i)
  })

  it('dos escalas iguales para lo mismo en la misma lista se rechazan', async () => {
    const lista = await createList({ code: 'l-escala', scope: 'store' })
    await addItem({ list: lista, product: jabon, minQuantity: 10, price: '9.00' })
    const message = await expectFailure(() =>
      addItem({ list: lista, product: jabon, minQuantity: 10, price: '8.00' }),
    )
    expect(message).toMatch(/price_list_items_scale_product|duplicate key/i)
  })

  it('la misma escala para el producto y para una variante conviven', async () => {
    const lista = await createList({ code: 'l-convive', scope: 'store' })
    await addItem({ list: lista, product: camiseta, minQuantity: 1, price: '50.00' })
    await addItem({
      list: lista, product: camiseta, variant: camisetaRoja, minQuantity: 1, price: '45.00',
    })
    const rows = await svc(`select count(*)::int as n from public.price_list_items`)
    expect(rows[0]?.n).toBe(2)
  })

  it('la misma lista no se puede asignar dos veces al mismo destino', async () => {
    const lista = await createList({ code: 'l-doble', scope: 'store' })
    const message = await expectFailure(() =>
      svc(
        `insert into public.price_list_assignments
           (organization_id, company_id, store_id, price_list_id, scope)
         values ($1, $2, $3, $4, 'store')`,
        [TENANT_A.organizationId, TENANT_A.companyId, storeA, lista],
      ),
    )
    expect(message).toMatch(/price_list_assignments_unique|duplicate key/i)
  })

  it('el alcance y su columna tienen que corresponderse', async () => {
    const lista = await createList({ code: 'l-alcance', scope: 'store' })
    const message = await expectFailure(() =>
      svc(
        `insert into public.price_list_assignments
           (organization_id, company_id, store_id, price_list_id, scope, channel_id)
         values ($1, $2, $3, $4, 'segment', $5)`,
        [TENANT_A.organizationId, TENANT_A.companyId, storeA, lista, channelB2c],
      ),
    )
    expect(message).toMatch(/scope_target/i)
  })

  it('una vigencia que termina antes de empezar se rechaza', async () => {
    const message = await expectFailure(() =>
      svc(
        `insert into public.price_lists
           (organization_id, company_id, store_id, code, name, currency, valid_from, valid_to)
         values ($1, $2, $3, 'l-invertida', 'Invertida', 'PEN', now(), now() - interval '1 day')`,
        [TENANT_A.organizationId, TENANT_A.companyId, storeA],
      ),
    )
    expect(message).toMatch(/price_lists_period/i)
  })

  it('una prioridad fuera de rango se rechaza', async () => {
    const message = await expectFailure(() =>
      svc(
        `insert into public.price_lists
           (organization_id, company_id, store_id, code, name, currency, priority)
         values ($1, $2, $3, 'l-prio', 'Prioridad', 'PEN', 99999)`,
        [TENANT_A.organizationId, TENANT_A.companyId, storeA],
      ),
    )
    expect(message).toMatch(/priority_range/i)
  })
})

// ---------------------------------------------------------------------------

describe('aislamiento entre tenants', () => {
  beforeEach(async () => {
    await createList({ code: 'l-de-a', scope: 'store' })
  })

  it('el tenant B no ve ni una lista del tenant A', async () => {
    const rows = await asRole(db, 'authenticated', claimsFor(TENANT_B), () =>
      sql(`select id from public.price_lists`),
    )
    expect(rows).toEqual([])
  })

  it('el tenant A ve las suyas', async () => {
    const rows = await asRole(db, 'authenticated', claimsFor(TENANT_A), () =>
      sql(`select code from public.price_lists`),
    )
    expect(rows.map((r) => r.code)).toEqual(['l-de-a'])
  })

  it('el tenant B no puede crear una lista en la tienda del tenant A', async () => {
    const message = await expectFailure(() =>
      asRole(db, 'authenticated', claimsFor(TENANT_B), () =>
        sql(
          `insert into public.price_lists
             (organization_id, company_id, store_id, code, name, currency)
           values ($1, $2, $3, 'robada', 'Robada', 'PEN')`,
          [TENANT_B.organizationId, TENANT_B.companyId, storeA],
        ),
      ),
    )
    expect(message).toMatch(/row-level security|violates/i)
  })

  it('tampoco puede crearla declarando el tenant del vecino', async () => {
    const message = await expectFailure(() =>
      asRole(db, 'authenticated', claimsFor(TENANT_B), () =>
        sql(
          `insert into public.price_lists
             (organization_id, company_id, store_id, code, name, currency)
           values ($1, $2, $3, 'suplantada', 'Suplantada', 'PEN')`,
          [TENANT_A.organizationId, TENANT_A.companyId, storeA],
        ),
      ),
    )
    expect(message).toMatch(/row-level security|violates/i)
  })

  it('sin el modulo contratado, un admin no puede crear listas', async () => {
    // El tenant B tiene rol admin y NO tiene `pricing.lists`.
    const message = await expectFailure(() =>
      asRole(db, 'authenticated', claimsFor(TENANT_B), () =>
        sql(
          `insert into public.price_lists
             (organization_id, company_id, store_id, code, name, currency)
           values ($1, $2, $3, 'sin-addon', 'Sin addon', 'PEN')`,
          [TENANT_B.organizationId, TENANT_B.companyId, storeB],
        ),
      ),
    )
    expect(message).toMatch(/row-level security|violates/i)
  })

  it('un viewer del tenant A tampoco: hacen falta los dos ejes', async () => {
    const viewerClaims = claimsFor(TENANT_A, {
      sub: '0a000000-0000-4000-8000-0000000000d9',
      email: 'viewer@tenant-a.com',
      companies: [{ id: TENANT_A.companyId, role: 'viewer' }],
    })
    await svc(
      `insert into public.tenant_members
         (organization_id, company_id, user_id, email, role, status)
       values ($1, $2, $3, 'viewer@tenant-a.com', 'viewer', 'active')
       on conflict do nothing`,
      [TENANT_A.organizationId, TENANT_A.companyId, '0a000000-0000-4000-8000-0000000000d9'],
    )

    const message = await expectFailure(() =>
      asRole(db, 'authenticated', viewerClaims, () =>
        sql(
          `insert into public.price_lists
             (organization_id, company_id, store_id, code, name, currency)
           values ($1, $2, $3, 'de-viewer', 'De viewer', 'PEN')`,
          [TENANT_A.organizationId, TENANT_A.companyId, storeA],
        ),
      ),
    )
    expect(message).toMatch(/row-level security|violates/i)
  })

  it('anon no tiene ni un GRANT sobre las tablas del motor', async () => {
    const rows = await svc(`
      select table_name, privilege_type
      from information_schema.role_table_grants
      where table_schema = 'public'
        and grantee = 'anon'
        and table_name in ('price_lists', 'price_list_items', 'price_list_assignments',
                           'customer_segments', 'price_change_events')
    `)
    expect(rows).toEqual([])
  })

  it('la vista interna de listas vivas tampoco se concede a anon', async () => {
    const rows = await svc(`
      select grantee
      from information_schema.role_table_grants
      where table_schema = 'ebim' and table_name = 'active_price_lists'
        and grantee in ('anon', 'authenticated')
    `)
    expect(rows).toEqual([])
  })
})

// ---------------------------------------------------------------------------

describe('precedencia entre alcances', () => {
  beforeEach(async () => {
    listaTienda = await createList({ code: 'general', scope: 'store' })
    await addItem({ list: listaTienda, product: jabon, price: '8.00' })

    listaCanal = await createList({ code: 'canal-b2c', scope: 'channel', target: channelB2c })
    await addItem({ list: listaCanal, product: jabon, price: '7.50' })

    listaSegmento = await createList({
      code: 'mayorista', scope: 'segment', target: segmentoMayorista,
    })
    await addItem({ list: listaSegmento, product: jabon, price: '7.00' })

    listaCliente = await createList({ code: 'cliente-x', scope: 'customer', target: customerX })
    await addItem({ list: listaCliente, product: jabon, price: '6.00' })
  })

  it('sin canal, sin segmento y sin cliente manda la lista de la tienda', async () => {
    expect(await priceOf(jabon, { channel: null })).toBe('8.00')
  })

  it('el canal gana a la tienda', async () => {
    expect(await priceOf(jabon)).toBe('7.50')
  })

  it('el segmento gana al canal', async () => {
    expect(await priceOf(jabon, { segment: segmentoMayorista })).toBe('7.00')
  })

  it('el cliente gana al segmento', async () => {
    expect(await priceOf(jabon, { segment: segmentoMayorista, customer: customerX })).toBe('6.00')
  })

  it('un cliente sin acuerdo propio cae al segmento', async () => {
    expect(await priceOf(jabon, { segment: segmentoMayorista, customer: customerY })).toBe('7.00')
  })

  it('el desglose dice de donde salio el precio', async () => {
    const result = await resolve(jabon, { customer: customerX })
    expect(result.source).toBe('price_list')
    expect(result.price_list_code).toBe('cliente-x')
    expect(result.scope).toBe('customer')
    expect(result.price_list_id).toBe(listaCliente)
  })

  it('un canal distinto no arrastra el precio del canal por defecto', async () => {
    expect(await priceOf(jabon, { channel: channelB2b })).toBe('8.00')
  })
})

describe('prioridad dentro del mismo alcance', () => {
  it('la lista de mayor prioridad gana, aunque sea la mas antigua', async () => {
    const baja = await createList({ code: 'baja', scope: 'store', priority: 0 })
    await addItem({ list: baja, product: jabon, price: '9.00' })

    const alta = await createList({ code: 'alta', scope: 'store', priority: 500 })
    await addItem({ list: alta, product: jabon, price: '9.50' })

    expect(await priceOf(jabon)).toBe('9.50')
  })

  it('a igual prioridad manda la vigencia mas reciente', async () => {
    const vieja = await createList({
      code: 'vieja', scope: 'store', priority: 10,
      validFrom: new Date(Date.now() - 30 * 86_400_000).toISOString(),
    })
    await addItem({ list: vieja, product: jabon, price: '9.00' })

    const nueva = await createList({
      code: 'nueva', scope: 'store', priority: 10,
      validFrom: new Date(Date.now() - 86_400_000).toISOString(),
    })
    await addItem({ list: nueva, product: jabon, price: '8.25' })

    expect(await priceOf(jabon)).toBe('8.25')
  })

  it('la lista ganadora manda aunque su renglon sea menos concreto', async () => {
    // El canal gana a la tienda; dentro del canal solo hay precio de producto,
    // y en la tienda hay uno de variante. Primero se elige el ACUERDO.
    const tienda = await createList({ code: 't-variante', scope: 'store' })
    await addItem({ list: tienda, product: camiseta, variant: camisetaRoja, price: '30.00' })

    const canal = await createList({ code: 'c-producto', scope: 'channel', target: channelB2c })
    await addItem({ list: canal, product: camiseta, price: '55.00' })

    expect(await priceOf(camiseta, { variant: camisetaRoja })).toBe('55.00')
  })
})

// ---------------------------------------------------------------------------

describe('vigencia', () => {
  it('una lista que empieza manana no adelanta precios', async () => {
    const futura = await createList({
      code: 'futura', scope: 'store',
      validFrom: new Date(Date.now() + 86_400_000).toISOString(),
    })
    await addItem({ list: futura, product: jabon, price: '4.00' })

    expect(await priceOf(jabon)).toBe('10.00')
  })

  it('pero si se pregunta por esa fecha, si', async () => {
    const cuando = new Date(Date.now() + 2 * 86_400_000).toISOString()
    const futura = await createList({
      code: 'futura', scope: 'store',
      validFrom: new Date(Date.now() + 86_400_000).toISOString(),
    })
    await addItem({ list: futura, product: jabon, price: '4.00' })

    expect(await priceOf(jabon, { at: cuando })).toBe('4.00')
  })

  it('una lista caducada no arrastra su precio', async () => {
    const caducada = await createList({
      code: 'caducada', scope: 'store',
      validFrom: new Date(Date.now() - 10 * 86_400_000).toISOString(),
      validTo: new Date(Date.now() - 86_400_000).toISOString(),
    })
    await addItem({ list: caducada, product: jabon, price: '3.00' })

    expect(await priceOf(jabon)).toBe('10.00')
  })

  it('una lista desactivada tampoco', async () => {
    const apagada = await createList({ code: 'apagada', scope: 'store', active: false })
    await addItem({ list: apagada, product: jabon, price: '2.00' })

    expect(await priceOf(jabon)).toBe('10.00')
  })

  it('una asignacion desactivada deja la lista sin destino', async () => {
    const lista = await createList({ code: 'sin-destino', scope: 'store' })
    await addItem({ list: lista, product: jabon, price: '2.50' })
    await svc(`update public.price_list_assignments set is_active = false`)

    expect(await priceOf(jabon)).toBe('10.00')
  })
})

// ---------------------------------------------------------------------------

describe('moneda', () => {
  it('una lista en otra divisa no aplica: el motor no convierte', async () => {
    const enDolares = await createList({ code: 'usd', scope: 'store', currency: 'USD' })
    await addItem({ list: enDolares, product: jabon, price: '2.00' })

    expect(await priceOf(jabon)).toBe('10.00')
  })

  it('la lista en la moneda pedida si aplica', async () => {
    const enSoles = await createList({ code: 'pen', scope: 'store', currency: 'PEN' })
    await addItem({ list: enSoles, product: jabon, price: '8.80' })

    expect(await priceOf(jabon)).toBe('8.80')
  })

  it('la moneda viaja en el desglose', async () => {
    const result = await resolve(jabon)
    expect(result.currency).toBe('PEN')
  })
})

// ---------------------------------------------------------------------------

describe('escalas por cantidad', () => {
  beforeEach(async () => {
    const lista = await createList({ code: 'escalas', scope: 'store' })
    await addItem({ list: lista, product: jabon, minQuantity: 1, price: '10.00' })
    await addItem({ list: lista, product: jabon, minQuantity: 10, price: '9.00' })
    await addItem({ list: lista, product: jabon, minQuantity: 100, price: '7.00' })
  })

  it('por debajo de la primera escala manda la de 1', async () => {
    expect(await priceOf(jabon, { quantity: 5 })).toBe('10.00')
  })

  it('justo en la escala, la escala', async () => {
    expect(await priceOf(jabon, { quantity: 10 })).toBe('9.00')
  })

  it('gana la escala MAYOR alcanzada, no la primera que encaja', async () => {
    expect(await priceOf(jabon, { quantity: 150 })).toBe('7.00')
  })

  it('la escala se mide en unidades base: 10 cajas de 12 son 120', async () => {
    // 120 unidades base alcanzan la escala de 100 → 7.00 la unidad, x12 la caja.
    expect(await priceOf(jabon, { uom: uomBox, quantity: 10 })).toBe('84.00')
  })

  it('el desglose dice que escala se aplico', async () => {
    const result = await resolve(jabon, { quantity: 150 })
    expect(String(result.min_quantity)).toBe('100.000000')
    expect(String(result.quantity_base)).toBe('150')
  })
})

// ---------------------------------------------------------------------------

describe('variantes y presentaciones', () => {
  it('un precio de variante gana al precio de producto dentro de la misma lista', async () => {
    const lista = await createList({ code: 'l-var', scope: 'store' })
    await addItem({ list: lista, product: camiseta, price: '50.00' })
    await addItem({ list: lista, product: camiseta, variant: camisetaRoja, price: '42.00' })

    expect(await priceOf(camiseta, { variant: camisetaRoja })).toBe('42.00')
    expect(await priceOf(camiseta, { variant: camisetaAzul })).toBe('50.00')
  })

  it('un precio por unidad base se convierte con el factor de la presentacion', async () => {
    const lista = await createList({ code: 'l-base', scope: 'store' })
    await addItem({ list: lista, product: jabon, price: '8.00' })

    expect(await priceOf(jabon, { uom: uomBox })).toBe('96.00')
  })

  it('un precio ABSOLUTO de la presentacion no se multiplica', async () => {
    const lista = await createList({ code: 'l-caja', scope: 'store' })
    await addItem({ list: lista, product: jabon, price: '8.00' })
    await addItem({ list: lista, product: jabon, uom: uomBox, price: '85.00' })

    expect(await priceOf(jabon, { uom: uomBox })).toBe('85.00')
    // Y no contamina el precio de la unidad suelta.
    expect(await priceOf(jabon)).toBe('8.00')
  })

  it('un precio absoluto de OTRA presentacion no decide esta', async () => {
    const lista = await createList({ code: 'l-solo-caja', scope: 'store' })
    await addItem({ list: lista, product: jabon, uom: uomBox, price: '85.00' })

    // Sin renglon para la unidad suelta se cae al catalogo, no a 85/12.
    expect(await priceOf(jabon)).toBe('10.00')
  })
})

// ---------------------------------------------------------------------------

describe('fallback al precio de catalogo', () => {
  it('sin ninguna lista, el precio del producto', async () => {
    const result = await resolve(jabon)
    expect(result.unit_price).toBe('10.00')
    expect(result.source).toBe('catalog')
    expect(result.price_list_id).toBeNull()
  })

  it('sin ninguna lista, la variante hereda el precio del maestro', async () => {
    expect(await priceOf(camiseta, { variant: camisetaRoja })).toBe('60.00')
  })

  it('sin ninguna lista, la variante con precio propio manda', async () => {
    expect(await priceOf(camiseta, { variant: camisetaAzul })).toBe('69.90')
  })

  it('sin ninguna lista, la presentacion con precio propio manda sobre el factor', async () => {
    expect(await priceOf(jabon, { uom: uomBox })).toBe('100.00')
  })

  it('el tachado del catalogo sale cuando no manda ninguna lista', async () => {
    const result = await resolve(jabon)
    expect(result.compare_at_price).toBe('12.00')
  })

  it('con lista, el tachado del catalogo NO se arrastra', async () => {
    const lista = await createList({ code: 'l-sin-tachado', scope: 'store' })
    await addItem({ list: lista, product: jabon, price: '8.00' })

    const result = await resolve(jabon)
    expect(result.unit_price).toBe('8.00')
    expect(result.compare_at_price).toBeNull()
  })

  it('con lista, el tachado es el de la lista', async () => {
    const lista = await createList({ code: 'l-con-tachado', scope: 'store' })
    await addItem({ list: lista, product: jabon, price: '8.00', compareAt: '11.00' })

    const result = await resolve(jabon)
    expect(result.compare_at_price).toBe('11.00')
  })

  it('sin el modulo contratado, las listas del tenant NO se aplican', async () => {
    // El tenant B tiene lista, asignacion y precio. Lo que no tiene es el addon.
    const lista = await createList({
      code: 'b-general', scope: 'store', store: storeB, tenant: TENANT_B,
    })
    await addItem({
      list: lista, product: productoB, price: '30.00', store: storeB, tenant: TENANT_B,
    })

    const channelsB = await svc(`select id from public.channels where store_id = $1`, [storeB])
    const price = await priceOf(productoB, {
      store: storeB, channel: String(channelsB[0]?.id),
    })
    expect(price).toBe('55.00')
  })

  it('en cuanto contrata el modulo, la MISMA lista se aplica', async () => {
    const lista = await createList({
      code: 'b-general', scope: 'store', store: storeB, tenant: TENANT_B,
    })
    await addItem({
      list: lista, product: productoB, price: '30.00', store: storeB, tenant: TENANT_B,
    })
    const channelsB = await svc(`select id from public.channels where store_id = $1`, [storeB])

    await svc(
      `select public.sync_platform_context($1, $2, true, $3, 'hub'::public.entitlement_source, null)`,
      [TENANT_B.organizationId, TENANT_B.companyId, [PRICING]],
    )
    try {
      const price = await priceOf(productoB, {
        store: storeB, channel: String(channelsB[0]?.id),
      })
      expect(price).toBe('30.00')
    } finally {
      await svc(
        `select public.sync_platform_context($1, $2, true, '{}'::text[], 'hub'::public.entitlement_source, null)`,
        [TENANT_B.organizationId, TENANT_B.companyId],
      )
    }
  })

  it('un flag tecnico apaga el motor sin borrar una sola lista', async () => {
    const lista = await createList({ code: 'l-flag', scope: 'store' })
    await addItem({ list: lista, product: jabon, price: '8.00' })
    expect(await priceOf(jabon)).toBe('8.00')

    await svc(
      `insert into public.tenant_feature_flags
         (organization_id, company_id, flag_key, is_enabled)
       values ($1, $2, 'pricing.lists', false)`,
      [TENANT_A.organizationId, TENANT_A.companyId],
    )
    try {
      expect(await priceOf(jabon)).toBe('10.00')
    } finally {
      await svc(`delete from public.tenant_feature_flags`)
    }
  })

  it('un producto de OTRA tienda no devuelve precio', async () => {
    const result = await resolve(productoB)
    expect(result).toEqual({})
  })
})

// ---------------------------------------------------------------------------

describe('resolucion en lote', () => {
  it('cotiza varias lineas en una sola llamada y cada una con su regla', async () => {
    const lista = await createList({ code: 'lote', scope: 'store' })
    await addItem({ list: lista, product: jabon, minQuantity: 1, price: '9.00' })
    await addItem({ list: lista, product: jabon, minQuantity: 50, price: '7.00' })
    await addItem({ list: lista, product: camiseta, variant: camisetaAzul, price: '55.00' })

    const rows = await svc(
      `select line_key, unit_price::text as unit_price, source
         from ebim.resolve_prices($1, $2, $3::jsonb, 'PEN', now(), null, null)
        order by line_key`,
      [
        storeA,
        channelB2c,
        JSON.stringify([
          { line_key: '1', product_id: jabon, quantity: 2 },
          { line_key: '2', product_id: jabon, quantity: 60 },
          { line_key: '3', product_id: camiseta, variant_id: camisetaAzul, quantity: 1 },
          { line_key: '4', product_id: camiseta, variant_id: camisetaRoja, quantity: 1 },
        ]),
      ],
    )

    expect(rows.map((r) => [r.line_key, r.unit_price, r.source])).toEqual([
      ['1', '9.00', 'price_list'],
      ['2', '7.00', 'price_list'],
      ['3', '55.00', 'price_list'],
      ['4', '60.00', 'catalog'],
    ])
  })

  it('una linea de otra tienda simplemente no sale del lote', async () => {
    const rows = await svc(
      `select line_key from ebim.resolve_prices($1, $2, $3::jsonb, 'PEN', now(), null, null)`,
      [
        storeA,
        channelB2c,
        JSON.stringify([
          { line_key: '1', product_id: jabon, quantity: 1 },
          { line_key: '2', product_id: productoB, quantity: 1 },
        ]),
      ],
    )
    expect(rows.map((r) => r.line_key)).toEqual(['1'])
  })
})

// ---------------------------------------------------------------------------

describe('diagnostico de conflictos', () => {
  async function conflicts(store = storeA): Promise<Row[]> {
    return svc(`select * from public.price_list_conflicts($1) order by kind, price_list_code`, [store])
  }

  it('denuncia dos listas del mismo alcance con la misma prioridad y vigencias solapadas', async () => {
    const a = await createList({ code: 'gemela-a', scope: 'store', priority: 100 })
    await addItem({ list: a, product: jabon, price: '8.00' })
    const b = await createList({ code: 'gemela-b', scope: 'store', priority: 100 })
    await addItem({ list: b, product: jabon, price: '7.00' })

    const rows = await conflicts()
    const ambiguas = rows.filter((r) => r.kind === 'ambiguous_priority')
    expect(ambiguas.length).toBe(1)
    expect([ambiguas[0]?.price_list_code, ambiguas[0]?.other_list_code].sort()).toEqual([
      'gemela-a', 'gemela-b',
    ])
    expect(String(ambiguas[0]?.detail)).toContain('100')
    expect([a, b]).toContain(String(ambiguas[0]?.price_list_id))
  })

  it('no denuncia dos listas con prioridades distintas', async () => {
    const a = await createList({ code: 'p10', scope: 'store', priority: 10 })
    await addItem({ list: a, product: jabon, price: '8.00' })
    const b = await createList({ code: 'p20', scope: 'store', priority: 20 })
    await addItem({ list: b, product: jabon, price: '7.00' })

    expect((await conflicts()).filter((r) => r.kind === 'ambiguous_priority')).toEqual([])
  })

  it('no denuncia dos listas con la misma prioridad si sus vigencias no se tocan', async () => {
    const a = await createList({
      code: 'enero', scope: 'store', priority: 5,
      validFrom: new Date(Date.now() - 40 * 86_400_000).toISOString(),
      validTo: new Date(Date.now() - 20 * 86_400_000).toISOString(),
    })
    await addItem({ list: a, product: jabon, price: '8.00' })
    const b = await createList({
      code: 'febrero', scope: 'store', priority: 5,
      validFrom: new Date(Date.now() - 19 * 86_400_000).toISOString(),
    })
    await addItem({ list: b, product: jabon, price: '7.00' })

    expect((await conflicts()).filter((r) => r.kind === 'ambiguous_priority')).toEqual([])
  })

  it('denuncia la lista en una moneda que la tienda no usa', async () => {
    const usd = await createList({ code: 'en-usd', scope: 'store', currency: 'USD' })
    await addItem({ list: usd, product: jabon, price: '2.00' })

    const rows = (await conflicts()).filter((r) => r.kind === 'currency_mismatch')
    expect(rows.length).toBe(1)
    expect(String(rows[0]?.detail)).toContain('USD')
  })

  it('denuncia la lista caducada que sigue marcada activa', async () => {
    const vieja = await createList({
      code: 'vencida', scope: 'store',
      validFrom: new Date(Date.now() - 10 * 86_400_000).toISOString(),
      validTo: new Date(Date.now() - 86_400_000).toISOString(),
    })
    await addItem({ list: vieja, product: jabon, price: '8.00' })

    expect((await conflicts()).filter((r) => r.kind === 'expired').length).toBe(1)
  })

  it('denuncia la lista sin asignar y la lista asignada sin precios', async () => {
    await svc(
      `insert into public.price_lists
         (organization_id, company_id, store_id, code, name, currency)
       values ($1, $2, $3, 'huerfana', 'Huerfana', 'PEN')`,
      [TENANT_A.organizationId, TENANT_A.companyId, storeA],
    )
    await createList({ code: 'vacia', scope: 'store' })

    const rows = await conflicts()
    expect(rows.filter((r) => r.kind === 'unassigned').map((r) => r.price_list_code)).toEqual([
      'huerfana',
    ])
    expect(rows.filter((r) => r.kind === 'empty').map((r) => r.price_list_code)).toEqual(['vacia'])
  })

  it('una lista sana no aparece en el diagnostico', async () => {
    const sana = await createList({ code: 'sana', scope: 'store' })
    await addItem({ list: sana, product: jabon, price: '8.00' })
    expect(await conflicts()).toEqual([])
  })

  it('el diagnostico del vecino no devuelve nada, por falta de permiso', async () => {
    const sana = await createList({ code: 'sana', scope: 'store' })
    await addItem({ list: sana, product: jabon, price: '8.00' })

    const rows = await asRole(db, 'authenticated', claimsFor(TENANT_B), () =>
      sql(`select * from public.price_list_conflicts($1)`, [storeA]),
    )
    expect(rows).toEqual([])
  })
})

// ---------------------------------------------------------------------------

describe('bitacora de cambios de precio', () => {
  it('anota el alta, el cambio y el borrado de un precio', async () => {
    const lista = await createList({ code: 'auditada', scope: 'store' })
    const item = await addItem({ list: lista, product: jabon, price: '8.00' })
    await svc(`update public.price_list_items set unit_price = '7.50' where id = $1`, [item])
    await svc(`delete from public.price_list_items where id = $1`, [item])

    const rows = await svc(
      `select action, old_unit_price::text as old_price, new_unit_price::text as new_price
         from public.price_change_events order by occurred_at`,
    )
    expect(rows).toEqual([
      { action: 'insert', old_price: null, new_price: '8.00' },
      { action: 'update', old_price: '8.00', new_price: '7.50' },
      { action: 'delete', old_price: '7.50', new_price: null },
    ])
  })

  it('un update que no toca precio ni escala no ensucia la bitacora', async () => {
    const lista = await createList({ code: 'auditada', scope: 'store' })
    const item = await addItem({ list: lista, product: jabon, price: '8.00' })
    await svc(`delete from public.price_change_events`)

    await svc(`update public.price_list_items set updated_at = now() where id = $1`, [item])
    const rows = await svc(`select count(*)::int as n from public.price_change_events`)
    expect(rows[0]?.n).toBe(0)
  })

  it('guarda quien lo hizo cuando lo hace una persona', async () => {
    const lista = await createList({ code: 'auditada', scope: 'store' })
    await asRole(db, 'authenticated', claimsFor(TENANT_A), () =>
      sql(
        `insert into public.price_list_items
           (organization_id, company_id, store_id, price_list_id, product_id, unit_price)
         values ($1, $2, $3, $4, $5, '8.00')`,
        [TENANT_A.organizationId, TENANT_A.companyId, storeA, lista, jabon],
      ),
    )

    const [row] = await svc(`select actor_id, actor_email from public.price_change_events`)
    expect(row?.actor_id).toBe(TENANT_A.ownerId)
    expect(row?.actor_email).toBe(TENANT_A.adminEmail)
  })

  it('la bitacora no se puede escribir ni borrar desde el cliente', async () => {
    const lista = await createList({ code: 'auditada', scope: 'store' })
    await addItem({ list: lista, product: jabon, price: '8.00' })

    const insert = await expectFailure(() =>
      asRole(db, 'authenticated', claimsFor(TENANT_A), () =>
        sql(
          `insert into public.price_change_events
             (organization_id, company_id, store_id, action)
           values ($1, $2, $3, 'insert')`,
          [TENANT_A.organizationId, TENANT_A.companyId, storeA],
        ),
      ),
    )
    expect(insert).toMatch(/permission denied|row-level security/i)

    const remove = await expectFailure(() =>
      asRole(db, 'authenticated', claimsFor(TENANT_A), () =>
        sql(`delete from public.price_change_events`),
      ),
    )
    expect(remove).toMatch(/permission denied|row-level security/i)
  })

  it('el tenant B no lee la bitacora del tenant A', async () => {
    const lista = await createList({ code: 'auditada', scope: 'store' })
    await addItem({ list: lista, product: jabon, price: '8.00' })

    const rows = await asRole(db, 'authenticated', claimsFor(TENANT_B), () =>
      sql(`select id from public.price_change_events`),
    )
    expect(rows).toEqual([])
  })

  it('sobrevive al borrado de la lista', async () => {
    const lista = await createList({ code: 'efimera', scope: 'store' })
    await addItem({ list: lista, product: jabon, price: '8.00' })
    await svc(`delete from public.price_lists where id = $1`, [lista])

    const rows = await svc(
      `select action, price_list_id from public.price_change_events order by action`,
    )
    expect(rows.map((r) => r.action)).toEqual(['delete', 'insert'])
    expect(rows[0]?.price_list_id).toBe(lista)
  })

  it('el envoltorio de una sola linea devuelve el mismo desglose en jsonb', async () => {
    const lista = await createList({ code: 'jsonb', scope: 'store' })
    await addItem({ list: lista, product: jabon, price: '8.00' })

    const [row] = await svc(
      `select r ->> 'unit_price' as unit_price,
              r ->> 'source'     as source,
              r ->> 'price_list_code' as code
         from ebim.resolve_price($1, $2, $3, null, null, 1, 'PEN', now(), null, null) as r`,
      [storeA, channelB2c, jabon],
    )
    expect(row).toEqual({ unit_price: '8.00', source: 'price_list', code: 'jsonb' })
  })
})
