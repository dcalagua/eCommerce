// @vitest-environment node
import type { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { asRole, claimsFor, createTestDatabase, expectFailure, TENANT_A, TENANT_B } from './harness'

/**
 * Territorios y rutas, contra Postgres real (recorrido B2B · fase 03).
 *
 * El territorio comercial es una tabla NUEVA y no `delivery_zones` a propósito:
 * aquella es logística —por dónde pasa el camión— y esta es de quién es la
 * cartera. Atarlas haría que cambiar un recorrido de reparto moviera clientes
 * de dueño, y con ellos las comisiones.
 *
 * Lo que se demuestra: el aislamiento, la jerarquía sin ciclos, y las dos
 * unicidades de la ruta —un cliente una vez, y un orden que de verdad ordena—.
 */

let db: PGlite

const USUARIO_REP = '0a000000-0000-4000-8000-00000000e001'

async function svc(query: string, params: unknown[] = []) {
  const result = await db.query<Record<string, unknown>>(query, params)
  return result.rows
}

async function territorio(
  tenant: typeof TENANT_A,
  code: string,
  parent: string | null = null,
): Promise<string> {
  const rows = await svc(
    `insert into public.sales_territories (organization_id, company_id, code, name, parent_id)
     values ($1, $2, $3, $3, $4) returning id`,
    [tenant.organizationId, tenant.companyId, code, parent],
  )
  return rows[0]?.id as string
}

async function vendedor(tenant: typeof TENANT_A, code: string, userId?: string): Promise<string> {
  const rows = await svc(
    `insert into public.sales_reps (organization_id, company_id, employee_code, full_name, user_id)
     values ($1, $2, $3, $3, $4) returning id`,
    [tenant.organizationId, tenant.companyId, code, userId ?? null],
  )
  return rows[0]?.id as string
}

async function cliente(tenant: typeof TENANT_A, code: string): Promise<string> {
  const rows = await svc(
    `insert into public.customers (organization_id, company_id, kind, code, name)
     values ($1, $2, 'company', $3, $3) returning id`,
    [tenant.organizationId, tenant.companyId, code],
  )
  return rows[0]?.id as string
}

async function ruta(tenant: typeof TENANT_A, rep: string, code: string): Promise<string> {
  const rows = await svc(
    `insert into public.sales_routes (organization_id, company_id, sales_rep_id, code, name, weekday)
     values ($1, $2, $3, $4, $4, 1) returning id`,
    [tenant.organizationId, tenant.companyId, rep, code],
  )
  return rows[0]?.id as string
}

beforeAll(async () => {
  db = await createTestDatabase()
  for (const tenant of [TENANT_A, TENANT_B]) {
    await svc(`select public.bootstrap_tenant($1, $2, $3, $4, $5, $6, $7, 'Tienda', 'PEN')`, [
      tenant.organizationId,
      tenant.companyId,
      tenant.slug,
      tenant.slug,
      tenant.adminEmail,
      tenant.ownerId,
      tenant.storeSlug,
    ])
    await svc(
      `select public.sync_platform_context($1, $2, true, $3, 'hub'::public.entitlement_source, null)`,
      [tenant.organizationId, tenant.companyId, ['ecommerce.sales.territory']],
    )
  }
}, 240_000)

afterAll(async () => {
  await db?.close()
})

describe('la jerarquía territorial', () => {
  it('admite niveles: país, zona y subzona', async () => {
    const pais = await territorio(TENANT_A, 'PE')
    const zona = await territorio(TENANT_A, 'LIMA', pais)
    const sub = await territorio(TENANT_A, 'LIMA-NORTE', zona)

    const rows = await svc(`select parent_id from public.sales_territories where id = $1`, [sub])
    expect(rows[0]?.parent_id).toBe(zona)
  })

  it('no admite ciclos', async () => {
    const arriba = await territorio(TENANT_A, 'C-1')
    const abajo = await territorio(TENANT_A, 'C-2', arriba)

    const message = await expectFailure(() =>
      svc(`update public.sales_territories set parent_id = $2 where id = $1`, [arriba, abajo]),
    )
    expect(message).toMatch(/TERRITORIO_CICLO/)
  })

  it('un territorio no cuelga de otro tenant', async () => {
    const deB = await territorio(TENANT_B, 'B-1')
    const message = await expectFailure(() => territorio(TENANT_A, 'A-X', deB))
    expect(message).toMatch(/foreign key|violates/i)
  })
})

describe('la ruta', () => {
  it('un cliente aparece UNA vez en la ruta', async () => {
    const rep = await vendedor(TENANT_A, 'R-1')
    const r = await ruta(TENANT_A, rep, 'RUTA-1')
    const c = await cliente(TENANT_A, 'CLI-R1')

    const parada = (seq: number) =>
      svc(
        `insert into public.sales_route_stops
           (organization_id, company_id, route_id, customer_id, sequence)
         values ($1, $2, $3, $4, $5)`,
        [TENANT_A.organizationId, TENANT_A.companyId, r, c, seq],
      )

    await parada(1)
    // Dos paradas del mismo cliente inflan «cuántas visitas toca hoy».
    const message = await expectFailure(() => parada(2))
    expect(message).toMatch(/sales_route_stops_customer_unique|duplicate key/i)
  })

  it('el orden de visita es un orden: la posición no se repite', async () => {
    const rep = await vendedor(TENANT_A, 'R-2')
    const r = await ruta(TENANT_A, rep, 'RUTA-2')
    const uno = await cliente(TENANT_A, 'CLI-R2A')
    const otro = await cliente(TENANT_A, 'CLI-R2B')

    const parada = (c: string, seq: number) =>
      svc(
        `insert into public.sales_route_stops
           (organization_id, company_id, route_id, customer_id, sequence)
         values ($1, $2, $3, $4, $5)`,
        [TENANT_A.organizationId, TENANT_A.companyId, r, c, seq],
      )

    await parada(uno, 1)
    // Sin esto, el recorrido del día dependería de cómo Postgres devuelva las filas.
    const message = await expectFailure(() => parada(otro, 1))
    expect(message).toMatch(/sales_route_stops_sequence_unique|duplicate key/i)
  })

  it('el día de la semana es un día de la semana', async () => {
    const rep = await vendedor(TENANT_A, 'R-3')
    const message = await expectFailure(() =>
      svc(
        `insert into public.sales_routes
           (organization_id, company_id, sales_rep_id, code, name, weekday)
         values ($1, $2, $3, 'RUTA-9', 'Ruta 9', 9)`,
        [TENANT_A.organizationId, TENANT_A.companyId, rep],
      ),
    )
    expect(message).toMatch(/weekday_range|violates check/i)
  })
})

describe('aislamiento y alcance', () => {
  it('el admin de A no ve los territorios de B', async () => {
    await territorio(TENANT_B, 'B-SOLO')
    const vistos = await asRole(db, 'authenticated', claimsFor(TENANT_A), () =>
      svc(`select code from public.sales_territories where code = 'B-SOLO'`),
    )
    expect(vistos).toEqual([])
  })

  it('el vendedor ve SU ruta y no la de su compañero', async () => {
    const yo = await vendedor(TENANT_A, 'R-MIO', USUARIO_REP)
    const otro = await vendedor(TENANT_A, 'R-OTRO')
    await ruta(TENANT_A, yo, 'MIA')
    await ruta(TENANT_A, otro, 'AJENA')

    await svc(
      `insert into public.tenant_members
         (organization_id, company_id, user_id, email, role, status)
       values ($1, $2, $3, 'preventista@tenant-a.com', 'sales_rep', 'active')`,
      [TENANT_A.organizationId, TENANT_A.companyId, USUARIO_REP],
    )

    const suyo = claimsFor(TENANT_A, {
      sub: USUARIO_REP,
      email: 'preventista@tenant-a.com',
      companies: [{ id: TENANT_A.companyId, role: 'sales_rep' }],
    })

    const vistas = await asRole(db, 'authenticated', suyo, () =>
      svc(`select code from public.sales_routes order by code`),
    )

    // Por dónde pasa otro preventista no es parte de su trabajo.
    expect(vistas.map((r) => r.code)).toEqual(['MIA'])
  })

  it('el anónimo no puede ni mirar', async () => {
    const message = await expectFailure(() =>
      asRole(db, 'anon', null, () => svc(`select code from public.sales_routes`)),
    )
    expect(message).toMatch(/permission denied/i)
  })
})
