// @vitest-environment node
import type { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestDatabase, expectFailure, TENANT_A } from './harness'

/**
 * Reparto y evidencia de entrega, contra Postgres real (fases 10 y 11).
 *
 * Van juntas porque la evidencia es el cierre de la parada: separarlas dejaría
 * una hoja de ruta que no se puede terminar.
 *
 * Las tres propiedades que importan, y las tres protegen del mismo tipo de
 * daño —una entrega que no se puede reclamar—:
 *
 *  1. **Un despacho va en UNA hoja de ruta.** En dos, el camión sale dos veces
 *     con la misma mercadería y una de las dos entregas no existe.
 *  2. **Un rechazo lleva motivo.** Una entrega fallida sin motivo es una
 *     entrega que nadie puede reclamar ni corregir.
 *  3. **La evidencia no se reescribe.** Una firma que se puede cambiar después
 *     no prueba nada: en una disputa lo único que vale es que el registro sea
 *     de la hora en que se hizo.
 */

let db: PGlite

let STORE = ''
let CANAL = ''

async function svc(query: string, params: unknown[] = []) {
  const result = await db.query<Record<string, unknown>>(query, params)
  return result.rows
}

/** Un despacho de verdad: la parada apunta al `fulfillment` que ya existe. */
async function despacho(numero: string): Promise<string> {
  const pedido = await svc(
    `insert into public.orders
       (organization_id, company_id, store_id, order_number, status, currency,
        subtotal, tax_total, grand_total, customer_email, channel_id)
     values ($1, $2, $3, $4, 'paid', 'PEN', 100, 18, 118, 'cliente@test.com', $5)
     returning id`,
    [TENANT_A.organizationId, TENANT_A.companyId, STORE, numero, CANAL],
  )
  // Las columnas obligatorias de `fulfillments` tal y como las dejo P12: el
  // despacho ya nace con su metodo, su estrategia y su direccion.
  const rows = await svc(
    `insert into public.fulfillments
       (organization_id, company_id, store_id, order_id, sequence, method_code, method_name,
        strategy, currency, shipping_cost, address, state)
     values ($1, $2, $3, $4, 1, 'delivery', 'Reparto', 'local_delivery', 'PEN', 0,
             '{"line1":"Av. Siempre Viva 742"}'::jsonb, 'pending')
     returning id`,
    [TENANT_A.organizationId, TENANT_A.companyId, STORE, pedido[0]?.id],
  )
  return rows[0]?.id as string
}

async function hoja(code: string): Promise<string> {
  const rows = await svc(
    `insert into public.delivery_plans
       (organization_id, company_id, store_id, code, plan_date)
     values ($1, $2, $3, $4, current_date) returning id`,
    [TENANT_A.organizationId, TENANT_A.companyId, STORE, code],
  )
  return rows[0]?.id as string
}

function parada(plan: string, fulfillment: string, seq: number) {
  return svc(
    `insert into public.delivery_plan_stops
       (organization_id, company_id, plan_id, fulfillment_id, sequence)
     values ($1, $2, $3, $4, $5)`,
    [TENANT_A.organizationId, TENANT_A.companyId, plan, fulfillment, seq],
  )
}

function evidencia(fulfillment: string, outcome: string, reason: string | null = null) {
  return svc(
    `insert into public.proof_of_delivery
       (organization_id, company_id, fulfillment_id, outcome, reason, received_by)
     values ($1, $2, $3, $4, $5, 'Quien recibe')`,
    [TENANT_A.organizationId, TENANT_A.companyId, fulfillment, outcome, reason],
  )
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

  // `orders.channel_id` es NOT NULL: el canal publico es el que `bootstrap`
  // dejo creado, y es el mismo por el que entra el comprador de la vitrina.
  const canal = await svc(`select id from public.channels where store_id = $1 and is_default`, [
    STORE,
  ])
  CANAL = canal[0]?.id as string
}, 240_000)

afterAll(async () => {
  await db?.close()
})

