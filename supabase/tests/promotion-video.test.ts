// @vitest-environment node
/**
 * Video de fondo en las promociones (20261004110000).
 *
 * Lo que no puede fallar:
 *  - una campaña guarda su video si es de la PROPIA tienda (content/video-…)
 *    y lleva imagen de respaldo;
 *  - sin imagen, con el video de otra tienda o con una URL externa, no entra;
 *  - la puerta pública (`store_promotions_for_slug`) lo devuelve al visitante.
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

const video = (org: string, store: string, ext = 'mp4') =>
  `${org}/${store}/content/video-00000000-0000-4000-8000-000000000001.${ext}`
const foto = () => `${TENANT_A.organizationId}/${storeA}/content/content-promo.jpg`

const insertar = (code: string, videoUrl: string | null, imageUrl: string | null) =>
  svc<{ video_url: string | null }>(
    `insert into public.promotions
       (organization_id, company_id, store_id, code, name, kind, value_percent, image_url, video_url)
     values ($1, $2, $3, $4, 'Promo', 'percentage', 10, $5, $6)
     returning video_url`,
    [TENANT_A.organizationId, TENANT_A.companyId, storeA, code, imageUrl, videoUrl],
  )

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
  await svc(`update public.stores set status = 'active'`)
}, 120_000)

afterAll(async () => {
  await db?.close()
})

describe('video de fondo de la campaña', () => {
  it('se guarda con su imagen de respaldo, en MP4 o WebM de la propia tienda', async () => {
    const [mp4] = await insertar('promo-video', video(TENANT_A.organizationId, storeA), foto())
    expect(mp4?.video_url).toBe(video(TENANT_A.organizationId, storeA))
  })

  it('sin imagen de respaldo, no', async () => {
    expect(await expectFailure(() => insertar('promo-sin-foto', video(TENANT_A.organizationId, storeA), null))).toMatch(
      /promotions_video_needs_image/,
    )
  })

  it('ni de otra tienda, ni externo, ni en otro formato', async () => {
    expect(
      await expectFailure(() => insertar('promo-ajena', video(TENANT_B.organizationId, storeB), foto())),
    ).toMatch(/promotions_video_ref/)
    expect(await expectFailure(() => insertar('promo-ext', 'https://cdn.otro.test/v.mp4', foto()))).toMatch(
      /promotions_video_ref/,
    )
    expect(
      await expectFailure(() => insertar('promo-mov', video(TENANT_A.organizationId, storeA, 'mov'), foto())),
    ).toMatch(/promotions_video_ref/)
  })

  it('el visitante lo recibe con la campaña', async () => {
    await svc(`update public.promotions set status = 'active', valid_from = now() - interval '1 day' where code = 'promo-video'`)
    const [row] = await asRole(db, 'anon', null, async () =>
      (
        await db.query<{ r: { promotions: Array<{ code?: string; name: string; video_url: string | null }> } }>(
          `select public.store_promotions_for_slug($1) as r`,
          [TENANT_A.storeSlug],
        )
      ).rows,
    )
    const conVideo = (row?.r.promotions ?? []).filter((p) => p.video_url)
    expect(conVideo.map((p) => p.video_url)).toEqual([video(TENANT_A.organizationId, storeA)])
  })
})
