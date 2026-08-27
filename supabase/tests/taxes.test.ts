// @vitest-environment node
/**
 * Monedas e impuestos configurables (P09), sobre Postgres real.
 *
 * Lo que no puede fallar:
 *  - `currencies` es un catálogo global de SOLO lectura: nadie con sesión puede
 *    escribir en él, y `anon` tampoco;
 *  - las tasas y categorías fiscales de un tenant son invisibles para el otro;
 *  - `set_tax_rate` cierra la vigente y abre la nueva en la misma transacción,
 *    y no deja nunca dos tasas abiertas;
 *  - `set_tax_rate` NO es SECURITY DEFINER: un tenant no puede tocar la tasa de
 *    otro aunque conozca el uuid de su categoría.
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
let categoryA: string
let categoryB: string

async function svc<T = Row>(query: string, params: unknown[] = []): Promise<T[]> {
  return asRole(db, 'service_role', null, async () => {
    const result = await db.query<T>(query, params)
    return result.rows
  })
}

async function asOwner<T = Row>(
  tenant: typeof TENANT_A,
  query: string,
  params: unknown[] = [],
): Promise<T[]> {
  return asRole(db, 'authenticated', claimsFor(tenant), async () => {
    const result = await db.query<T>(query, params)
    return result.rows
  })
}

async function seedCategory(tenant: typeof TENANT_A, code: string): Promise<string> {
  const [row] = await svc(
    `insert into public.tax_categories (organization_id, company_id, code, name)
       values ($1, $2, $3, $3) returning id`,
    [tenant.organizationId, tenant.companyId, code],
  )
  return String(row?.id)
}

beforeAll(async () => {
  db = await createTestDatabase()
  // `bootstrap_tenant` da de alta tenant + owner + tienda de una pieza: mismo
  // camino que usa la aplicacion, no un INSERT a mano que se salte reglas.
  for (const tenant of [TENANT_A, TENANT_B]) {
    await svc(
      `select public.bootstrap_tenant($1, $2, $3, $3, $4, $5, $6, 'Tienda', 'PEN')`,
      [
        tenant.organizationId,
        tenant.companyId,
        tenant.slug,
        tenant.adminEmail,
        tenant.ownerId,
        tenant.storeSlug,
      ],
    )
  }
  categoryA = await seedCategory(TENANT_A, 'iva-general')
  categoryB = await seedCategory(TENANT_B, 'iva-general')
}, 120_000)

afterAll(async () => {
  await db?.close()
})

describe('catalogo de monedas', () => {
  it('trae las monedas activas, BOB incluida', async () => {
    const rows = await asRole(db, 'anon', null, async () => {
      const result = await db.query<Row>(`select code from public.currencies order by code`)
      return result.rows
    })
    const codes = rows.map((r) => String(r.code))
    expect(codes).toContain('BOB')
    expect(codes).toContain('PEN')
  })

  it('CLP no tiene decimales: minor_unit no es 2 para todos', async () => {
    const [clp] = await svc(`select minor_unit from public.currencies where code = 'CLP'`)
    expect(clp?.minor_unit).toBe(0)
  })

  it('nadie con sesion puede escribir en el catalogo global', async () => {
    for (const role of ['anon', 'authenticated'] as const) {
      const message = await expectFailure(() =>
        asRole(db, role, role === 'authenticated' ? claimsFor(TENANT_A) : null, async () => {
          await db.query(
            `insert into public.currencies (code, name, symbol) values ('XXX', 'Falsa', 'X')`,
          )
        }),
      )
      expect(`${role}: ${message}`).toMatch(/permission denied|denied/i)
    }
    const [count] = await svc(`select count(*)::int as n from public.currencies where code = 'XXX'`)
    expect(count?.n).toBe(0)
  })

  it('una moneda que no existe en el catalogo no se puede usar en una tienda', async () => {
    const message = await expectFailure(() =>
      svc(
        `insert into public.stores (organization_id, company_id, slug, name, currency)
           values ($1, $2, 'tienda-moneda-falsa', 'Falsa', 'ZZZ')`,
        [TENANT_A.organizationId, TENANT_A.companyId],
      ),
    )
    expect(message).toMatch(/currency|foreign key|violates/i)
  })
})

describe('aislamiento de categorias y tasas fiscales', () => {
  it('un tenant no ve las categorias fiscales del otro', async () => {
    const rows = await asOwner(TENANT_A, `select id from public.tax_categories`)
    const ids = rows.map((r) => String(r.id))
    expect(ids).toContain(categoryA)
    expect(ids).not.toContain(categoryB)
  })

  it('un tenant no puede cambiar la tasa del otro aunque conozca su uuid', async () => {
    const message = await expectFailure(() =>
      asOwner(TENANT_A, `select public.set_tax_rate($1, 0.9900)`, [categoryB]),
    )
    expect(message).toMatch(/CATEGORIA_NO_DISPONIBLE/)

    // Y la categoría del otro sigue sin tasas: no se escribió nada.
    const [count] = await svc(
      `select count(*)::int as n from public.tax_rates where tax_category_id = $1`,
      [categoryB],
    )
    expect(count?.n).toBe(0)
  })
})

describe('set_tax_rate versiona la tasa', () => {
  it('abre la primera tasa y la deja vigente', async () => {
    await asOwner(TENANT_A, `select public.set_tax_rate($1, 0.1300)`, [categoryA])

    const rows = await svc(
      `select rate::text, valid_to from public.tax_rates where tax_category_id = $1`,
      [categoryA],
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]?.rate).toBe('0.1300')
    expect(rows[0]?.valid_to).toBeNull()
  })

  it('cambiarla cierra la anterior y deja UNA sola abierta', async () => {
    await asOwner(TENANT_A, `select public.set_tax_rate($1, 0.1800)`, [categoryA])

    const all = await svc(
      `select rate::text, valid_to from public.tax_rates
        where tax_category_id = $1 order by valid_from`,
      [categoryA],
    )
    expect(all).toHaveLength(2)

    const open = all.filter((r) => r.valid_to === null)
    expect(open).toHaveLength(1)
    expect(open[0]?.rate).toBe('0.1800')

    // La histórica no se borra: un pedido antiguo tiene que poder recalcularse.
    expect(all[0]?.rate).toBe('0.1300')
    expect(all[0]?.valid_to).not.toBeNull()
  })

  it('rechaza una tasa fuera de rango sin tocar la vigente', async () => {
    for (const bad of ['1.5', '-0.1']) {
      const message = await expectFailure(() =>
        asOwner(TENANT_A, `select public.set_tax_rate($1, $2::numeric)`, [categoryA, bad]),
      )
      expect(`${bad}: ${message}`).toMatch(/TASA_INVALIDA/)
    }

    const open = await svc(
      `select rate::text from public.tax_rates
        where tax_category_id = $1 and valid_to is null`,
      [categoryA],
    )
    expect(open).toHaveLength(1)
    expect(open[0]?.rate).toBe('0.1800')
  })

  it('anon no puede invocarla', async () => {
    const message = await expectFailure(() =>
      asRole(db, 'anon', null, async () => {
        await db.query(`select public.set_tax_rate($1, 0.0000)`, [categoryA])
      }),
    )
    expect(message).toMatch(/permission denied|denied/i)
  })
})
