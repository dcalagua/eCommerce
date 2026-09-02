// @vitest-environment node
import type { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestDatabase, expectFailure, TENANT_A } from './harness'

/**
 * Pedido B2B avanzado, contra Postgres real (recorrido B2B · fase 05).
 *
 * Esta fase construye poco a propósito. `orders.advanced` estaba declarada y
 * deliberadamente vacía, y dejó puestos los enganches: el motor de aprobación
 * (`purchase_approval`, `order_approval_decide`), la idempotencia por fila
 * (`checkout_intents`) y la referencia externa (`order_external_refs`). Nada de
 * eso se reescribe.
 *
 * Lo que faltaba de verdad es la programación con estado, y de ella se prueban
 * las dos propiedades que evitan un desastre silencioso:
 *
 *  · **La plantilla no lleva precio.** Un precio guardado en una plantilla es
 *    un precio de hace seis meses esperando a que alguien lo cobre.
 *  · **Avanzar no dispara la cola atrasada.** Si el planificador estuvo caído
 *    una semana, avanzar desde la fecha prevista soltaría siete pedidos de
 *    golpe al volver. Se pierde una entrega; no se duplican seis.
 */

let db: PGlite

let STORE = ''

async function svc(query: string, params: unknown[] = []) {
  const result = await db.query<Record<string, unknown>>(query, params)
  return result.rows
}

