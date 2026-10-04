// @vitest-environment node
/**
 * Indicador de carga propio de la tienda · contra Postgres REAL (2026-10-02).
 *
 * Lo que la base no deja pasar, venga de donde venga la escritura:
 *
 *  · una ruta que no sea un objeto de ESTA tienda en `branding/loader-…`
 *    (ni la de otra tienda, ni una URL externa);
 *  · un formato que no sea PNG o WebP (un SVG servido puede llevar script);
 *  · una animación que no sea `spin`, `pulse` o `none`.
 *
 * Y lo que sí: el owner lo guarda, y el visitante anónimo lo lee por
 * `public_stores`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { TENANT_A, TENANT_B, asRole, claimsFor, createTestDatabase, expectFailure } from './harness.ts'

type Row = Record<string, unknown>

let db: PGlite
let storeA = ''
let storeB = ''

async function svc<T = Row>(query: string, params: unknown[] = []): Promise<T[]> {
  return asRole(db, 'service_role', null, async () => (await db.query<T>(query, params)).rows)
}
const ownerA = () =>
  claimsFor(TENANT_A, {
    sub: TENANT_A.ownerId,
    email: 'owner@a.com',
    companies: [{ id: TENANT_A.companyId, role: 'owner' }],
  })
async function comoOwnerA(query: string, params: unknown[] = []): Promise<Row[]> {
  return asRole(db, 'authenticated', ownerA(), async () => (await db.query<Row>(query, params)).rows)
}
async function falla(run: () => Promise<unknown>, motivo: RegExp): Promise<void> {
  expect(await expectFailure(run)).toMatch(motivo)
}
const ruta = (store: string, archivo: string, org = TENANT_A.organizationId) => `${org}/${store}/branding/${archivo}`

beforeAll(async () => {
  db = await createTestDatabase()
  for (const tenant of [TENANT_A, TENANT_B]) {
    await svc(`select public.bootstrap_tenant($1, $2, $3, $3, $4, $5, $6, 'Tienda', 'PEN')`, [
      tenant.organizationId,
      tenant.companyId,
      tenant.slug,
      tenant.adminEmail,
      tenant.ownerId,
      tenant.storeSlug,
    ])
  }
  await svc(`update public.stores set status = 'active'`)
  storeA = String((await svc(`select id from public.stores where slug = $1`, [TENANT_A.storeSlug]))[0]?.id)
  storeB = String((await svc(`select id from public.stores where slug = $1`, [TENANT_B.storeSlug]))[0]?.id)
}, 180_000)

afterAll(async () => {
  await db?.close()
})

const guardar = (url: string | null, animacion = 'spin') =>
  comoOwnerA(
    `update public.store_settings set loader_url = $1, loader_animation = $2 where store_id = $3 returning loader_url`,
    [url, animacion, storeA],
  )

describe('indicador de carga propio', () => {
  it('sin configurar: el de la suite (NULL) y la animación por defecto', async () => {
    const [fila] = await asRole(db, 'anon', null, async () =>
      (await db.query<Row>(`select loader_url, loader_animation from public.public_stores where slug = $1`, [TENANT_A.storeSlug])).rows,
    )
    expect(fila).toEqual({ loader_url: null, loader_animation: 'spin' })
  })

  it('el owner guarda su PNG o WebP y el visitante lo lee', async () => {
    expect(await guardar(ruta(storeA, 'loader-1.png'), 'pulse')).toHaveLength(1)
    expect(await guardar(ruta(storeA, 'loader-2.webp'), 'none')).toHaveLength(1)
    const [fila] = await asRole(db, 'anon', null, async () =>
      (await db.query<Row>(`select loader_url, loader_animation from public.public_stores where slug = $1`, [TENANT_A.storeSlug])).rows,
    )
    expect(fila).toEqual({ loader_url: ruta(storeA, 'loader-2.webp'), loader_animation: 'none' })
  })

  it('no acepta la ruta de otra tienda, una URL externa ni otra carpeta', async () => {
    await falla(() => guardar(ruta(storeB, 'loader-x.png', TENANT_B.organizationId)), /loader_url_check/)
    await falla(() => guardar('https://cdn.otro.test/loader.png'), /loader_url_check/)
    await falla(() => guardar(ruta(storeA, 'logo-1.png')), /loader_url_check/)
  })

  it('no acepta SVG ni otros formatos', async () => {
    await falla(() => guardar(ruta(storeA, 'loader-1.svg')), /loader_url_check/)
    await falla(() => guardar(ruta(storeA, 'loader-1.jpg')), /loader_url_check/)
  })

  it('solo tres animaciones', async () => {
    await falla(() => guardar(null, 'bounce'), /loader_animation_check/)
  })

  // 2026-10-04 · El formulario de Ajustes envía todas sus columnas en un UPDATE:
  // una sola sin GRANT tumba el guardado entero. Estas son las que añadieron
  // las pantallas del 2026-10-02 al 04.
  it('el owner puede escribir las columnas que envía Ajustes', async () => {
    const filas = await comoOwnerA(
      `update public.store_settings
          set tax_inclusive = true, loader_animation = 'pulse', home_videos = '[]'::jsonb,
              legal_name = 'Tienda A SAC', whatsapp_phone = '+51 999 111 222'
        where store_id = $1 returning tax_inclusive`,
      [storeA],
    )
    expect(filas).toEqual([{ tax_inclusive: true }])
  })

  it('el owner de A no toca el indicador de B', async () => {
    const filas = await comoOwnerA(
      `update public.store_settings set loader_animation = 'none' where store_id = $1 returning store_id`,
      [storeB],
    )
    expect(filas).toHaveLength(0)
  })
})
