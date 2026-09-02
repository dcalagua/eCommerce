// @vitest-environment node
import type { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { asRole, claimsFor, createTestDatabase, expectFailure, TENANT_A, TENANT_B } from './harness'

/**
 * Crédito y cobranza, contra Postgres real (recorrido B2B · fase 04).
 *
 * Lo que se demuestra es lo que hace que las cifras de cobranza sean de fiar:
 *
 *  · **El saldo lo mantiene la BASE.** Si lo escribiera quien inserta la
 *    aplicación existiría la ruta que se olvida —una carga masiva, una
 *    corrección a mano— y el saldo dejaría de ser cierto sin que nada fallara.
 *  · **Nunca se cobra más de lo que se debe.** Sin esa barandilla el saldo se
 *    vuelve negativo, y a partir de ahí la antigüedad, el crédito disponible y
 *    el bloqueo por mora mienten los tres a la vez.
 *  · **La aplicación es N:M.** Un cobro paga varias facturas y una factura se
 *    cobra en partes: modelarlo con una FK simple obliga a partir recibos, que
 *    es justo lo que descuadra una conciliación.
 */

let db: PGlite

async function svc(query: string, params: unknown[] = []) {
  const result = await db.query<Record<string, unknown>>(query, params)
  return result.rows
}

async function cliente(tenant: typeof TENANT_A, code: string): Promise<string> {
  const rows = await svc(
    `insert into public.customers (organization_id, company_id, kind, code, name)
     values ($1, $2, 'company', $3, $3) returning id`,
    [tenant.organizationId, tenant.companyId, code],
  )
  return rows[0]?.id as string
}

async function documento(
  tenant: typeof TENANT_A,
  customer: string,
  numero: string,
  importe: string,
  vence = '2026-12-31',
): Promise<string> {
  const rows = await svc(
    `insert into public.ar_documents
       (organization_id, company_id, customer_id, document_number, currency, amount, due_at)
     values ($1, $2, $3, $4, 'PEN', $5, $6) returning id`,
    [tenant.organizationId, tenant.companyId, customer, numero, importe, vence],
  )
  return rows[0]?.id as string
}

async function recibo(
  tenant: typeof TENANT_A,
  customer: string,
  numero: string,
  importe: string,
): Promise<string> {
  const rows = await svc(
    `insert into public.ar_receipts
       (organization_id, company_id, customer_id, receipt_number, currency, amount)
     values ($1, $2, $3, $4, 'PEN', $5) returning id`,
    [tenant.organizationId, tenant.companyId, customer, numero, importe],
  )
  return rows[0]?.id as string
}

function aplicar(tenant: typeof TENANT_A, rec: string, doc: string, importe: string) {
  return svc(
    `insert into public.ar_applications
       (organization_id, company_id, receipt_id, document_id, amount)
     values ($1, $2, $3, $4, $5)`,
    [tenant.organizationId, tenant.companyId, rec, doc, importe],
  )
}

async function saldo(doc: string): Promise<string> {
  const rows = await svc(`select balance::text as v from public.ar_documents where id = $1`, [doc])
  return rows[0]?.v as string
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
      [tenant.organizationId, tenant.companyId, ['ecommerce.credit.management']],
    )
  }
}, 240_000)

afterAll(async () => {
  await db?.close()
})

describe('el saldo lo mantiene la base', () => {
  it('un documento nace debiendo su importe entero', async () => {
    const c = await cliente(TENANT_A, 'CLI-S1')
    const doc = await documento(TENANT_A, c, 'F-001', '1000.00')

    expect(await saldo(doc)).toBe('1000.00')
  })

  it('cada cobro lo baja, y el último lo deja en cero', async () => {
    const c = await cliente(TENANT_A, 'CLI-S2')
    const doc = await documento(TENANT_A, c, 'F-002', '1000.00')

    await aplicar(TENANT_A, await recibo(TENANT_A, c, 'R-001', '400.00'), doc, '400.00')
    expect(await saldo(doc)).toBe('600.00')

    await aplicar(TENANT_A, await recibo(TENANT_A, c, 'R-002', '600.00'), doc, '600.00')
    expect(await saldo(doc)).toBe('0.00')
  })

  it('deshacer una aplicación devuelve el saldo', async () => {
    const c = await cliente(TENANT_A, 'CLI-S3')
    const doc = await documento(TENANT_A, c, 'F-003', '500.00')
    const rec = await recibo(TENANT_A, c, 'R-003', '500.00')

    await aplicar(TENANT_A, rec, doc, '500.00')
    expect(await saldo(doc)).toBe('0.00')

    // Un cobro anulado no puede dejar la factura pagada.
    await svc(`delete from public.ar_applications where receipt_id = $1`, [rec])
    expect(await saldo(doc)).toBe('500.00')
  })

  it('no se cobra más de lo que se debe', async () => {
    const c = await cliente(TENANT_A, 'CLI-S4')
    const doc = await documento(TENANT_A, c, 'F-004', '100.00')
    const rec = await recibo(TENANT_A, c, 'R-004', '150.00')

    const message = await expectFailure(() => aplicar(TENANT_A, rec, doc, '150.00'))
    expect(message).toMatch(/COBRO_EXCEDE_DEUDA/)
    // Y el saldo no se movió: la transacción entera se deshizo.
    expect(await saldo(doc)).toBe('100.00')
  })

  it('un recibo aplica UNA vez a cada documento', async () => {
    const c = await cliente(TENANT_A, 'CLI-S5')
    const doc = await documento(TENANT_A, c, 'F-005', '900.00')
    const rec = await recibo(TENANT_A, c, 'R-005', '900.00')

    await aplicar(TENANT_A, rec, doc, '300.00')
    // Dos filas para el mismo par serían dos verdades sobre cuánto pagó ese
    // cobro de esa factura.
    const message = await expectFailure(() => aplicar(TENANT_A, rec, doc, '300.00'))
    expect(message).toMatch(/ar_applications_unique|duplicate key/i)
  })

  it('un cobro paga VARIAS facturas: la relación es N:M', async () => {
    const c = await cliente(TENANT_A, 'CLI-S6')
    const uno = await documento(TENANT_A, c, 'F-006', '200.00')
    const dos = await documento(TENANT_A, c, 'F-007', '300.00')
    const rec = await recibo(TENANT_A, c, 'R-006', '500.00')

    await aplicar(TENANT_A, rec, uno, '200.00')
    await aplicar(TENANT_A, rec, dos, '300.00')

    expect(await saldo(uno)).toBe('0.00')
    expect(await saldo(dos)).toBe('0.00')
  })
})