describe('la hoja de ruta', () => {
  it('lleva paradas en orden', async () => {
    const plan = await hoja('RUTA-A')
    await parada(plan, await despacho('EC-A-1'), 1)
    await parada(plan, await despacho('EC-A-2'), 2)

    const rows = await svc(
      `select count(*)::int as n from public.delivery_plan_stops where plan_id = $1`,
      [plan],
    )
    expect(rows[0]?.n).toBe(2)
  })

  it('un despacho no viaja en dos hojas', async () => {
    const uno = await hoja('RUTA-B')
    const otra = await hoja('RUTA-C')
    const f = await despacho('EC-B-1')

    await parada(uno, f, 1)
    // En dos hojas, el camión sale dos veces con la misma mercadería y una de
    // las dos entregas no existe.
    const message = await expectFailure(() => parada(otra, f, 1))
    expect(message).toMatch(/delivery_plan_stops_fulfillment_unique|duplicate key/i)
  })

  it('dos paradas no comparten posición', async () => {
    const plan = await hoja('RUTA-D')
    await parada(plan, await despacho('EC-D-1'), 1)

    const otro = await despacho('EC-D-2')
    const message = await expectFailure(() => parada(plan, otro, 1))
    expect(message).toMatch(/delivery_plan_stops_sequence_unique|duplicate key/i)
  })
})

describe('la evidencia de entrega', () => {
  it('una entrega correcta no necesita motivo', async () => {
    const f = await despacho('EC-OK')
    await expect(evidencia(f, 'delivered')).resolves.toBeDefined()
  })

  it('un rechazo SIN motivo se rechaza', async () => {
    const f = await despacho('EC-NO')
    // Una entrega fallida sin motivo es una entrega que nadie puede reclamar
    // ni corregir.
    const message = await expectFailure(() => evidencia(f, 'refused'))
    expect(message).toMatch(/reason_when_failed|violates check/i)
  })

  it('un rechazo con motivo entra', async () => {
    const f = await despacho('EC-NO-2')
    await expect(evidencia(f, 'refused', 'Local cerrado')).resolves.toBeDefined()
  })

  it('no se puede editar después', async () => {
    const f = await despacho('EC-INM')
    await evidencia(f, 'delivered')

    // Una firma que se puede cambiar después no prueba nada.
    const message = await expectFailure(() =>
      svc(`update public.proof_of_delivery set received_by = 'Otro' where fulfillment_id = $1`, [f]),
    )
    expect(message).toMatch(/EVIDENCIA_INMUTABLE/)
  })

  it('tampoco se puede borrar', async () => {
    const f = await despacho('EC-INM-2')
    await evidencia(f, 'delivered')

    const message = await expectFailure(() =>
      svc(`delete from public.proof_of_delivery where fulfillment_id = $1`, [f]),
    )
    expect(message).toMatch(/EVIDENCIA_INMUTABLE/)
  })

  it('la geoposición vive dentro del planeta', async () => {
    const f = await despacho('EC-GEO')
    const message = await expectFailure(() =>
      svc(
        `insert into public.proof_of_delivery
           (organization_id, company_id, fulfillment_id, outcome, geo_lat, geo_lng)
         values ($1, $2, $3, 'delivered', 999, 0)`,
        [TENANT_A.organizationId, TENANT_A.companyId, f],
      ),
    )
    expect(message).toMatch(/geo_range|violates check/i)
  })

  it('la foto guarda la RUTA del bucket, no el binario', async () => {
    const columnas = await svc(
      `select column_name, data_type from information_schema.columns
        where table_schema = 'public' and table_name = 'pod_evidence'`,
    )
    const tipos = Object.fromEntries(columnas.map((c) => [c.column_name, c.data_type]))

    // Mismo patrón que `return_evidence` y que las fotos de producto: una
    // columna binaria aquí convertiría cada copia de seguridad en un problema.
    expect(tipos.storage_path).toBe('text')
    expect(Object.values(tipos)).not.toContain('bytea')
  })
})
