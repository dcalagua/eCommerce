// @vitest-environment node
import type { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestDatabase, expectFailure, TENANT_A } from './harness'

/**
 * Visitas, metas y comisiones, contra Postgres real (fases 12 y 13).
 *
 * Cierran el dominio `sales`. Lo que se demuestra es lo que evita un pleito:
 *
 *  · **La agenda y el hecho son columnas distintas.** Machacar `planned_at` con
 *    `checked_in_at` borraría la única prueba de que la visita no se hizo
 *    cuando tocaba.
 *  · **Una liquidación pagada no se toca.** Es dinero de terceros: recalcular
 *    una cerrada porque cambió una regla es como se pierde la confianza de una
 *    fuerza de ventas. Se corrige con un ajuste del periodo siguiente.
 *  · **La meta dice en qué se mide.** «Vendiste 1.200» no significa nada si no
 *    se sabe si son soles o cajas.
 */

let db: PGlite

async function svc(query: string, params: unknown[] = []) {
  const result = await db.query<Record<string, unknown>>(query, params)
  return result.rows
}

async function vendedor(code: string): Promise<string> {
  const rows = await svc(
    `insert into public.sales_reps (organization_id, company_id, employee_code, full_name)
     values ($1, $2, $3, $3) returning id`,
    [TENANT_A.organizationId, TENANT_A.companyId, code],
  )
  return rows[0]?.id as string
}

async function cliente(code: string): Promise<string> {
  const rows = await svc(
    `insert into public.customers (organization_id, company_id, kind, code, name)
     values ($1, $2, 'company', $3, $3) returning id`,
    [TENANT_A.organizationId, TENANT_A.companyId, code],
  )
  return rows[0]?.id as string
}

function visita(
  rep: string,
  customer: string,
  extras: { outcome?: string; checkIn?: boolean; checkOutAntes?: boolean } = {},
) {
  return svc(
    `insert into public.sales_visits
       (organization_id, company_id, sales_rep_id, customer_id, planned_at,
        checked_in_at, checked_out_at, outcome)
     values ($1, $2, $3, $4, now(),
             case when $5 then now() else null end,
             case when $6 then now() - interval '2 hours' else null end,
             $7)`,
    [
      TENANT_A.organizationId,
      TENANT_A.companyId,
      rep,
      customer,
      extras.checkIn ?? false,
      extras.checkOutAntes ?? false,
      extras.outcome ?? 'planned',
    ],
  )
}

async function liquidacion(rep: string, estado = 'draft'): Promise<string> {
  const rows = await svc(
    `insert into public.commission_statements
       (organization_id, company_id, sales_rep_id, period_start, period_end,
        currency, base_amount, rate, amount, status)
     values ($1, $2, $3, current_date - 30, current_date, 'PEN', 10000, 0.03, 300, $4)
     returning id`,
    [TENANT_A.organizationId, TENANT_A.companyId, rep, estado],
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
}, 240_000)

afterAll(async () => {
  await db?.close()
})

describe('la visita', () => {
  it('la agenda y el hecho son columnas distintas', async () => {
    const rep = await vendedor('V-1')
    const c = await cliente('CLI-V1')
    await visita(rep, c, { checkIn: true, outcome: 'completed' })

    const rows = await svc(
      `select planned_at is not null as agenda, checked_in_at is not null as hecho
         from public.sales_visits where sales_rep_id = $1`,
      [rep],
    )
    // Las dos, a la vez: es lo que permite decir «se visitó, pero tarde».
    expect(rows[0]).toEqual({ agenda: true, hecho: true })
  })

  it('una visita «completada» tuvo que empezar', async () => {
    const rep = await vendedor('V-2')
    const c = await cliente('CLI-V2')

    // Sin entrada no hay visita: hay un parte escrito desde la oficina.
    const message = await expectFailure(() => visita(rep, c, { outcome: 'completed' }))
    expect(message).toMatch(/completed_needs_checkin|violates check/i)
  })

  it('no se sale antes de entrar', async () => {
    const rep = await vendedor('V-3')
    const c = await cliente('CLI-V3')

    const message = await expectFailure(() =>
      visita(rep, c, { checkIn: true, checkOutAntes: true }),
    )
    expect(message).toMatch(/out_after_in|violates check/i)
  })
})

