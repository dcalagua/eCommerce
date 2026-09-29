// @vitest-environment node
/**
 * Imágenes de campaña y de bloques bajo `content/` (20260928120000).
 *
 * Lo que no puede fallar:
 *  - una ruta `{org}/{store}/content/...` de la propia tienda se acepta, igual
 *    que `branding/`;
 *  - la de otra tienda, una carpeta vacía o una ruta con `..` no entran;
 *  - una campaña con su foto en `content/` se guarda (antes chocaba con el CHECK).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { TENANT_A, TENANT_B, asRole, createTestDatabase, expectFailure } from './harness.ts'

type Row = Record<string, unknown>

let db: PGlite
let storeA: string
let storeB: string

async function svc<T = Row>(query: string, params: unknown[] = []): Promise<T[]> {
  return asRole(db, 'service_role', null, async () => (await db.query<T>(query, params)).rows)
}

const vale = async (ruta: string, org: string, store: string) => {
  const [row] = await svc<{ ok: boolean }>(`select ebim.is_store_asset_ref($1, $2, $3) as ok`, [ruta, org, store])
  return row?.ok
}

beforeAll(async () => {
  db = await createTestDatabase()
  const ids: string[] = []
  for (const tenant of [TENANT_A, TENANT_B]) {
    const [row] = await svc<{ r: { store_id: string } }>(
      `select public.bootstrap_tenant($1, $2, $3, $3, $4, $5, $6, 'Tienda', 'PEN') as r`,
      [tenant.organizationId, tenant.companyId, tenant.slug, tenant.adminEmail, tenant.ownerId, tenant.storeSlug],
    )
    ids.push(String(row?.r.store_id))
  }
  ;[storeA, storeB] = ids as [string, string]
}, 120_000)

afterAll(async () => {
  await db?.close()
})

describe('la regla de rutas', () => {
  it('acepta content/ y branding/ de la propia tienda', async () => {
    const org = TENANT_A.organizationId
    expect(await vale(`${org}/${storeA}/content/content-1.jpg`, org, storeA)).toBe(true)
    expect(await vale(`${org}/${storeA}/branding/logo-1.png`, org, storeA)).toBe(true)
  })

  it('rechaza la ruta de otra tienda, la carpeta vacía y los `..`', async () => {
    const org = TENANT_A.organizationId
    expect(await vale(`${TENANT_B.organizationId}/${storeB}/content/x.jpg`, org, storeA)).toBe(false)
    expect(await vale(`${org}/${storeA}/content/`, org, storeA)).toBe(false)
    expect(await vale(`${org}/${storeA}/content/../../${storeB}/x.jpg`, org, storeA)).toBe(false)
    expect(await vale(`${org}/${storeA}/otra/x.jpg`, org, storeA)).toBe(false)
  })
})

describe('la campaña con foto', () => {
  it('se guarda con la imagen en content/', async () => {
    const ruta = `${TENANT_A.organizationId}/${storeA}/content/content-promo.jpg`
    const [row] = await svc<{ image_url: string }>(
      `insert into public.promotions
         (organization_id, company_id, store_id, code, name, kind, value_percent, image_url)
       values ($1, $2, $3, 'promo-foto', 'Promo con foto', 'percentage', 10, $4)
       returning image_url`,
      [TENANT_A.organizationId, TENANT_A.companyId, storeA, ruta],
    )
    expect(row?.image_url).toBe(ruta)
  })

  it('y no con la foto de otra tienda', async () => {
    const message = await expectFailure(() =>
      svc(
        `insert into public.promotions
           (organization_id, company_id, store_id, code, name, kind, value_percent, image_url)
         values ($1, $2, $3, 'promo-ajena', 'Promo ajena', 'percentage', 10, $4)`,
        [TENANT_A.organizationId, TENANT_A.companyId, storeA, `${TENANT_B.organizationId}/${storeB}/content/x.jpg`],
      ),
    )
    expect(message).toMatch(/promotions_image_ref/)
  })
})
