// @vitest-environment node
/**
 * Videos de la portada · contra Postgres REAL (2026-10-04).
 *
 * La base no deja guardar, venga de donde venga la escritura:
 *
 *  · un video que no sea un objeto de ESTA tienda en `content/video-…` (ni de
 *    otra tienda, ni una URL externa, ni otro formato que MP4/WebM);
 *  · una duración fuera de 30..60 s o no entera;
 *  · más de 8 videos, o el mismo dos veces;
 *  · claves que no sean path/title/duration.
 *
 * Y la sección `videos` entra en la portada como una más: se enciende, se
 * ordena y admite los tres fondos.
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

let n = 0
const uuid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`
const ruta = (store = storeA, ext = 'mp4', org = TENANT_A.organizationId) => `${org}/${store}/content/video-${uuid()}.${ext}`
const video = (extra: Record<string, unknown> = {}) => ({ path: ruta(), title: 'Colección', duration: 45, ...extra })

const guardar = (lista: unknown) =>
  comoOwnerA(`update public.store_settings set home_videos = $1::jsonb where store_id = $2 returning store_id`, [
    JSON.stringify(lista),
    storeA,
  ])

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

describe('videos de la portada', () => {
  it('sin videos: lista vacía para el visitante', async () => {
    const [fila] = await asRole(db, 'anon', null, async () =>
      (await db.query<Row>(`select home_videos from public.public_stores where slug = $1`, [TENANT_A.storeSlug])).rows,
    )
    expect(fila?.home_videos).toEqual([])
  })

  it('el owner guarda MP4 y WebM de 30 a 60 s y el visitante los lee en orden', async () => {
    const lista = [video({ duration: 30 }), video({ path: ruta(storeA, 'webm'), title: null, duration: 60 })]
    expect(await guardar(lista)).toHaveLength(1)
    const [fila] = await asRole(db, 'anon', null, async () =>
      (await db.query<Row>(`select home_videos from public.public_stores where slug = $1`, [TENANT_A.storeSlug])).rows,
    )
    expect(fila?.home_videos).toEqual(lista)
  })

  it('no acepta videos de otra tienda, externos ni en otro formato', async () => {
    await falla(() => guardar([video({ path: ruta(storeB, 'mp4', TENANT_B.organizationId) })]), /home_videos_check/)
    await falla(() => guardar([video({ path: 'https://cdn.otro.test/v.mp4' })]), /home_videos_check/)
    await falla(() => guardar([video({ path: ruta(storeA, 'mov') })]), /home_videos_check/)
  })

  it('duración de 30 a 60 s, en entero', async () => {
    await falla(() => guardar([video({ duration: 29 })]), /home_videos_check/)
    await falla(() => guardar([video({ duration: 61 })]), /home_videos_check/)
    await falla(() => guardar([video({ duration: 45.5 })]), /home_videos_check/)
  })

  it('hasta 8, sin repetir, sin claves de más y con título corto', async () => {
    await falla(() => guardar(Array.from({ length: 9 }, () => video())), /home_videos_check/)
    const uno = video()
    await falla(() => guardar([uno, uno]), /home_videos_check/)
    await falla(() => guardar([video({ autoplay: true })]), /home_videos_check/)
    await falla(() => guardar([video({ title: 'x'.repeat(81) })]), /home_videos_check/)
  })

  it('cada video puede enlazar un producto (uuid) o ninguno', async () => {
    expect(await guardar([video({ product_id: '44444444-4444-4444-8444-444444444444' }), video({ product_id: null })])).toHaveLength(1)
    await falla(() => guardar([video({ product_id: 'mochila-negra' })]), /home_videos_check/)
  })

  it('el owner de A no toca los videos de B', async () => {
    const filas = await comoOwnerA(`update public.store_settings set home_videos = '[]' where store_id = $1 returning store_id`, [
      storeB,
    ])
    expect(filas).toHaveLength(0)
  })
})

describe('la sección `videos` en la portada', () => {
  it('se enciende y admite fondo de contraste', async () => {
    const layout = {
      version: 2,
      sections: [
        { id: 'hero', enabled: true },
        { id: 'videos', enabled: true, presentation: { surface: 'contrast', width: 'bleed' } },
      ],
    }
    const filas = await comoOwnerA(
      `update public.store_settings set home_layout = $1::jsonb where store_id = $2 returning store_id`,
      [JSON.stringify(layout), storeA],
    )
    expect(filas).toHaveLength(1)
  })

  it('no admite variantes que no existen', async () => {
    const layout = { version: 2, sections: [{ id: 'videos', enabled: true, presentation: { variant: 'grid' } }] }
    await falla(
      () =>
        comoOwnerA(`update public.store_settings set home_layout = $1::jsonb where store_id = $2`, [
          JSON.stringify(layout),
          storeA,
        ]),
      /home_layout/,
    )
  })
})
