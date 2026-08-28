// @vitest-environment node
/**
 * P11-SaaS · White-label por tokens, contra Postgres REAL.
 *
 * Cuatro propiedades, y las cuatro son de la BASE y no de la pantalla:
 *
 *  · **la lista es cerrada** — la tipografía, el radio y la densidad solo
 *    admiten los valores que la app sabe pintar; una fuente por URL no entra;
 *  · **lo premium exige el addon** — y lo que NO es premium (acento, logo,
 *    favicon, radio, densidad) se edita sin él, porque el lockup de la suite
 *    sigue puesto;
 *  · **retirar el addon apaga su efecto** — por CUALQUIER camino que cambie los
 *    entitlements, no solo por la sincronización del hub;
 *  · **lo publicable es una lista, no todo** — `anon` lee los tokens de
 *    presentación y nunca la identidad de correo ni el token del dominio.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { TENANT_A, TENANT_B, asRole, claimsFor, createTestDatabase, expectFailure } from './harness.ts'

type Row = Record<string, unknown>

let db: PGlite

const STORE_A_SLUG = 'tienda-a'
const STORE_B_SLUG = 'tienda-b'
const WHITE_LABEL = 'ecommerce.content.white_label'

let storeA: string
let storeB: string

async function sql(query: string, params: unknown[] = []): Promise<Row[]> {
  return (await db.query<Row>(query, params)).rows
}

async function svc(query: string, params: unknown[] = []): Promise<Row[]> {
  return asRole(db, 'service_role', null, () => sql(query, params))
}

async function asAdmin(query: string, params: unknown[] = []): Promise<Row[]> {
  return asRole(db, 'authenticated', claimsFor(TENANT_A), () => sql(query, params))
}

async function entitle(codes: string[], tenant = TENANT_A): Promise<void> {
  await svc(
    `select public.sync_platform_context($1, $2, true, $3, 'hub'::public.entitlement_source, null)`,
    [tenant.organizationId, tenant.companyId, codes],
  )
}

async function settings(store = storeA): Promise<Row> {
  const rows = await svc(`select * from public.store_settings where store_id = $1`, [store])
  return rows[0] ?? {}
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

  const stores = await svc(`select id, slug from public.stores order by slug`)
  storeA = String(stores.find((s) => s.slug === STORE_A_SLUG)?.id)
  storeB = String(stores.find((s) => s.slug === STORE_B_SLUG)?.id)
}, 180_000)

afterAll(async () => {
  await db?.close()
})

describe('la lista de tokens es CERRADA', () => {
  it.each([
    ['tipografia', `font_family = 'comic-sans'`],
    ['tipografia por URL', `font_family = 'https://fonts.evil.test/x.css'`],
    ['radio', `ui_radius = 'squircle'`],
    ['densidad', `ui_density = 'gigante'`],
    ['estado de dominio', `custom_domain_status = 'casi'`],
    ['token de dominio', `custom_domain_token = 'no-es-hex'`],
    ['correo de respuesta sin arroba', `email_reply_to = 'sin-arroba'`],
  ])('rechaza una %s fuera de la lista', async (_label, assignment) => {
    const message = await expectFailure(() =>
      svc(`update public.store_settings set ${assignment} where store_id = $1`, [storeA]),
    )
    expect(message).toMatch(/violates check/i)
  })

  it('acepta los cinco tokens de tipografia que la app sabe pintar', async () => {
    for (const font of ['dm-sans', 'system', 'grotesk', 'serif', 'mono']) {
      await svc(`update public.store_settings set font_family = $1 where store_id = $2`, [
        font, storeA,
      ])
    }
    await svc(`update public.store_settings set font_family = null where store_id = $1`, [storeA])
    expect((await settings()).font_family).toBeNull()
  })

  it('un dominio `verified` sin fecha es imposible: la fecha ES la prueba', async () => {
    const message = await expectFailure(() =>
      svc(
        `update public.store_settings set custom_domain_status = 'verified' where store_id = $1`,
        [storeA],
      ),
    )
    expect(message).toMatch(/store_settings_domain_verified_at|violates check/i)
  })

  it('cierra la deuda de P07: el favicon tambien pasa por el CHECK de asset', async () => {
    const message = await expectFailure(() =>
      svc(
        `update public.store_settings set favicon_url = 'javascript:alert(1)' where store_id = $1`,
        [storeA],
      ),
    )
    expect(message).toMatch(/store_settings_favicon|violates check/i)

    // Y una ruta del bucket de OTRO tenant tampoco entra.
    const ajena = await expectFailure(() =>
      svc(
        `update public.store_settings set favicon_url = $1 where store_id = $2`,
        [`${TENANT_B.organizationId}/${storeB}/branding/favicon.png`, storeA],
      ),
    )
    expect(ajena).toMatch(/store_settings_favicon_ref|violates check/i)
  })
})

describe('lo premium exige el addon; lo que no lo es, no', () => {
  it('sin `content.white_label`, la tematizacion se edita igual', async () => {
    await entitle([])

    await asAdmin(
      `update public.store_settings
          set accent_color = '#123456', ui_radius = 'round', ui_density = 'compacta',
              business_display_name = 'Comercial Norte S.A.C.'
        where store_id = $1`,
      [storeA],
    )

    const row = await settings()
    expect(row.accent_color).toBe('#123456')
    expect(row.ui_radius).toBe('round')
    expect(row.business_display_name).toBe('Comercial Norte S.A.C.')
  })

  it.each([
    ['la marca blanca', `white_label = true`],
    ['la tipografia', `font_family = 'serif'`],
    ['el remitente del correo', `email_from_name = 'Comercial Norte'`],
    ['el correo de respuesta', `email_reply_to = 'hola@norte.test'`],
  ])('sin el addon, %s se rechaza', async (_label, assignment) => {
    await entitle([])
    const message = await asAdmin(
      `update public.store_settings set ${assignment} where store_id = $1 returning store_id`,
      [storeA],
    ).catch((error: Error) => error.message)

    // La policy lo rechaza con un error de RLS. Si algún día devolviera cero
    // filas en vez de fallar, este test también lo cazaría: el valor no cambia.
    expect(String(message)).toMatch(/row-level security|violates/i)
  })

  it('con el addon, lo premium se guarda', async () => {
    await entitle([WHITE_LABEL])
    await asAdmin(
      `update public.store_settings
          set white_label = true, font_family = 'serif', email_from_name = 'Comercial Norte',
              email_reply_to = 'hola@norte.test'
        where store_id = $1`,
      [storeA],
    )

    const row = await settings()
    expect(row.white_label).toBe(true)
    expect(row.font_family).toBe('serif')
    expect(row.email_reply_to).toBe('hola@norte.test')
  })
})

describe('retirar el addon APAGA su efecto', () => {
  it('quitar `content.white_label` deja los tokens premium en nulo y conserva el resto', async () => {
    await entitle([WHITE_LABEL])
    await asAdmin(
      `update public.store_settings
          set white_label = true, font_family = 'mono', email_from_name = 'Norte',
              email_reply_to = 'hola@norte.test', accent_color = '#abcdef',
              ui_radius = 'sharp', business_display_name = 'Norte S.A.C.'
        where store_id = $1`,
      [storeA],
    )

    await entitle([])

    const row = await settings()
    expect(row.white_label).toBe(false)
    expect(row.font_family).toBeNull()
    expect(row.email_from_name).toBeNull()
    expect(row.email_reply_to).toBeNull()
    expect(row.custom_domain_status).toBe('none')
    // Lo que NO es premium sobrevive: dar de baja un módulo no puede parecer
    // una pérdida de configuración.
    expect(row.accent_color).toBe('#abcdef')
    expect(row.ui_radius).toBe('sharp')
    expect(row.business_display_name).toBe('Norte S.A.C.')
  })

  /**
   * P02-SaaS resolvió esto dentro de `sync_platform_context`, que es UN camino.
   * El trigger de P11 cubre todos: aquí se apaga el entitlement con un UPDATE
   * directo, sin pasar por la función, y el efecto se apaga igual.
   */
  it('tambien por un camino que NO es la sincronizacion del hub', async () => {
    await entitle([WHITE_LABEL])
    await asAdmin(`update public.store_settings set white_label = true where store_id = $1`, [
      storeA,
    ])
    expect((await settings()).white_label).toBe(true)

    await svc(
      `update public.tenant_entitlements set is_active = false
        where organization_id = $1 and entitlement_code = $2`,
      [TENANT_A.organizationId, WHITE_LABEL],
    )

    expect((await settings()).white_label).toBe(false)
  })

  it('y al BORRAR la fila del entitlement', async () => {
    await entitle([WHITE_LABEL])
    await asAdmin(`update public.store_settings set font_family = 'grotesk' where store_id = $1`, [
      storeA,
    ])
    expect((await settings()).font_family).toBe('grotesk')

    await svc(
      `delete from public.tenant_entitlements
        where organization_id = $1 and entitlement_code = $2`,
      [TENANT_A.organizationId, WHITE_LABEL],
    )

    expect((await settings()).font_family).toBeNull()
  })

  it('apagar el addon de A no toca la tienda de B', async () => {
    await entitle([WHITE_LABEL])
    await entitle([WHITE_LABEL], TENANT_B)
    await svc(`update public.store_settings set font_family = 'serif' where store_id = $1`, [storeB])

    await entitle([])

    expect((await settings(storeB)).font_family).toBe('serif')
    await entitle([], TENANT_B)
  })
})

