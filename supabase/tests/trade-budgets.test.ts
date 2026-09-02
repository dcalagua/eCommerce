// @vitest-environment node
import type { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestDatabase, expectFailure, TENANT_A } from './harness'

/**
 * Maestro comercial y presupuesto trade, contra Postgres real (fases 01 y 09).
 *
 * Las dos extienden lo que ya había en vez de crear un dominio paralelo, y eso
 * es lo primero que se comprueba: que las mecánicas trade YA existían en el
 * enum —`volume_tier`, `x_for_y`, `bundle`— y que esta fase no añadió sinónimos
 * que obligaran a mantener dos ramas del motor para lo mismo.
 *
 * Lo que sí faltaba es el tope. Y su cuenta la lleva la base: un contador que
 * escribe la aplicación se desincroniza en cuanto alguien borra un canje a
 * mano, y entonces el presupuesto miente en la dirección peligrosa.
 */

let db: PGlite

let STORE = ''

async function svc(query: string, params: unknown[] = []) {
  const result = await db.query<Record<string, unknown>>(query, params)
  return result.rows
}

async function cliente(code: string): Promise<string> {
  const rows = await svc(
    `insert into public.customers (organization_id, company_id, kind, code, name)
     values ($1, $2, 'company', $3, $3) returning id`,
    [TENANT_A.organizationId, TENANT_A.companyId, code],
  )
  return rows[0]?.id as string
}

async function campania(code: string): Promise<string> {
  const rows = await svc(
    `insert into public.promotions
       (organization_id, company_id, store_id, code, name, kind, status, value_percent, valid_from, priority)
     values ($1, $2, $3, $4, $4, 'percentage', 'active', 10, now(), 1)
     returning id`,
    [TENANT_A.organizationId, TENANT_A.companyId, STORE, code],
  )
  return rows[0]?.id as string
}

async function presupuesto(promo: string, monto: string): Promise<string> {
  const rows = await svc(
    `insert into public.promotion_budgets
       (organization_id, company_id, promotion_id, currency, budget_amount)
     values ($1, $2, $3, 'PEN', $4) returning id`,
    [TENANT_A.organizationId, TENANT_A.companyId, promo, monto],
  )
  return rows[0]?.id as string
}

beforeAll(async () => {
  db = await createTestDatabase()
  await svc(`select public.bootstrap_tenant($1, $2, $3, $4, $5, $6, $7, 'Tienda', 'PEN')`, [
    TENANT_A.organizationId,
    TENANT_A.companyId,
    TENANT_A.slug,
    TENANT_A.slug,
    TENANT_A.adminEmail,
    TENANT_A.ownerId,
    TENANT_A.storeSlug,
  ])
  const tienda = await svc(`select id from public.stores where organization_id = $1`, [
    TENANT_A.organizationId,
  ])
  STORE = tienda[0]?.id as string
}, 240_000)

afterAll(async () => {
  await db?.close()
})

describe('el maestro comercial extiende `customers`', () => {
  it('el giro es vocabulario del tenant, no un enum', async () => {
    const t = await svc(
      `insert into public.customer_business_types (organization_id, company_id, code, name)
       values ($1, $2, 'bodega', 'Bodega') returning id`,
      [TENANT_A.organizationId, TENANT_A.companyId],
    )
    const c = await cliente('CLI-M1')
    await svc(
      `update public.customers set business_type_id = $2, tier = 'a', visit_frequency = 'weekly'
        where id = $1`,
      [c, t[0]?.id],
    )

    const rows = await svc(
      `select tier::text as tier, visit_frequency::text as freq from public.customers where id = $1`,
      [c],
    )
    // Añadir un giro no puede exigir una migración: una distribuidora de
    // farmacia y una de ferretería no comparten lista.
    expect(rows[0]).toEqual({ tier: 'a', freq: 'weekly' })
  })

  it('la coordenada va entera o no va', async () => {
    const c = await cliente('CLI-M2')
    // Media coordenada no ubica nada, y es la clase de dato que alguien acaba
    // pintando en el (0,0) del Golfo de Guinea.
    const message = await expectFailure(() =>
      svc(`update public.customers set geo_lat = -12.05 where id = $1`, [c]),
    )
    expect(message).toMatch(/geo_pair|violates check/i)
  })

  it('y dentro del planeta', async () => {
    const c = await cliente('CLI-M3')
    const message = await expectFailure(() =>
      svc(`update public.customers set geo_lat = 200, geo_lng = 0 where id = $1`, [c]),
    )
    expect(message).toMatch(/geo_range|violates check/i)
  })
})

describe('las mecánicas trade YA existían', () => {
  it('el enum no ganó sinónimos de lo que ya tenía', async () => {
    const rows = await svc(
      `select string_agg(e.enumlabel, ',' order by e.enumsortorder) as v
         from pg_type t join pg_enum e on e.enumtypid = t.oid
        where t.typname = 'promotion_kind'`,
    )
    const valores = String(rows[0]?.v).split(',')

    // `combo` sería `bundle` y `free_goods` sería `x_for_y`: dos valores para
    // la misma mecánica obligan a mantener dos ramas del motor sincronizadas.
    expect(valores).toContain('volume_tier')
    expect(valores).toContain('bundle')
    expect(valores).toContain('x_for_y')
    expect(valores).not.toContain('combo')
    expect(valores).not.toContain('free_goods')
  })
})

describe('el presupuesto', () => {
  it('nace sin consumo', async () => {
    const p = await campania('trade-1')
    const b = await presupuesto(p, '5000.00')

    const rows = await svc(
      `select b.consumed_amount::text as v,
              ebim.promotion_budget_remaining(b.id)::text as queda
         from public.promotion_budgets b where b.id = $1`,
      [b],
    )
    expect(rows[0]?.v).toBe('0.00')
    expect(rows[0]?.queda).toBe('5000.00')
  })

  it('se imputa a un cliente O a un territorio, nunca a los dos', async () => {
    const p = await campania('trade-2')
    const c = await cliente('CLI-B1')
    const t = await svc(
      `insert into public.sales_territories (organization_id, company_id, code, name)
       values ($1, $2, 'SUR', 'Sur') returning id`,
      [TENANT_A.organizationId, TENANT_A.companyId],
    )

    // Con los dos, el mismo canje descontaría de dos bolsas y ninguna cuadraría.
    const message = await expectFailure(() =>
      svc(
        `insert into public.promotion_budgets
           (organization_id, company_id, promotion_id, customer_id, territory_id,
            currency, budget_amount)
         values ($1, $2, $3, $4, $5, 'PEN', 1000)`,
        [TENANT_A.organizationId, TENANT_A.companyId, p, c, t[0]?.id],
      ),
    )
    expect(message).toMatch(/one_target|violates check/i)
  })

  it('un tope de cero no es un tope', async () => {
    const p = await campania('trade-3')
    const message = await expectFailure(() => presupuesto(p, '0'))
    expect(message).toMatch(/amount_sign|violates check/i)
  })

  it('lo que queda nunca es negativo, aunque se pase', async () => {
    const p = await campania('trade-4')
    const b = await presupuesto(p, '100.00')
    // Se fuerza el consumo por encima del tope, que es lo que pasa cuando la
    // campaña se pasa: el presupuesto avisa, no corta la venta.
    await svc(`update public.promotion_budgets set consumed_amount = 250 where id = $1`, [b])

    const rows = await svc(`select ebim.promotion_budget_remaining($1)::text as v`, [b])
    expect(rows[0]?.v).toBe('0.00')
  })
})
