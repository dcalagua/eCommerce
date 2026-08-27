// @vitest-environment node
/**
 * Modelo de lectura público del storefront (P05), sobre Postgres REAL.
 *
 * Lo que se comprueba aquí no es que las vistas "devuelvan algo", sino que un
 * comprador ANÓNIMO vea exactamente lo que el encargo permite y ni una fila
 * más: tienda activa, categoría activa, producto publicado — y nunca el
 * inventario exacto, el SKU ni el tenant.
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
let sillasA: string
let apagadaA: string
let publicadoA: string
let agotadoA: string
let huerfanoA: string

async function sql(query: string, params: unknown[] = []): Promise<Row[]> {
  const result = await db.query<Row>(query, params)
  return result.rows
}

const anon = <T>(run: (tx: PGlite) => Promise<T>) => asRole(db, 'anon', null, run)

async function seed(): Promise<void> {
  await asRole(db, 'service_role', null, async () => {
    for (const t of [TENANT_A, TENANT_B]) {
      await sql(`select public.bootstrap_tenant($1, $2, $3, $4, $5, $6, $7, $8, 'PEN')`, [
        t.organizationId,
        t.companyId,
        t.slug,
        `Cuenta ${t.slug}`,
        t.adminEmail,
        t.ownerId,
        t.storeSlug,
        `Tienda ${t.slug}`,
      ])
    }
    await sql(`update public.stores set status = 'active'`)

    const stores = await sql(`select id, slug from public.stores order by slug`)
    storeA = String(stores.find((s) => s.slug === TENANT_A.storeSlug)?.id)
    storeB = String(stores.find((s) => s.slug === TENANT_B.storeSlug)?.id)

    // Branding completo de A; B se queda con lo que trajo el alta, para
    // comprobar que la vitrina aguanta una tienda sin banner ni contacto.
    await sql(
      `update public.store_settings
          set banner_url = 'https://cdn.tienda-a.test/banner.jpg',
              hero_title = 'Muebles que duran',
              hero_subtitle = 'Fabricacion propia',
              contact_phone = '+51 999 111 222',
              contact_address = 'Av. Primavera 120',
              support_email = 'hola@tienda-a.test'
        where store_id = $1`,
      [storeA],
    )

    const insertCategory = `
      insert into public.categories
        (organization_id, company_id, store_id, slug, name, position, is_active)
      values ($1, $2, $3, $4, $5, $6, $7)
      returning id`

    sillasA = String(
      (
        await sql(insertCategory, [
          TENANT_A.organizationId, TENANT_A.companyId, storeA, 'sillas', 'Sillas', 1, true,
        ])
      )[0]?.id,
    )
    apagadaA = String(
      (
        await sql(insertCategory, [
          TENANT_A.organizationId, TENANT_A.companyId, storeA, 'apagada', 'Apagada', 2, false,
        ])
      )[0]?.id,
    )
    await sql(insertCategory, [
      TENANT_B.organizationId, TENANT_B.companyId, storeB, 'lamparas', 'Lamparas', 1, true,
    ])

    const insertProduct = `
      insert into public.products
        (organization_id, company_id, store_id, category_id, sku, slug, name, description,
         price, compare_at_price, currency, stock, status, published_at)
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'PEN', $11, $12, $13)
      returning id`

    publicadoA = String(
      (
        await sql(insertProduct, [
          TENANT_A.organizationId, TENANT_A.companyId, storeA, sillasA,
          'A-PUB-1', 'silla-roble', 'Silla de roble', 'Roble macizo',
          '389.00', '450.00', 24, 'published', new Date().toISOString(),
        ])
      )[0]?.id,
    )
    agotadoA = String(
      (
        await sql(insertProduct, [
          TENANT_A.organizationId, TENANT_A.companyId, storeA, sillasA,
          'A-PUB-2', 'silla-lino', 'Silla de lino', null,
          '429.00', null, 0, 'published', new Date().toISOString(),
        ])
      )[0]?.id,
    )
    // Publicado, pero colgando de una categoría que el tenant apagó.
    huerfanoA = String(
      (
        await sql(insertProduct, [
          TENANT_A.organizationId, TENANT_A.companyId, storeA, apagadaA,
          'A-PUB-3', 'banqueta-vieja', 'Banqueta', null,
          '99.00', null, 3, 'published', new Date().toISOString(),
        ])
      )[0]?.id,
    )
    await sql(insertProduct, [
      TENANT_A.organizationId, TENANT_A.companyId, storeA, sillasA,
      'A-DRAFT-1', 'silla-prototipo', 'Silla prototipo', null,
      '999.00', null, 1, 'draft', null,
    ])
    await sql(insertProduct, [
      TENANT_B.organizationId, TENANT_B.companyId, storeB, null,
      'B-PUB-1', 'lampara-b', 'Lampara B', null,
      '320.00', null, 9, 'published', new Date().toISOString(),
    ])

    // Una imagen por producto publicado de A, con la ruta que exige el CHECK.
    await sql(
      `insert into public.product_images
         (organization_id, company_id, store_id, product_id, storage_path, alt, position, is_primary)
       values ($1, $2, $3, $4, $5, 'Silla de roble', 0, true),
              ($1, $2, $3, $4, $6, null, 1, false)`,
      [
        TENANT_A.organizationId, TENANT_A.companyId, storeA, publicadoA,
        `${TENANT_A.organizationId}/${storeA}/${publicadoA}/principal.jpg`,
        `${TENANT_A.organizationId}/${storeA}/${publicadoA}/lateral.jpg`,
      ],
    )
  })
}

beforeAll(async () => {
  db = await createTestDatabase()
  await seed()
}, 180_000)

afterAll(async () => {
  await db?.close()
})

describe('public_stores — resolución de tienda por slug', () => {
  it('resuelve la tienda activa y sirve el branding entero', async () => {
    const rows = await anon(() =>
      sql(`select * from public.public_stores where slug = $1`, [TENANT_A.storeSlug]),
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]?.name).toBe(`Tienda ${TENANT_A.slug}`)
    expect(rows[0]?.banner_url).toBe('https://cdn.tienda-a.test/banner.jpg')
    expect(rows[0]?.hero_title).toBe('Muebles que duran')
    expect(rows[0]?.contact_phone).toBe('+51 999 111 222')
    expect(rows[0]?.contact_address).toBe('Av. Primavera 120')
    expect(rows[0]?.support_email).toBe('hola@tienda-a.test')
  })

  it('una tienda sin branding cargado sale igual, con los campos en null', async () => {
    const rows = await anon(() =>
      sql(`select name, banner_url, hero_title, contact_phone from public.public_stores where slug = $1`, [
        TENANT_B.storeSlug,
      ]),
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]?.banner_url).toBeNull()
    expect(rows[0]?.hero_title).toBeNull()
    expect(rows[0]?.contact_phone).toBeNull()
  })

  it('no expone el tenant ni el contador de pedidos', async () => {
    const rows = await anon(() => sql(`select * from public.public_stores limit 1`))
    const columns = Object.keys(rows[0] ?? {})
    expect(columns).not.toContain('organization_id')
    expect(columns).not.toContain('company_id')
    expect(columns).not.toContain('order_seq')
    expect(columns).not.toContain('tax_rate')
  })

  it('una tienda que no está activa no resuelve: la vitrina responde 404', async () => {
    await asRole(db, 'service_role', null, () =>
      sql(`update public.stores set status = 'suspended' where id = $1`, [storeB]),
    )
    const rows = await anon(() =>
      sql(`select slug from public.public_stores where slug = $1`, [TENANT_B.storeSlug]),
    )
    expect(rows).toHaveLength(0)

    await asRole(db, 'service_role', null, () =>
      sql(`update public.stores set status = 'active' where id = $1`, [storeB]),
    )
  })
})

describe('public_categories — solo categorías activas', () => {
  it('la categoría desactivada no aparece en el menú', async () => {
    const rows = await anon(() =>
      sql(`select slug from public.public_categories where store_id = $1 order by position`, [storeA]),
    )
    expect(rows.map((r) => r.slug)).toEqual(['sillas'])
  })

  it('cada tienda ve solo sus categorías', async () => {
    const rows = await anon(() =>
      sql(`select slug from public.public_categories where store_id = $1`, [storeB]),
    )
    expect(rows.map((r) => r.slug)).toEqual(['lamparas'])
  })
})

describe('public_products — solo publicado, y sin filtrar inventario', () => {
  it('borradores y archivados no salen', async () => {
    const rows = await anon(() =>
      sql(`select slug from public.public_products where store_id = $1 order by slug`, [storeA]),
    )
    expect(rows.map((r) => r.slug)).toEqual(['banqueta-vieja', 'silla-lino', 'silla-roble'])
  })

  it('una publicación programada a futuro todavía no se ve', async () => {
    await asRole(db, 'service_role', null, () =>
      sql(`update public.products set published_at = now() + interval '2 days' where id = $1`, [
        agotadoA,
      ]),
    )
    const rows = await anon(() =>
      sql(`select slug from public.public_products where store_id = $1`, [storeA]),
    )
    expect(rows.map((r) => r.slug)).not.toContain('silla-lino')

    await asRole(db, 'service_role', null, () =>
      sql(`update public.products set published_at = now() - interval '1 day' where id = $1`, [
        agotadoA,
      ]),
    )
  })

  it('`in_stock` dice si hay, pero nunca cuántas unidades quedan', async () => {
    const rows = await anon(() =>
      sql(`select slug, in_stock from public.public_products where store_id = $1 order by slug`, [
        storeA,
      ]),
    )
    expect(rows.find((r) => r.slug === 'silla-roble')?.in_stock).toBe(true)
    expect(rows.find((r) => r.slug === 'silla-lino')?.in_stock).toBe(false)
    expect(Object.keys(rows[0] ?? {})).not.toContain('stock')

    const message = await anon(() => expectFailure(() => sql(`select stock from public.products`)))
    expect(message).toMatch(/permission denied/i)
  })

  it('`in_stock` es generada: nadie puede dejarla mintiendo sobre el stock', async () => {
    const message = await asRole(db, 'service_role', null, () =>
      expectFailure(() =>
        sql(`update public.products set in_stock = true where id = $1`, [agotadoA]),
      ),
    )
    // Postgres lo dice así para una columna generada: solo admite DEFAULT.
    expect(message).toMatch(/can only be updated to DEFAULT/i)
  })

  it('un producto de categoría apagada sigue a la venta, pero sin anunciar la sección', async () => {
    const rows = await anon(() =>
      sql(`select slug, category_slug, category_name from public.public_products where product_id = $1`, [
        huerfanoA,
      ]),
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]?.category_slug).toBeNull()
    expect(rows[0]?.category_name).toBeNull()
  })

  it('el producto de una categoría activa sí trae su etiqueta', async () => {
    const rows = await anon(() =>
      sql(`select category_slug, category_name, primary_image_path, primary_image_alt
             from public.public_products where product_id = $1`, [publicadoA]),
    )
    expect(rows[0]?.category_slug).toBe('sillas')
    expect(rows[0]?.category_name).toBe('Sillas')
    expect(String(rows[0]?.primary_image_path)).toContain('principal.jpg')
    expect(rows[0]?.primary_image_alt).toBe('Silla de roble')
  })

  it('no expone sku, tenant ni estado interno', async () => {
    const rows = await anon(() => sql(`select * from public.public_products limit 1`))
    const columns = Object.keys(rows[0] ?? {})
    for (const forbidden of ['sku', 'organization_id', 'company_id', 'stock', 'status']) {
      expect(columns, `columna ${forbidden}`).not.toContain(forbidden)
    }
  })

  it('el catálogo de A y el de B no se mezclan', async () => {
    const rows = await anon(() =>
      sql(`select slug from public.public_products where store_id = $1`, [storeB]),
    )
    expect(rows.map((r) => r.slug)).toEqual(['lampara-b'])
  })
})

describe('public_product_images — galería de lo publicado', () => {
  it('devuelve la galería ordenable del producto publicado', async () => {
    const rows = await anon(() =>
      sql(
        `select storage_path, is_primary from public.public_product_images
          where product_id = $1 order by is_primary desc, position asc`,
        [publicadoA],
      ),
    )
    expect(rows).toHaveLength(2)
    expect(rows[0]?.is_primary).toBe(true)
  })

  it('las imágenes de un borrador no se sirven', async () => {
    await asRole(db, 'service_role', null, () =>
      sql(`update public.products set status = 'draft', published_at = null where id = $1`, [
        publicadoA,
      ]),
    )
    const rows = await anon(() =>
      sql(`select storage_path from public.public_product_images where product_id = $1`, [
        publicadoA,
      ]),
    )
    expect(rows).toHaveLength(0)

    await asRole(db, 'service_role', null, () =>
      sql(`update public.products set status = 'published', published_at = now() where id = $1`, [
        publicadoA,
      ]),
    )
  })
})

describe('el comprador anónimo no puede escribir por las vistas', () => {
  for (const view of ['public_stores', 'public_products', 'public_categories', 'public_product_images']) {
    it(`no inserta en ${view}`, async () => {
      const message = await anon(() =>
        expectFailure(() => sql(`insert into public.${view} default values`)),
      )
      expect(message).toMatch(/permission denied|cannot insert|no insert/i)
    })
  }
})

describe('el backoffice sigue viendo lo suyo por las mismas vistas', () => {
  it('un miembro de A ve el catálogo publicado de A y nada de B', async () => {
    const rows = await asRole(db, 'authenticated', claimsFor(TENANT_A), () =>
      sql(`select slug from public.public_products order by slug`),
    )
    expect(rows.map((r) => r.slug)).toEqual(['banqueta-vieja', 'silla-lino', 'silla-roble'])
  })
})