describe('el dominio propio: metadato con su secreto', () => {
  it('el token lo genera el SERVIDOR y deja el estado en `pending`', async () => {
    await entitle([WHITE_LABEL])
    await svc(`update public.stores set domain = 'tienda.test' where id = $1`, [storeA])

    const rows = await asAdmin(`select public.store_domain_claim($1) as r`, [storeA])
    const claim = rows[0]?.r as Record<string, unknown>
    expect(claim.record).toBe('TXT')
    expect(claim.host).toBe('_ebim-verify.tienda.test')
    expect(String(claim.value)).toMatch(/^[0-9a-f]{32}$/)

    const row = await settings()
    expect(row.custom_domain_status).toBe('pending')
    expect(row.custom_domain_verified_at).toBeNull()
  })

  it('sin dominio declarado no hay nada que reclamar', async () => {
    await entitle([WHITE_LABEL])
    await svc(`update public.stores set domain = null where id = $1`, [storeA])
    const message = await asRole(db, 'authenticated', claimsFor(TENANT_A), () =>
      expectFailure(() => sql(`select public.store_domain_claim($1) as r`, [storeA])),
    )
    expect(message).toMatch(/DOMINIO_NO_DECLARADO/)
  })

  it('sin el addon, reclamar el dominio responde MODULO_NO_CONTRATADO', async () => {
    await entitle([])
    await svc(`update public.stores set domain = 'tienda.test' where id = $1`, [storeA])
    const message = await asRole(db, 'authenticated', claimsFor(TENANT_A), () =>
      expectFailure(() => sql(`select public.store_domain_claim($1) as r`, [storeA])),
    )
    expect(message).toMatch(/MODULO_NO_CONTRATADO/)
  })

  it('la tienda de otro tenant responde SIN_PERMISO', async () => {
    const message = await asRole(db, 'authenticated', claimsFor(TENANT_A), () =>
      expectFailure(() => sql(`select public.store_domain_claim($1) as r`, [storeB])),
    )
    expect(message).toMatch(/SIN_PERMISO/)
  })

  it('el estado del dominio NO tiene GRANT de escritura para `authenticated`', async () => {
    const rows = await sql(`
      select column_name
      from information_schema.column_privileges
      where table_schema = 'public' and table_name = 'store_settings'
        and grantee = 'authenticated' and privilege_type = 'UPDATE'
        and column_name in
          ('custom_domain_status', 'custom_domain_verified_at', 'custom_domain_token')
    `)
    expect(rows).toEqual([])
  })
})

describe('lo publicable es una lista, no todo', () => {
  it('`anon` lee los tokens de presentacion', async () => {
    await entitle([WHITE_LABEL])
    await svc(
      `update public.store_settings
          set font_family = 'serif', ui_radius = 'round', ui_density = 'compacta',
              business_display_name = 'Norte S.A.C.'
        where store_id = $1`,
      [storeA],
    )

    const rows = await asRole(db, 'anon', null, () =>
      sql(
        `select font_family, ui_radius, ui_density, business_display_name
           from public.public_stores where slug = $1`,
        [STORE_A_SLUG],
      ),
    )
    expect(rows[0]).toMatchObject({
      font_family: 'serif',
      ui_radius: 'round',
      ui_density: 'compacta',
      business_display_name: 'Norte S.A.C.',
    })
  })

  it.each(['email_from_name', 'email_reply_to', 'custom_domain_token', 'custom_domain_status'])(
    '`anon` no puede leer %s',
    async (column) => {
      const message = await asRole(db, 'anon', null, () =>
        expectFailure(() => sql(`select ${column} from public.store_settings`)),
      )
      expect(message).toMatch(/permission denied/i)
    },
  )
})