describe('la antigüedad de saldos', () => {
  it('reparte lo vencido por tramos, y lo corriente aparte', async () => {
    const c = await cliente(TENANT_A, 'CLI-A1')
    // Vencido hace 10, hace 45 y todavía por vencer.
    await svc(
      `insert into public.ar_documents
         (organization_id, company_id, customer_id, document_number, currency, amount, issued_at, due_at)
       values
         ($1, $2, $3, 'V-010', 'PEN', 100.00, current_date - 40, current_date - 10),
         ($1, $2, $3, 'V-045', 'PEN', 200.00, current_date - 80, current_date - 45),
         ($1, $2, $3, 'V-FUT', 'PEN', 300.00, current_date, current_date + 20)`,
      [TENANT_A.organizationId, TENANT_A.companyId, c],
    )

    const rows = await svc(`select ebim.customer_aging($1) as v`, [c])
    const aging = rows[0]?.v as Record<string, string>

    expect(aging.total).toBe('600.00')
    expect(aging.current).toBe('300.00')
    expect(aging.due_1_30).toBe('100.00')
    expect(aging.due_31_60).toBe('200.00')
    // «Vencido» es la suma de los tramos, y es la cifra que decide un bloqueo.
    expect(aging.overdue).toBe('300.00')
  })

  it('un documento ya cobrado no cuenta como deuda', async () => {
    const c = await cliente(TENANT_A, 'CLI-A2')
    const doc = await documento(TENANT_A, c, 'F-100', '400.00')
    await aplicar(TENANT_A, await recibo(TENANT_A, c, 'R-100', '400.00'), doc, '400.00')

    const rows = await svc(`select ebim.customer_aging($1) as v`, [c])
    expect((rows[0]?.v as Record<string, string>).total).toBe('0.00')
  })
})

describe('aislamiento y alcance', () => {
  it('el admin de A no ve la deuda de B', async () => {
    const deB = await cliente(TENANT_B, 'CLI-B')
    await documento(TENANT_B, deB, 'B-001', '999.00')

    const vistos = await asRole(db, 'authenticated', claimsFor(TENANT_A), () =>
      svc(`select document_number from public.ar_documents where document_number = 'B-001'`),
    )
    expect(vistos).toEqual([])
  })

  it('el rol `viewer` no ve la cartera de deuda', async () => {
    // El rol sale de la MEMBRESIA, no del token: por eso hace falta un miembro
    // de verdad y no basta con declarar `viewer` en los claims. Es la propiedad
    // que impide que alguien se ascienda escribiendo su propio JWT.
    const mirón = '0a000000-0000-4000-8000-00000000d001'
    await svc(
      `insert into public.tenant_members
         (organization_id, company_id, user_id, email, role, status)
       values ($1, $2, $3, 'miron@tenant-a.com', 'viewer', 'active')`,
      [TENANT_A.organizationId, TENANT_A.companyId, mirón],
    )

    const soloLectura = claimsFor(TENANT_A, {
      sub: mirón,
      email: 'miron@tenant-a.com',
      companies: [{ id: TENANT_A.companyId, role: 'viewer' }],
    })
    const vistos = await asRole(db, 'authenticated', soloLectura, () =>
      svc(`select document_number from public.ar_documents`),
    )
    // Consultar el catálogo no es lo mismo que ver cuánto debe cada cliente.
    expect(vistos).toEqual([])
  })

  it('un `viewer` que se declara `admin` en su token tampoco la ve', async () => {
    const mirón = '0a000000-0000-4000-8000-00000000d001'
    const mentira = claimsFor(TENANT_A, {
      sub: mirón,
      email: 'miron@tenant-a.com',
      companies: [{ id: TENANT_A.companyId, role: 'admin' }],
    })
    const vistos = await asRole(db, 'authenticated', mentira, () =>
      svc(`select document_number from public.ar_documents`),
    )
    expect(vistos).toEqual([])
  })

  it('el anónimo no puede ni mirar', async () => {
    const message = await expectFailure(() =>
      asRole(db, 'anon', null, () => svc(`select document_number from public.ar_documents`)),
    )
    expect(message).toMatch(/permission denied/i)
  })
})
