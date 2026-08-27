// @vitest-environment node
/**
 * Canales de venta sobre catálogo único (M1), sobre Postgres real.
 *
 * Lo que no puede fallar:
 *  - un tenant no ve ni escribe los canales del otro;
 *  - el comprador ANÓNIMO no ve canales cerrados (B2B / interno) aunque conozca
 *    su uuid, ni la visibilidad de catálogo asociada a ellos;
 *  - `create_order` decide el canal en servidor: el payload no puede declararlo;
 *  - un producto publicado en la tienda pero NO en el canal no se puede comprar
 *    por ese canal — que es lo que hace útil el catálogo restringido;
 *  - la migración deja las tiendas y pedidos existentes funcionando.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
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
let canalPublicoA: string
let canalInternoA: string
let sillaA: string
let exclusivoA: string

async function svc<T = Row>(query: string, params: unknown[] = []): Promise<T[]> {
  return asRole(db, 'service_role', null, async () => {
    const result = await db.query<T>(query, params)
    return result.rows
  })
}

async function asOwner<T = Row>(
  tenant: typeof TENANT_A,
  query: string,
  params: unknown[] = [],
): Promise<T[]> {
  return asRole(db, 'authenticated', claimsFor(tenant), async () => {
    const result = await db.query<T>(query, params)
    return result.rows
  })
}

async function asAnon<T = Row>(query: string, params: unknown[] = []): Promise<T[]> {
  return asRole(db, 'anon', null, async () => {
    const result = await db.query<T>(query, params)
    return result.rows
  })
}

async function addProduct(
  tenant: typeof TENANT_A,
  storeId: string,
  sku: string,
  price: string,
): Promise<string> {
  const [row] = await svc(
    `insert into public.products
       (organization_id, company_id, store_id, sku, slug, name, price, currency, stock, status, published_at)
     values ($1, $2, $3, $4, $5, $5, $6, 'PEN', 50, 'published', now())
     returning id`,
    [tenant.organizationId, tenant.companyId, storeId, sku, sku.toLowerCase(), price],
  )
  return String(row?.id)
}

beforeAll(async () => {
  db = await createTestDatabase()

  for (const tenant of [TENANT_A, TENANT_B]) {
    await svc(
      `select public.bootstrap_tenant($1, $2, $3, $3, $4, $5, $6, 'Tienda', 'PEN')`,
      [
        tenant.organizationId,
        tenant.companyId,
        tenant.slug,
        tenant.adminEmail,
        tenant.ownerId,
        tenant.storeSlug,
      ],
    )
  }

  const stores = await svc(`select id, slug from public.stores order by slug`)
  storeA = String(stores.find((s) => s.slug === TENANT_A.storeSlug)?.id)
  storeB = String(stores.find((s) => s.slug === TENANT_B.storeSlug)?.id)
  await svc(`update public.stores set status = 'active'`)

  const [pub] = await svc(
    `select id from public.channels where store_id = $1 and is_default`,
    [storeA],
  )
  canalPublicoA = String(pub?.id)

  const [interno] = await svc(
    `insert into public.channels
       (organization_id, company_id, store_id, code, name, kind, requires_auth)
     values ($1, $2, $3, 'interno', 'Colaboradores', 'internal', true)
     returning id`,
    [TENANT_A.organizationId, TENANT_A.companyId, storeA],
  )
  canalInternoA = String(interno?.id)

  sillaA = await addProduct(TENANT_A, storeA, 'SILLA-1', '100.00')
  exclusivoA = await addProduct(TENANT_A, storeA, 'EXCLU-1', '50.00')
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

describe('la migración no rompe lo que ya existía', () => {
  it('cada tienda existente recibe un canal b2c por defecto', async () => {
    const rows = await svc(
      `select code, kind, is_default, requires_auth from public.channels
        where store_id = $1 and is_default`,
      [storeB],
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      code: 'b2c',
      kind: 'b2c',
      is_default: true,
      requires_auth: false,
    })
  })

  it('no puede haber dos canales por defecto en la misma tienda', async () => {
    const message = await expectFailure(() =>
      svc(
        `insert into public.channels
           (organization_id, company_id, store_id, code, name, kind, is_default)
         values ($1, $2, $3, 'otro-b2c', 'Otro', 'b2c', true)`,
        [TENANT_A.organizationId, TENANT_A.companyId, storeA],
      ),
    )
    expect(message).toMatch(/channels_one_default|duplicate|unique/i)
  })

  it('un canal b2c no puede exigir sesión, ni uno cerrado prescindir de ella', async () => {
    for (const [kind, auth] of [
      ['b2c', true],
      ['b2b', false],
      ['internal', false],
    ] as const) {
      const message = await expectFailure(() =>
        svc(
          `insert into public.channels
             (organization_id, company_id, store_id, code, name, kind, requires_auth)
           values ($1, $2, $3, $4, 'X', $5::public.channel_kind, $6)`,
          [
            TENANT_A.organizationId,
            TENANT_A.companyId,
            storeA,
            `mal-${kind}-${auth}`,
            kind,
            auth,
          ],
        ),
      )
      expect(`${kind}/${auth}: ${message}`).toMatch(/channels_auth_matches_kind|violates check/i)
    }
  })
})

describe('aislamiento entre tenants', () => {
  it('un tenant no ve los canales del otro', async () => {
    const rows = await asOwner(TENANT_A, `select store_id from public.channels`)
    const stores = new Set(rows.map((r) => String(r.store_id)))
    expect(stores.has(storeA)).toBe(true)
    expect(stores.has(storeB)).toBe(false)
  })

  it('un tenant no puede crear un canal en la tienda del otro', async () => {
    const message = await expectFailure(() =>
      asOwner(
        TENANT_A,
        `insert into public.channels
           (organization_id, company_id, store_id, code, name, kind)
         values ($1, $2, $3, 'intruso', 'Intruso', 'b2c')`,
        [TENANT_B.organizationId, TENANT_B.companyId, storeB],
      ),
    )
    expect(message).toMatch(/row-level security|policy|denied/i)

    const [count] = await svc(
      `select count(*)::int as n from public.channels where code = 'intruso'`,
    )
    expect(count?.n).toBe(0)
  })
})

describe('el comprador anónimo no ve los canales cerrados', () => {
  it('ve el canal público y NO el interno, aunque conozca su uuid', async () => {
    const rows = await asAnon(
      `select id, code from public.channels where id = any($1::uuid[])`,
      [[canalPublicoA, canalInternoA]],
    )
    const ids = rows.map((r) => String(r.id))
    expect(ids).toContain(canalPublicoA)
    expect(ids).not.toContain(canalInternoA)
  })

  it('tampoco ve qué productos se venden en un canal cerrado', async () => {
    await svc(
      `insert into public.product_channels
         (organization_id, company_id, store_id, product_id, channel_id)
       values ($1, $2, $3, $4, $5)`,
      [TENANT_A.organizationId, TENANT_A.companyId, storeA, exclusivoA, canalInternoA],
    )

    const rows = await asAnon(
      `select product_id from public.product_channels where channel_id = $1`,
      [canalInternoA],
    )
    expect(rows).toHaveLength(0)
  })

  it('no puede escribir en canales ni en su visibilidad', async () => {
    const intentos: Array<[string, unknown[]]> = [
      [
        `insert into public.channels (organization_id, company_id, store_id, code, name, kind)
           values ($1, $2, $3, 'anon-canal', 'X', 'b2c')`,
        [TENANT_A.organizationId, TENANT_A.companyId, storeA],
      ],
      [`update public.channels set is_active = false where id = $1`, [canalPublicoA]],
      [`delete from public.product_channels where channel_id = $1`, [canalPublicoA]],
    ]

    for (const [sql, params] of intentos) {
      const message = await expectFailure(() => asAnon(sql, params))
      expect(message).toMatch(/permission denied|denied|policy/i)
    }
  })
})

describe('create_order decide el canal en servidor', () => {
  async function checkout(items: Array<{ product_id: string; quantity: number }>): Promise<Row> {
    const rows = await svc(
      `select public.create_order_for_slug(
          $1, 'ana@compradora.com', $2::jsonb, 'Ana', '+51 999 111 222',
          '{"address":"Av. Primavera 120"}'::jsonb, null) as result`,
      [TENANT_A.storeSlug, JSON.stringify(items)],
    )
    return rows[0]?.result as Row
  }

  it('el pedido nace en el canal por defecto de la tienda', async () => {
    const result = await checkout([{ product_id: sillaA, quantity: 1 }])
    expect(result.channel).toBe('b2c')

    const [order] = await svc(`select channel_id from public.orders where id = $1`, [
      result.order_id,
    ])
    expect(String(order?.channel_id)).toBe(canalPublicoA)
  })

  it('un canal declarado en el payload se RECHAZA, no se ignora', async () => {
    const message = await expectFailure(() =>
      svc(
        `select public.create_order_for_slug($1, 'ana@compradora.com',
           jsonb_build_array(jsonb_build_object(
             'product_id', $2::text, 'quantity', 1, 'channel_id', $3::text)))`,
        [TENANT_A.storeSlug, sillaA, canalInternoA],
      ),
    )
    expect(message).toMatch(/CAMPO_NO_PERMITIDO/)
  })

  it('un producto fuera del canal no se puede comprar por ese canal', async () => {
    // El canal público pasa a lista cerrada: solo la silla.
    await svc(
      `insert into public.product_channels
         (organization_id, company_id, store_id, product_id, channel_id)
       values ($1, $2, $3, $4, $5)`,
      [TENANT_A.organizationId, TENANT_A.companyId, storeA, sillaA, canalPublicoA],
    )

    // La silla sigue comprándose...
    const ok = await checkout([{ product_id: sillaA, quantity: 1 }])
    expect(ok.channel).toBe('b2c')

    // ...y el exclusivo del canal interno, no, pese a estar publicado.
    const message = await expectFailure(() =>
      checkout([{ product_id: exclusivoA, quantity: 1 }]),
    )
    expect(message).toMatch(/PRODUCTO_FUERA_DE_CANAL/)
  })

  it('sin canal por defecto activo, el checkout se para en vez de adivinar', async () => {
    await svc(`update public.channels set is_active = false where id = $1`, [canalPublicoA])

    const message = await expectFailure(() => checkout([{ product_id: sillaA, quantity: 1 }]))
    expect(message).toMatch(/CANAL_NO_DISPONIBLE/)

    await svc(`update public.channels set is_active = true where id = $1`, [canalPublicoA])
  })
})