async function producto(sku: string): Promise<string> {
  const rows = await svc(
    `insert into public.products
       (organization_id, company_id, store_id, sku, slug, name, price, currency, stock, status)
     values ($1, $2, $3, $4, lower($4), $4, '10.00', 'PEN', 10, 'draft') returning id`,
    [TENANT_A.organizationId, TENANT_A.companyId, STORE, sku],
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

async function plantilla(code: string, customer: string): Promise<string> {
  const rows = await svc(
    `insert into public.order_templates
       (organization_id, company_id, store_id, customer_id, code, name)
     values ($1, $2, $3, $4, $5, $5) returning id`,
    [TENANT_A.organizationId, TENANT_A.companyId, STORE, customer, code],
  )
  return rows[0]?.id as string
}

function renglon(template: string, product: string, qty = '5') {
  return svc(
    `insert into public.order_template_items
       (organization_id, company_id, template_id, product_id, quantity)
     values ($1, $2, $3, $4, $5)`,
    [TENANT_A.organizationId, TENANT_A.companyId, template, product, qty],
  )
}

/**
 * Las fechas van como DIAS RELATIVOS a hoy y las calcula Postgres.
 *
 * Pasar la cadena `'current_date'` como parametro no funciona —seria un literal
 * de texto, no la funcion— y fijar una fecha absoluta haria que la prueba
 * empezara a fallar sola el dia que esa fecha quede en el pasado.
 */
async function programar(
  template: string,
  intervalo: number,
  proximaEnDias: number,
  finEnDias: number | null = null,
): Promise<string> {
  const rows = await svc(
    `insert into public.order_schedules
       (organization_id, company_id, store_id, template_id, interval_days, next_run_on, ends_on)
     values ($1, $2, $3, $4, $5,
             current_date + $6::int,
             case when $7::int is null then null else current_date + $7::int end)
     returning id`,
    [
      TENANT_A.organizationId,
      TENANT_A.companyId,
      STORE,
      template,
      intervalo,
      proximaEnDias,
      finEnDias,
    ],
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

describe('la plantilla', () => {
  it('guarda QUÉ y CUÁNTO, y ninguna columna de precio', async () => {
    const columnas = await svc(
      `select column_name from information_schema.columns
        where table_schema = 'public' and table_name = 'order_template_items'`,
    )
    const nombres = columnas.map((c) => c.column_name as string)

    // Un precio guardado aquí es un precio de hace seis meses esperando a que
    // alguien lo cobre. Lo resuelve el motor el día que el pedido nace.
    expect(nombres).toContain('quantity')
    expect(nombres.filter((n) => n.includes('price'))).toEqual([])
  })

  it('el mismo producto no entra dos veces', async () => {
    const c = await cliente('CLI-T1')
    const t = await plantilla('PLA-1', c)
    const p = await producto('SKU-T1')

    await renglon(t, p)
    const message = await expectFailure(() => renglon(t, p))
    expect(message).toMatch(/order_template_items_unique|duplicate key/i)
  })

  it('una cantidad de cero no es una línea', async () => {
    const c = await cliente('CLI-T2')
    const t = await plantilla('PLA-2', c)
    const p = await producto('SKU-T2')

    const message = await expectFailure(() => renglon(t, p, '0'))
    expect(message).toMatch(/quantity_sign|violates check/i)
  })
})

describe('la programación', () => {
  it('avanza el intervalo desde hoy', async () => {
    const c = await cliente('CLI-P1')
    const t = await plantilla('PLA-P1', c)
    const s = await programar(t, 7, 0)

    const rows = await svc(`select ebim.order_schedule_advance($1)::text as v`, [s])
    const esperado = await svc(`select (current_date + 7)::text as v`)
    expect(rows[0]?.v).toBe(esperado[0]?.v)
  })

  it('un planificador caído una semana NO dispara la cola atrasada', async () => {
    const c = await cliente('CLI-P2')
    const t = await plantilla('PLA-P2', c)
    // Tocaba hace 30 días y nadie la ejecutó.
    const s = await programar(t, 7, -30)

    await svc(`select ebim.order_schedule_advance($1)`, [s])
    const rows = await svc(`select next_run_on::text as v from public.order_schedules where id = $1`, [s])
    const esperado = await svc(`select (current_date + 7)::text as v`)

    // Desde HOY, no desde lo previsto: se pierde una entrega, no se duplican
    // cuatro. Avanzar desde `next_run_on` habría dejado la fecha en el pasado y
    // la siguiente pasada volvería a disparar.
    expect(rows[0]?.v).toBe(esperado[0]?.v)
  })

  it('al pasar de la fecha de fin se da por terminada', async () => {
    const c = await cliente('CLI-P3')
    const t = await plantilla('PLA-P3', c)
    const s = await programar(t, 30, 0, 10)

    await svc(`select ebim.order_schedule_advance($1)`, [s])
    const rows = await svc(`select status from public.order_schedules where id = $1`, [s])
    expect(rows[0]?.status).toBe('finished')
  })

  it('una programación pausada no avanza sola', async () => {
    const c = await cliente('CLI-P4')
    const t = await plantilla('PLA-P4', c)
    const s = await programar(t, 7, 0)
    await svc(`update public.order_schedules set status = 'paused' where id = $1`, [s])

    const message = await expectFailure(() =>
      svc(`select ebim.order_schedule_advance($1)`, [s]),
    )
    expect(message).toMatch(/PROGRAMACION_INACTIVA/)
  })

  it('una plantilla tiene UNA programación', async () => {
    const c = await cliente('CLI-P5')
    const t = await plantilla('PLA-P5', c)
    await programar(t, 7, 0)

    // Dos calendarios para la misma plantilla duplicarían el pedido sin que
    // nadie lo pidiera dos veces.
    const message = await expectFailure(() => programar(t, 15, 0))
    expect(message).toMatch(/order_schedules_template_unique|duplicate key/i)
  })
})

describe('lo que esta fase NO reescribió', () => {
  it('el motor de aprobación sigue siendo el que ya existía', async () => {
    const funciones = await svc(
      `select proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and proname in ('purchase_approval', 'order_approval_decide')
        order by proname`,
    )
    // Si esta fase hubiera creado un segundo motor, habría dos sitios
    // decidiendo si un pedido necesita firma, y discreparían.
    expect(funciones.map((f) => f.proname)).toEqual([
      'order_approval_decide',
      'purchase_approval',
    ])
  })

  it('no se creó una tabla de lotes: `order_external_refs` ya lo cubre', async () => {
    const tablas = await svc(
      `select table_name from information_schema.tables
        where table_schema = 'public' and table_name in ('order_batches', 'order_external_refs')`,
    )
    expect(tablas.map((t) => t.table_name)).toEqual(['order_external_refs'])
  })
})
