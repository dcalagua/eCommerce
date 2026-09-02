// @vitest-environment node
import type { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { asRole, claimsFor, createTestDatabase, expectFailure, TENANT_A, TENANT_B } from './harness'

/**
 * Fuerza de ventas, contra Postgres real (recorrido B2B · fase 02).
 *
 * Tres propiedades que hay que demostrar ANTES de que nada cuelgue de esta
 * tabla, porque las tres rompen cosas que no se descubren al guardarlas:
 *
 *  1. **El aislamiento por tenant.** Es lo primero que se comprueba en toda
 *     tabla nueva del repositorio, y aquí importa el doble: una fuga aquí no
 *     enseña un producto ajeno, enseña la nómina comercial y la cartera de
 *     clientes de un competidor.
 *  2. **La jerarquía sin ciclos.** «A reporta a B que reporta a A» no molesta
 *     al guardarlo: cuelga el día que alguien recorre la jerarquía para pagar
 *     comisiones.
 *  3. **Un solo titular por cliente.** Si dos vendedores son primarios del
 *     mismo cliente, «el vendedor de esta cuenta» tiene dos respuestas y la
 *     comisión se paga dos veces.
 *
 * Y una cuarta que es la razón de ser del rol: **el vendedor ve SU cartera**,
 * no la base de clientes del tenant.
 */

let db: PGlite

const REP_A = '0a000000-0000-4000-8000-00000000f001'
const REP_JEFE = '0a000000-0000-4000-8000-00000000f002'
const USUARIO_REP = '0a000000-0000-4000-8000-00000000e001'

async function svc(query: string, params: unknown[] = []) {
  const result = await db.query<Record<string, unknown>>(query, params)
  return result.rows
}

async function crearVendedor(
  tenant: typeof TENANT_A,
  code: string,
  extras: { id?: string; manager?: string | null; userId?: string | null } = {},
): Promise<string> {
  const rows = await svc(
    `insert into public.sales_reps
       (id, organization_id, company_id, employee_code, full_name, manager_id, user_id)
     values (coalesce($1, gen_random_uuid()), $2, $3, $4, $5, $6, $7)
     returning id`,
    [
      extras.id ?? null,
      tenant.organizationId,
      tenant.companyId,
      code,
      `Vendedor ${code}`,
      extras.manager ?? null,
      extras.userId ?? null,
    ],
  )
  return rows[0]?.id as string
}

async function crearCliente(tenant: typeof TENANT_A, code: string): Promise<string> {
  const rows = await svc(
    `insert into public.customers (organization_id, company_id, kind, code, name)
     values ($1, $2, 'company', $3, $3) returning id`,
    [tenant.organizationId, tenant.companyId, code],
  )
  return rows[0]?.id as string
}

beforeAll(async () => {
  db = await createTestDatabase()

  for (const tenant of [TENANT_A, TENANT_B]) {
    await svc(
      `select public.bootstrap_tenant($1, $2, $3, $4, $5, $6, $7, 'Tienda', 'PEN')`,
      [
        tenant.organizationId,
        tenant.companyId,
        tenant.slug,
        tenant.slug,
        tenant.adminEmail,
        tenant.ownerId,
        tenant.storeSlug,
      ],
    )
    // La capacidad que las policies de escritura exigen.
    await svc(
      `select public.sync_platform_context($1, $2, true, $3, 'hub'::public.entitlement_source, null)`,
      [tenant.organizationId, tenant.companyId, ['ecommerce.sales.force']],
    )
  }
}, 240_000)

afterAll(async () => {
  await db?.close()
})

describe('aislamiento entre tenants', () => {
  it('el admin de A no ve ni un vendedor de B', async () => {
    await crearVendedor(TENANT_A, 'A-001', { id: REP_A });
    await crearVendedor(TENANT_B, 'B-001')

    const vistos = await asRole(db, 'authenticated', claimsFor(TENANT_A), () =>
      svc(`select employee_code from public.sales_reps order by employee_code`),
    )

    expect(vistos.map((r) => r.employee_code)).toEqual(['A-001'])
  })

  it('un JWT que declara el `org_id` ajeno tampoco lo consigue', async () => {
    // El tenant NO sale del cuerpo ni del token que el cliente escribe: sale de
    // lo que la RLS puede comprobar contra la membresía real.
    const forjado = claimsFor(TENANT_A, { org_id: TENANT_B.organizationId })
    const vistos = await asRole(db, 'authenticated', forjado, () =>
      svc(`select employee_code from public.sales_reps`),
    )

    expect(vistos).toEqual([])
  })

  it('escribir en el tenant ajeno se rechaza', async () => {
    const message = await expectFailure(() =>
      asRole(db, 'authenticated', claimsFor(TENANT_A), () =>
        svc(
          `insert into public.sales_reps (organization_id, company_id, employee_code, full_name)
           values ($1, $2, 'INTRUSO', 'Intruso')`,
          [TENANT_B.organizationId, TENANT_B.companyId],
        ),
      ),
    )
    expect(message).toMatch(/row-level security|policy/i)
  })

  it('el comprador anónimo ni siquiera puede mirar: esto no es catálogo', async () => {
    // Ni una fila filtrada por policy: `anon` no tiene el GRANT de tabla, así
    // que la consulta muere antes de llegar a la RLS. Es la barrera de fuera,
    // y es la que se quiere aquí — la nómina comercial no es contenido público.
    const message = await expectFailure(() =>
      asRole(db, 'anon', null, () => svc(`select employee_code from public.sales_reps`)),
    )
    expect(message).toMatch(/permission denied/i)
  })
})

describe('la jerarquía no admite ciclos', () => {
  it('un vendedor no se reporta a sí mismo', async () => {
    const uno = await crearVendedor(TENANT_A, 'A-010')

    const message = await expectFailure(() =>
      svc(`update public.sales_reps set manager_id = id where id = $1`, [uno]),
    )
    expect(message).toMatch(/VENDEDOR_CICLO/)
  })

  it('tampoco cerrando el círculo por la cadena', async () => {
    const jefe = await crearVendedor(TENANT_A, 'A-020', { id: REP_JEFE })
    const medio = await crearVendedor(TENANT_A, 'A-021', { manager: jefe })
    const abajo = await crearVendedor(TENANT_A, 'A-022', { manager: medio })

    // jefe -> abajo cerraria: jefe > medio > abajo > jefe.
    const message = await expectFailure(() =>
      svc(`update public.sales_reps set manager_id = $2 where id = $1`, [jefe, abajo]),
    )
    expect(message).toMatch(/VENDEDOR_CICLO/)
  })

  it('una jefatura normal sí entra', async () => {
    const jefe = await crearVendedor(TENANT_A, 'A-030')
    const suyo = await crearVendedor(TENANT_A, 'A-031', { manager: jefe })

    const rows = await svc(`select manager_id from public.sales_reps where id = $1`, [suyo])
    expect(rows[0]?.manager_id).toBe(jefe)
  })

  it('la jefatura no puede cruzar el tenant', async () => {
    const deB = await crearVendedor(TENANT_B, 'B-050')

    // La FK es COMPUESTA y arrastra el tenant: una FK simple sobre el uuid
    // habría dejado colgar este vendedor de un jefe de otra empresa.
    const message = await expectFailure(() =>
      crearVendedor(TENANT_A, 'A-050', { manager: deB }),
    )
    expect(message).toMatch(/foreign key|violates/i)
  })
})

describe('la cartera', () => {
  it('un cliente tiene UN solo titular', async () => {
    const cliente = await crearCliente(TENANT_A, 'CLI-1')
    const uno = await crearVendedor(TENANT_A, 'A-100')
    const otro = await crearVendedor(TENANT_A, 'A-101')

    const asignar = (rep: string, primary: boolean) =>
      svc(
        `insert into public.sales_rep_customers
           (organization_id, company_id, sales_rep_id, customer_id, is_primary)
         values ($1, $2, $3, $4, $5)`,
        [TENANT_A.organizationId, TENANT_A.companyId, rep, cliente, primary],
      )

    await asignar(uno, true)
    // Un segundo titular para el mismo cliente pagaría la comisión dos veces.
    const message = await expectFailure(() => asignar(otro, true))
    expect(message).toMatch(/sales_rep_customers_primary_unique|duplicate key/i)

    // Como apoyo, sin ser titular, sí entra.
    await expect(asignar(otro, false)).resolves.toBeDefined()
  })

  it('el vendedor ve SU cartera y no la base de clientes del tenant', async () => {
    const mio = await crearCliente(TENANT_A, 'CLI-MIO')
    const ajeno = await crearCliente(TENANT_A, 'CLI-AJENO')
    const yo = await crearVendedor(TENANT_A, 'A-200', { userId: USUARIO_REP })
    const otro = await crearVendedor(TENANT_A, 'A-201')

    for (const [rep, cliente] of [
      [yo, mio],
      [otro, ajeno],
    ]) {
      await svc(
        `insert into public.sales_rep_customers
           (organization_id, company_id, sales_rep_id, customer_id)
         values ($1, $2, $3, $4)`,
        [TENANT_A.organizationId, TENANT_A.companyId, rep, cliente],
      )
    }

    // El vendedor es PERSONAL del tenant: tiene su membresía, con rol
    // `sales_rep`. Sin ella `ebim.can_access` dice que no, y hace bien: un
    // token no concede acceso por declararlo, lo concede la membresía real.
    await svc(
      `insert into public.tenant_members
         (organization_id, company_id, user_id, email, role, status)
       values ($1, $2, $3, 'preventista@tenant-a.com', 'sales_rep', 'active')`,
      [TENANT_A.organizationId, TENANT_A.companyId, USUARIO_REP],
    )

    // El vendedor entra con SU `sub` y rol `sales_rep`: no es admin del tenant.
    const suyo = claimsFor(TENANT_A, {
      sub: USUARIO_REP,
      email: 'preventista@tenant-a.com',
      companies: [{ id: TENANT_A.companyId, role: 'sales_rep' }],
    })

    const vistos = await asRole(db, 'authenticated', suyo, () =>
      svc(`select customer_id from public.sales_rep_customers`),
    )

    expect(vistos.map((r) => r.customer_id)).toEqual([mio])
  })
})
