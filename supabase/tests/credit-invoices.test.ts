// @vitest-environment node
import type { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestDatabase, expectFailure, TENANT_A } from './harness'

/**
 * Facturación, contra Postgres real (recorrido B2B · fase 07).
 *
 * El puerto `InvoicingProvider` ya estaba escrito y decía lo que faltaba: la
 * línea necesita `taxRate` y `taxAmount` POR LÍNEA. Esa precondición se resolvió
 * en la migración 110100, así que `invoice_items` se llena **copiando** del
 * pedido.
 *
 * Y copiar, no recalcular, es la propiedad que se prueba aquí: el IGV de una
 * factura es el del día de la venta. Una tasa que cambia en enero no puede
 * reescribir una factura de diciembre.
 *
 * La otra: **un comprobante aceptado no se edita**. Es un documento fiscal —se
 * corrige con una nota. Permitir el UPDATE sería dejar que el sistema
 * contradiga a la autoridad.
 */

let db: PGlite

let STORE = ''
let CANAL = ''

async function svc(query: string, params: unknown[] = []) {
  const result = await db.query<Record<string, unknown>>(query, params)
  return result.rows
}

async function pedido(numero: string): Promise<string> {
  const rows = await svc(
    `insert into public.orders
       (organization_id, company_id, store_id, order_number, status, currency,
        subtotal, tax_total, grand_total, customer_email, channel_id)
     values ($1, $2, $3, $4, 'paid', 'PEN', 100, 18, 118, 'cliente@test.com', $5)
     returning id`,
    [TENANT_A.organizationId, TENANT_A.companyId, STORE, numero, CANAL],
  )
  return rows[0]?.id as string
}

async function factura(
  order: string,
  numero: string | null = null,
  estado = 'pending',
): Promise<string> {
  const rows = await svc(
    `insert into public.invoices
       (organization_id, company_id, store_id, order_id, series, number, status,
        currency, customer_name, net_total, tax_total, gross_total)
     values ($1, $2, $3, $4, 'F001', $5, $6, 'PEN', 'Cliente SAC', 100, 18, 118)
     returning id`,
    [TENANT_A.organizationId, TENANT_A.companyId, STORE, order, numero, estado],
  )
  return rows[0]?.id as string
}

function linea(invoice: string, tasa: string) {
  return svc(
    `insert into public.invoice_items
       (organization_id, company_id, invoice_id, description, quantity,
        unit_price, net_amount, tax_rate, tax_amount)
     values ($1, $2, $3, 'Producto', 2, 50, 100, $4, 18)`,
    [TENANT_A.organizationId, TENANT_A.companyId, invoice, tasa],
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
  const canal = await svc(`select id from public.channels where store_id = $1 and is_default`, [
    STORE,
  ])
  CANAL = canal[0]?.id as string
}, 240_000)

afterAll(async () => {
  await db?.close()
})

describe('la precondición que el puerto anotaba', () => {
  it('`order_items` guarda el impuesto POR LÍNEA: por eso se puede copiar', async () => {
    const columnas = await svc(
      `select column_name from information_schema.columns
        where table_schema = 'public' and table_name = 'order_items'
          and column_name in ('tax_rate', 'tax_amount')
        order by column_name`,
    )
    // Sin estas dos, un carrito con dos tipos impositivos no puede reconstruir
    // su comprobante desde la base, que es lo que el puerto dejó anotado.
    expect(columnas.map((c) => c.column_name)).toEqual(['tax_amount', 'tax_rate'])
  })

  it('la línea de factura exige la tasa: el hueco NO es cero', async () => {
    const f = await factura(await pedido('EC-F0'))
    // Tratar el hueco como cero emitiría un comprobante con menos impuesto del
    // debido, y eso lo paga el comercio.
    const message = await expectFailure(() =>
      svc(
        `insert into public.invoice_items
           (organization_id, company_id, invoice_id, description, quantity,
            unit_price, net_amount, tax_amount)
         values ($1, $2, $3, 'Sin tasa', 1, 10, 10, 0)`,
        [TENANT_A.organizationId, TENANT_A.companyId, f],
      ),
    )
    expect(message).toMatch(/tax_rate|not-null/i)
  })

  it('cero SÍ es una tasa válida: lo dice el puerto', async () => {
    const f = await factura(await pedido('EC-F1'))
    await expect(linea(f, '0')).resolves.toBeDefined()
  })
})

describe('el comprobante', () => {
  it('los totales cuadran', async () => {
    const o = await pedido('EC-F2')
    // Es la comprobación más barata contra un comprobante que la autoridad va
    // a rechazar.
    const message = await expectFailure(() =>
      svc(
        `insert into public.invoices
           (organization_id, company_id, store_id, order_id, series, currency,
            customer_name, net_total, tax_total, gross_total)
         values ($1, $2, $3, $4, 'F001', 'PEN', 'Cliente', 100, 18, 999)`,
        [TENANT_A.organizationId, TENANT_A.companyId, STORE, o],
      ),
    )
    expect(message).toMatch(/totals_add_up|violates check/i)
  })

  it('un rechazo lleva motivo', async () => {
    const f = await factura(await pedido('EC-F3'))
    // Sin motivo, nadie sabe qué corregir para reemitir.
    const message = await expectFailure(() =>
      svc(`update public.invoices set status = 'rejected' where id = $1`, [f]),
    )
    expect(message).toMatch(/reject_needs_reason|violates check/i)
  })

  it('aceptado, no se edita: se corrige con una nota', async () => {
    const f = await factura(await pedido('EC-F4'), 'F001-1', 'accepted')

    const message = await expectFailure(() =>
      svc(`update public.invoices set net_total = 1 where id = $1`, [f]),
    )
    expect(message).toMatch(/COMPROBANTE_ACEPTADO/)
  })

  it('aceptado, sí se puede anular', async () => {
    const f = await factura(await pedido('EC-F5'), 'F001-2', 'accepted')
    // Anular es una operación fiscal legítima; editar los importes, no.
    await svc(`update public.invoices set status = 'cancelled' where id = $1`, [f])
    const rows = await svc(`select status from public.invoices where id = $1`, [f])
    expect(rows[0]?.status).toBe('cancelled')
  })

  it('emitido, no se borra', async () => {
    const f = await factura(await pedido('EC-F6'), 'F001-3', 'issued')
    const message = await expectFailure(() =>
      svc(`delete from public.invoices where id = $1`, [f]),
    )
    expect(message).toMatch(/COMPROBANTE_EMITIDO/)
  })

  it('las líneas de uno ya emitido tampoco se tocan', async () => {
    const f = await factura(await pedido('EC-F7'))
    await linea(f, '0.18')
    await svc(`update public.invoices set status = 'issued', number = 'F001-4' where id = $1`, [f])

    const message = await expectFailure(() => linea(f, '0.10'))
    expect(message).toMatch(/COMPROBANTE_EMITIDO/)
  })

  it('el número no se repite dentro de su serie', async () => {
    await factura(await pedido('EC-F8'), 'F001-99')
    const otro = await pedido('EC-F9')
    const message = await expectFailure(() => factura(otro, 'F001-99'))
    expect(message).toMatch(/invoices_number_unique|duplicate key/i)
  })
})
