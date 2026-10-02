// @vitest-environment node
/**
 * Libro de Reclamaciones y datos de ayuda de la tienda · contra Postgres REAL.
 *
 * Lo que no puede fallar:
 *
 *  · **aislamiento entre tenants** — el comercio B no ve los reclamos de A, y
 *    nadie los escribe por fuera de `submit_complaint`;
 *  · **anon no lee** datos personales de reclamantes, aunque SÍ puede reclamar;
 *  · **el tenant sale de la tienda del slug**, nunca de lo que mande el cliente:
 *    los campos fuera de la hoja se rechazan;
 *  · **correlativo por tienda y año**, sin huecos ni empates;
 *  · **responder exige rol** y deja rastro;
 *  · los campos de ayuda (`social_links`, WhatsApp...) validan en la base y son
 *    públicos por `public_stores`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { TENANT_A, TENANT_B, asRole, claimsFor, createTestDatabase, expectFailure, type JwtClaims } from './harness.ts'

type Row = Record<string, unknown>

const LECTOR = '0e300000-0000-4000-8000-0000000f0001'
const PEDIDOS = '0e300000-0000-4000-8000-0000000f0002'

let db: PGlite
let storeA = ''

async function svc<T = Row>(query: string, params: unknown[] = []): Promise<T[]> {
  return asRole(db, 'service_role', null, async () => (await db.query<T>(query, params)).rows)
}
async function as<T = Row>(claims: JwtClaims, query: string, params: unknown[] = []): Promise<T[]> {
  return asRole(db, 'authenticated', claims, async () => (await db.query<T>(query, params)).rows)
}
async function anon<T = Row>(query: string, params: unknown[] = []): Promise<T[]> {
  return asRole(db, 'anon', null, async () => (await db.query<T>(query, params)).rows)
}

/** Exige que `run` falle Y que el mensaje diga lo esperado. */
async function falla(run: () => Promise<unknown>, motivo: RegExp): Promise<void> {
  expect(await expectFailure(run)).toMatch(motivo)
}

function staff(tenant: typeof TENANT_A, sub: string, role: string): JwtClaims {
  return claimsFor(tenant, { sub, email: `${sub}@t.com`, companies: [{ id: tenant.companyId, role }] })
}
const ownerA = () => staff(TENANT_A, TENANT_A.ownerId, 'owner')
const ownerB = () => staff(TENANT_B, TENANT_B.ownerId, 'owner')

const HOJA = {
  kind: 'reclamo',
  consumer_name: 'Ana Consumidora',
  doc_type: 'dni',
  doc_number: '45678912',
  consumer_email: 'Ana@Correo.pe',
  consumer_phone: '+51 999 111 222',
  item_kind: 'producto',
  item_description: 'Mochila urbana 20 L negra',
  amount: 189.9,
  detail: 'La cremallera principal llegó rota y no cierra.',
  request: 'Cambio por una unidad nueva.',
}

async function reclamar(hoja: unknown, slug = TENANT_A.storeSlug): Promise<Row> {
  const [row] = await anon<{ r: Row }>(`select public.submit_complaint($1, $2::jsonb) as r`, [
    slug,
    JSON.stringify(hoja),
  ])
  return row?.r as Row
}

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
  for (const [user, role] of [
    [LECTOR, 'viewer'],
    [PEDIDOS, 'orders'],
  ] as const) {
    await svc(
      `insert into public.tenant_members (organization_id, company_id, user_id, email, role)
       values ($1, $2, $3, $4, $5)`,
      [TENANT_A.organizationId, TENANT_A.companyId, user, `${user}@tenant-a.com`, role],
    )
  }
})

afterAll(async () => {
  await db?.close()
})

describe('el consumidor reclama', () => {
  it('sin sesión registra la hoja con correlativo por tienda y año', async () => {
    const primero = await reclamar(HOJA)
    const segundo = await reclamar({ ...HOJA, kind: 'queja', detail: 'Me atendieron de mala manera por chat.' })
    const año = new Date().getFullYear()
    expect(primero.code).toBe(`R-${año}-000001`)
    expect(segundo.code).toBe(`R-${año}-000002`)
    expect(segundo.kind).toBe('queja')
  })

  it('cada tienda lleva su propio correlativo', async () => {
    const otra = await reclamar(HOJA, TENANT_B.storeSlug)
    expect(String(otra.code)).toMatch(/-000001$/)
  })

  it('el tenant sale de la tienda: los campos fuera de la hoja se rechazan', async () => {
    await falla(() => reclamar({ ...HOJA, organization_id: TENANT_B.organizationId }), /CAMPO_NO_PERMITIDO/)
    await falla(() => reclamar({ ...HOJA, status: 'answered' }), /CAMPO_NO_PERMITIDO/)
    await falla(() => reclamar({ ...HOJA, response: 'ya está' }), /CAMPO_NO_PERMITIDO/)
  })

  it('valida en el servidor', async () => {
    await falla(() => reclamar({ ...HOJA, kind: 'sugerencia' }), /CAMPO_INVALIDO/)
    await falla(() => reclamar({ ...HOJA, detail: 'corto' }), /CAMPO_INVALIDO/)
    await falla(() => reclamar({ ...HOJA, consumer_email: undefined }), /CAMPO_REQUERIDO/)
    await falla(() => reclamar({ ...HOJA, consumer_email: 'sin-arroba' }), /complaints_email_fmt/)
    // Menor de edad sin apoderado: no.
    await falla(() => reclamar({ ...HOJA, is_minor: true }), /CAMPO_REQUERIDO/)
  })

  it('no se reclama a una tienda inexistente', async () => {
    await falla(() => reclamar(HOJA, 'no-existe'), /.+/)
  })
})