describe('la meta', () => {
  it('un importe sin moneda no es un importe', async () => {
    const rep = await vendedor('V-M1')
    const message = await expectFailure(() =>
      svc(
        `insert into public.sales_goals
           (organization_id, company_id, sales_rep_id, metric, period_start, period_end, target_value)
         values ($1, $2, $3, 'amount', current_date, current_date + 30, 50000)`,
        [TENANT_A.organizationId, TENANT_A.companyId, rep],
      ),
    )
    expect(message).toMatch(/currency_when_amount|violates check/i)
  })

  it('una meta en unidades NO lleva moneda', async () => {
    const rep = await vendedor('V-M2')
    const message = await expectFailure(() =>
      svc(
        `insert into public.sales_goals
           (organization_id, company_id, sales_rep_id, metric, currency,
            period_start, period_end, target_value)
         values ($1, $2, $3, 'units', 'PEN', current_date, current_date + 30, 500)`,
        [TENANT_A.organizationId, TENANT_A.companyId, rep],
      ),
    )
    expect(message).toMatch(/currency_when_amount|violates check/i)
  })

  it('la meta tiene UN dueño: vendedor o territorio, nunca los dos', async () => {
    const rep = await vendedor('V-M3')
    const terr = await svc(
      `insert into public.sales_territories (organization_id, company_id, code, name)
       values ($1, $2, 'NORTE', 'Norte') returning id`,
      [TENANT_A.organizationId, TENANT_A.companyId],
    )

    // Con los dos, la misma venta cumpliría dos metas y pagaría dos comisiones.
    const message = await expectFailure(() =>
      svc(
        `insert into public.sales_goals
           (organization_id, company_id, sales_rep_id, territory_id, metric, currency,
            period_start, period_end, target_value)
         values ($1, $2, $3, $4, 'amount', 'PEN', current_date, current_date + 30, 1000)`,
        [TENANT_A.organizationId, TENANT_A.companyId, rep, terr[0]?.id],
      ),
    )
    expect(message).toMatch(/one_owner|violates check/i)
  })
})

describe('la comisión', () => {
  it('un vendedor tiene UNA liquidación por periodo', async () => {
    const rep = await vendedor('V-C1')
    await liquidacion(rep)

    // Dos serían dos pagos por el mismo trabajo.
    const message = await expectFailure(() => liquidacion(rep))
    expect(message).toMatch(/commission_statements_unique|duplicate key/i)
  })

  it('una liquidación PAGADA no se recalcula', async () => {
    const rep = await vendedor('V-C2')
    const l = await liquidacion(rep, 'paid')

    const message = await expectFailure(() =>
      svc(`update public.commission_statements set amount = 999 where id = $1`, [l]),
    )
    expect(message).toMatch(/LIQUIDACION_PAGADA/)
  })

  it('una liquidación PAGADA tampoco se borra', async () => {
    const rep = await vendedor('V-C3')
    const l = await liquidacion(rep, 'paid')

    const message = await expectFailure(() =>
      svc(`delete from public.commission_statements where id = $1`, [l]),
    )
    expect(message).toMatch(/LIQUIDACION_PAGADA/)
  })

  it('una aprobada se puede pagar, pero no reabrir', async () => {
    const rep = await vendedor('V-C4')
    const l = await liquidacion(rep, 'approved')

    const aBorrador = await expectFailure(() =>
      svc(`update public.commission_statements set status = 'draft' where id = $1`, [l]),
    )
    expect(aBorrador).toMatch(/LIQUIDACION_APROBADA/)

    // Pagarla sí: es el paso siguiente y el único que queda.
    await svc(
      `update public.commission_statements set status = 'paid', paid_at = now() where id = $1`,
      [l],
    )
    const rows = await svc(`select status from public.commission_statements where id = $1`, [l])
    expect(rows[0]?.status).toBe('paid')
  })

  it('los importes de una aprobada ya no se tocan', async () => {
    const rep = await vendedor('V-C5')
    const l = await liquidacion(rep, 'approved')

    const message = await expectFailure(() =>
      svc(`update public.commission_statements set base_amount = 1 where id = $1`, [l]),
    )
    expect(message).toMatch(/LIQUIDACION_APROBADA/)
  })

  it('la tasa vive entre cero y uno: es una tasa, no un porcentaje', async () => {
    const rep = await vendedor('V-C6')
    const message = await expectFailure(() =>
      svc(
        `insert into public.commission_rules
           (organization_id, company_id, code, name, rate)
         values ($1, $2, 'MALA', 'Mala', 3)`,
        [TENANT_A.organizationId, TENANT_A.companyId],
      ),
    )
    expect(message).toMatch(/rate_range|violates check/i)
    expect(rep).toBeTruthy()
  })
})
