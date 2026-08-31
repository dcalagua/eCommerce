// @vitest-environment node
/**
 * Favoritos del comprador, sobre Postgres real.
 *
 * Lo que se prueba aquí no es que el corazón se encienda: es que la única
 * puerta de escritura sea la función, que el tenant salga del PRODUCTO y no del
 * cliente, y que un comprador no vea —ni por asomo— lo que guardó otro. Un
 * favorito filtrado dice qué compra una botica de la competencia.
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

/** Dos compradores distintos. No son miembros de ningún tenant: solo un `sub`. */
const SHOPPER_1 = '0c000000-0000-4000-8000-00000000f001'
const SHOPPER_2 = '0c000000-0000-4000-8000-00000000f002'

let db: PGlite
const storeOf: Record<string, string> = {}
const productOf: Record<string, string> = {}
let draftProduct = ''

async function svc<T = Row>(query: string, params: unknown[] = []): Promise<T[]> {
  return asRole(db, 'service_role', null, async () => {
    const result = await db.query<T>(query, params)
    return result.rows
  })
}

/** Claims de un COMPRADOR: sesión y nada más. Sin `org_id` ni `companies`. */
function shopperClaims(sub: string) {
  return {
    sub,
    email: `${sub}@comprador.test`,
    org_id: '',
    companies: [],
    active_company: '',
  } as unknown as ReturnType<typeof claimsFor>
}

async function asShopper<T>(sub: string, run: (tx: PGlite) => Promise<T>): Promise<T> {
  return asRole(db, 'authenticated', shopperClaims(sub), run)
}

async function toggle(sub: string, productId: string): Promise<boolean> {
  return asShopper(sub, async () => {
    const result = await db.query<{ state: boolean }>(
      'select public.toggle_product_favorite($1) as state',
      [productId],
    )
    return result.rows[0]!.state
  })
}

async function favorites(sub: string, storeId: string): Promise<string[]> {
  return asShopper(sub, async () => {
    const result = await db.query<{ product_id: string }>(
      'select product_id from public.my_product_favorites($1)',
      [storeId],
    )
    return result.rows.map((row) => row.product_id)
  })
}

beforeAll(async () => {
  db = await createTestDatabase()

  for (const tenant of [TENANT_A, TENANT_B]) {
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

    // `bootstrap_tenant` deja la tienda en borrador, y el favorito exige tienda
    // ACTIVA: es la misma frontera que ve el comprador.
    const [store] = await svc<{ id: string }>(
      `update public.stores set status = 'active' where slug = $1 returning id`,
      [tenant.storeSlug],
    )
    storeOf[tenant.slug] = store!.id

    const [product] = await svc<{ id: string }>(
      `insert into public.products
         (organization_id, company_id, store_id, sku, slug, name, price, currency, stock,
          status, published_at)
       values ($1, $2, $3, $4, $5, $6, 10, 'PEN', 5, 'published', now())
       returning id`,
      [
        tenant.organizationId,
        tenant.companyId,
        store!.id,
        `FAV-${tenant.slug}`,
        `fav-${tenant.slug}`,
        `Producto de ${tenant.slug}`,
      ],
    )
    productOf[tenant.slug] = product!.id
  }

  const [borrador] = await svc<{ id: string }>(
    `insert into public.products
       (organization_id, company_id, store_id, sku, slug, name, price, currency, stock, status)
     values ($1, $2, $3, 'FAV-DRAFT', 'fav-draft', 'Borrador', 10, 'PEN', 5, 'draft')
     returning id`,
    [TENANT_A.organizationId, TENANT_A.companyId, storeOf[TENANT_A.slug]],
  )
  draftProduct = borrador!.id
})

beforeEach(async () => {
  // El corazón es un interruptor: encadenar pulsaciones entre pruebas hace que
  // un fallo arrastre a las siguientes. Cada una empieza sin nada guardado.
  await svc('delete from public.product_favorites')
})

afterAll(async () => {
  await db.close()
})

describe('guardar y quitar', () => {
  it('el corazón es un interruptor: dos pulsaciones dejan lo de antes', async () => {
    const product = productOf[TENANT_A.slug]!
    expect(await toggle(SHOPPER_1, product)).toBe(true)
    expect(await favorites(SHOPPER_1, storeOf[TENANT_A.slug]!)).toEqual([product])

    expect(await toggle(SHOPPER_1, product)).toBe(false)
    expect(await favorites(SHOPPER_1, storeOf[TENANT_A.slug]!)).toEqual([])
  })

  it('el tenant NO lo declara el cliente: sale del producto', async () => {
    const product = productOf[TENANT_A.slug]!
    await toggle(SHOPPER_1, product)

    const [row] = await svc<{ organization_id: string; company_id: string; store_id: string }>(
      `select organization_id, company_id, store_id from public.product_favorites
        where product_id = $1`,
      [product],
    )
    expect(row?.organization_id).toBe(TENANT_A.organizationId)
    expect(row?.company_id).toBe(TENANT_A.companyId)
    expect(row?.store_id).toBe(storeOf[TENANT_A.slug])
  })

  it('un producto en borrador no se puede guardar: si no se ve, no existe', async () => {
    const message = await expectFailure(() => toggle(SHOPPER_1, draftProduct))
    expect(message).toContain('PRODUCTO_NO_ENCONTRADO')
  })

  it('sin sesión no hay favoritos', async () => {
    const message = await expectFailure(() =>
      asRole(db, 'anon', null, () =>
        db.query('select public.toggle_product_favorite($1)', [productOf[TENANT_A.slug]]),
      ),
    )
    // `anon` ni siquiera tiene EXECUTE: la puerta está cerrada antes de mirar
    // quién llama.
    expect(message).toMatch(/permission denied|denegado/i)
  })
})

describe('aislamiento', () => {
  it('un comprador no ve lo que guardó otro', async () => {
    const product = productOf[TENANT_A.slug]!
    await toggle(SHOPPER_1, product)

    expect(await favorites(SHOPPER_2, storeOf[TENANT_A.slug]!)).toEqual([])

    const ajenos = await asShopper(SHOPPER_2, async () => {
      const result = await db.query('select * from public.product_favorites')
      return result.rows
    })
    expect(ajenos).toHaveLength(0)
  })

  it('el backoffice ve los favoritos de SU catálogo y ninguno del vecino', async () => {
    await toggle(SHOPPER_1, productOf[TENANT_A.slug]!)
    await toggle(SHOPPER_2, productOf[TENANT_B.slug]!)

    const deA = await asRole(db, 'authenticated', claimsFor(TENANT_A), async () => {
      const result = await db.query<{ product_id: string }>(
        'select product_id from public.product_favorites',
      )
      return result.rows.map((row) => row.product_id)
    })

    expect(deA).toEqual([productOf[TENANT_A.slug]])
    expect(deA).not.toContain(productOf[TENANT_B.slug])
  })

  it('nadie escribe la tabla a mano: la única puerta es la función', async () => {
    const message = await expectFailure(() =>
      asShopper(SHOPPER_2, () =>
        db.query(
          `insert into public.product_favorites
             (organization_id, company_id, store_id, product_id, user_id)
           values ($1, $2, $3, $4, $5)`,
          [
            TENANT_A.organizationId,
            TENANT_A.companyId,
            storeOf[TENANT_A.slug],
            productOf[TENANT_A.slug],
            SHOPPER_2,
          ],
        ),
      ),
    )
    expect(message).toMatch(/row-level security|permission denied|denegado/i)
  })
})