describe('quién lee y quién escribe', () => {
  it('anon no lee la tabla ni escribe directo', async () => {
    await falla(() => anon(`select * from public.complaints`), /permission denied/)
    await falla(() => anon(`insert into public.complaints (organization_id) values ($1)`, [TENANT_A.organizationId]),
      /permission denied/, )
  })

  it('el comercio A ve los suyos y el B no ve los de A', async () => {
    const deA = await as(ownerA(), `select code, consumer_email from public.complaints`)
    expect(deA.length).toBe(2)
    expect(deA[0]?.consumer_email).toBe('ana@correo.pe')
    const deB = await as(ownerB(), `select store_id from public.complaints`)
    expect(deB.every((r) => r.store_id !== storeA)).toBe(true)
    expect(deB.length).toBe(1)
  })

  it('nadie con sesión escribe directo en la tabla', async () => {
    await falla(() => as(ownerA(), `update public.complaints set status = 'answered'`),
      /permission denied/, )
  })
})

describe('el comercio responde', () => {
  async function primerReclamo(): Promise<string> {
    const [row] = await svc<{ id: string }>(
      `select id from public.complaints where store_id = $1 order by number limit 1`,
      [storeA],
    )
    return String(row?.id)
  }

  it('un lector no puede responder', async () => {
    const id = await primerReclamo()
    await falla(() => as(staff(TENANT_A, LECTOR, 'viewer'), `select public.respond_complaint($1::uuid, 'in_progress')`, [
        id,
      ]),
      /SIN_PERMISO/, )
  })

  it('el comercio B no encuentra el reclamo de A', async () => {
    const id = await primerReclamo()
    await falla(() => as(ownerB(), `select public.respond_complaint($1::uuid, 'in_progress')`, [id]),
      /RECLAMO_NO_ENCONTRADO/, )
  })

  it('responder exige texto, queda registrado y no se reescribe', async () => {
    const id = await primerReclamo()
    const pedidos = staff(TENANT_A, PEDIDOS, 'orders')
    await falla(() => as(pedidos, `select public.respond_complaint($1::uuid, 'answered', 'ok')`, [id]), /RESPUESTA_REQUERIDA/)
    await as(pedidos, `select public.respond_complaint($1::uuid, 'in_progress')`, [id])
    const [r] = await as<{ r: Row }>(
      pedidos,
      `select public.respond_complaint($1::uuid, 'answered', $2) as r`,
      [id, 'Le enviamos una mochila nueva sin costo esta semana.'],
    )
    expect(r?.r.status).toBe('answered')
    await falla(() => as(pedidos, `select public.respond_complaint($1::uuid, 'answered', $2)`, [id, 'Otra respuesta distinta.']),
      /YA_RESPONDIDO/, )
    const huella = await svc(`select 1 from public.audit_log where entity_id = $1 and action = 'complaint.answered'`, [id])
    expect(huella.length).toBe(1)
  })
})

describe('datos de ayuda de la tienda', () => {
  it('se publican en public_stores', async () => {
    await svc(
      `update public.store_settings
          set legal_name = 'PRO BAGS PERU SAC', tax_id = '20601234567', whatsapp_phone = '+51 970 510 698',
              help_note = 'Ventas corporativas', business_hours = E'Lunes a viernes: 9 a 18\\nSábados: 9 a 13',
              social_links = '[{"network":"instagram","url":"https://instagram.com/porta"}]'::jsonb
        where store_id = $1`,
      [storeA],
    )
    const [s] = await anon(`select legal_name, tax_id, whatsapp_phone, business_hours, social_links
                              from public.public_stores where slug = $1`, [TENANT_A.storeSlug])
    expect(s?.legal_name).toBe('PRO BAGS PERU SAC')
    expect(String(s?.business_hours)).toContain('\n')
    expect(s?.social_links).toEqual([{ network: 'instagram', url: 'https://instagram.com/porta' }])
  })

  it('las redes son de lista cerrada, https y sin repetir', async () => {
    const poner = (links: unknown) =>
      svc(`update public.store_settings set social_links = $1::jsonb where store_id = $2`, [JSON.stringify(links), storeA])
    await falla(() => poner([{ network: 'myspace', url: 'https://myspace.com/x' }]), /store_settings_social_links/)
    await falla(() => poner([{ network: 'facebook', url: 'javascript:alert(1)' }]), /store_settings_social_links/)
    await falla(() => poner([
        { network: 'tiktok', url: 'https://tiktok.com/@a' },
        { network: 'tiktok', url: 'https://tiktok.com/@b' },
      ]),
      /store_settings_social_links/, )
  })

  it('WhatsApp y RUC tienen formato', async () => {
    await falla(() => svc(`update public.store_settings set whatsapp_phone = 'llámame' where store_id = $1`, [storeA]), /whatsapp/)
    await falla(() => svc(`update public.store_settings set tax_id = 'RUC 123 456' where store_id = $1`, [storeA]), /tax_id/)
  })
})
