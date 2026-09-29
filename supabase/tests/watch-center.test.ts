// @vitest-environment node
import type { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { asRole, claimsFor, createTestDatabase, expectFailure, TENANT_A, TENANT_B } from './harness'

/**
 * El centro de vigilancia (`public.watch_findings`) sobre Postgres real.
 *
 * Lo que queda fijado:
 *  1. Cada hallazgo sale de SQL: cifra, severidad y umbral son reglas de aquí.
 *  2. Ve lo que ve quien llama: A jamás cuenta pedidos de B, y un módulo sin
 *     contratar no produce avisos.
 *  3. El rol acota: un lector no recibe los avisos de pedidos ni de cobranza.
 *  4. Silenciar guarda la CIFRA: si cambia, el aviso vuelve solo.
 */

let db: PGlite
const storeOf: Record<string, string> = {}
const VIEWER = '0a000000-0000-4000-8000-00000000f301'

interface Item {
  key: string
  module: string
  severity: 'critica' | 'advertencia'
  count: number
  fingerprint: string
  metrics: Record<string, unknown>
  samples: Array<Record<string, unknown>>
  href: string
}
interface Watch {
  generated_at: string
  critical: number
  total: number
  items: Item[]
  dismissed: Item[]
}

async function svc<T = Record<string, unknown>>(query: string, params: unknown[] = []) {
  return (await db.query<T>(query, params)).rows
}

async function watch(claims: ReturnType<typeof claimsFor>, storeId: string | null): Promise<Watch> {
  return asRole(db, 'authenticated', claims, async () => {
    const rows = await svc<{ w: Watch }>(`select public.watch_findings($1) as w`, [storeId])
    return rows[0]!.w
  })
}

const keys = (result: Watch) => result.items.map((item) => item.key)
const find = (result: Watch, key: string) => result.items.find((item) => item.key === key)

async function contratar(tenant: typeof TENANT_A, capability: string) {
  await svc(
    `insert into public.tenant_entitlements
       (organization_id, company_id, entitlement_code, is_active, source)
     values ($1, $2, $3, true, 'hub')
     on conflict (organization_id, company_id, entitlement_code) do update set is_active = true`,
    [tenant.organizationId, tenant.companyId, `ecommerce.${capability}`],
  )
}

async function pedido(
  tenant: typeof TENANT_A,
  numero: string,
  opts: { status?: string; payment?: string; fulfillment?: string; diasAtras?: number; approval?: string } = {},
) {
  await svc(
    `insert into public.orders
       (organization_id, company_id, store_id, channel_id, order_number, status, customer_email,
        currency, subtotal, grand_total, placed_at, approval_status, payment_status, fulfillment_status)
     values ($1, $2, $3, (select c.id from public.channels c where c.store_id = $3 and c.is_default),
             $4, $5, 'comprador@cliente.test', 'PEN', '100.00', '100.00',
             now() - make_interval(days => $6), $7::public.order_approval_status,
             $8::public.payment_status, $9::public.fulfillment_status)`,
    [
      tenant.organizationId,
      tenant.companyId,
      storeOf[tenant.slug],
      numero,
      opts.status ?? 'pending',
      opts.diasAtras ?? 0,
      opts.approval ?? 'not_required',
      opts.payment ?? 'pending',
      opts.fulfillment ?? 'unfulfilled',
    ],
  )
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
    storeOf[tenant.slug] = (
      await svc<{ id: string }>(`select id from public.stores where slug = $1`, [tenant.storeSlug])
    )[0]!.id
  }
  await svc(
    `insert into public.tenant_members (organization_id, company_id, user_id, email, role)
     values ($1, $2, $3, 'lector@tenant-a.com', 'viewer')`,
    [TENANT_A.organizationId, TENANT_A.companyId, VIEWER],
  )

  // A: cuatro pedidos sin cobrar de hace más de tres días y uno esperando
  // aprobación. B: un pedido antiquísimo que A no puede ver.
  for (const [i, dias] of [4, 5, 6, 6].entries()) {
    await pedido(TENANT_A, `A-IMPAGO-${i}`, { diasAtras: dias })
  }
  await pedido(TENANT_A, 'A-APROBAR', { approval: 'pending' })
  await pedido(TENANT_B, 'B-IMPAGO', { diasAtras: 40 })
})

afterAll(async () => {
  await db?.close()
})

beforeEach(async () => {
  await svc(`delete from public.watch_dismissals`)
})

describe('qué vigila', () => {
  it('los pedidos sin cobrar salen con su cifra, su antigüedad y hasta tres ejemplos', async () => {
    const result = await watch(claimsFor(TENANT_A), storeOf[TENANT_A.slug]!)
    const impago = find(result, 'orders.unpaid')
    expect(impago).toMatchObject({
      module: 'orders',
      // Cuatro pedidos y ninguno de más de una semana: todavía no es crítico.
      severity: 'advertencia',
      count: 4,
      fingerprint: '4',
      href: '/app/orders',
    })
    expect(impago?.metrics).toMatchObject({ count: 4, oldest_days: 6 })
    expect(impago?.samples).toHaveLength(3)
    expect(keys(result)).toContain('orders.awaiting_approval')
  })

  it('pasado el umbral el mismo aviso se vuelve crítico', async () => {
    await pedido(TENANT_A, 'A-IMPAGO-X', { diasAtras: 12 })
    const result = await watch(claimsFor(TENANT_A), storeOf[TENANT_A.slug]!)
    expect(find(result, 'orders.unpaid')).toMatchObject({ severity: 'critica', count: 5 })
    expect(result.critical).toBeGreaterThan(0)
    await svc(`delete from public.orders where order_number = 'A-IMPAGO-X'`)
  })

  it('un módulo sin contratar no produce avisos, y contratado sí', async () => {
    const sinModulo = await watch(claimsFor(TENANT_A), storeOf[TENANT_A.slug]!)
    expect(keys(sinModulo)).not.toContain('credit.overdue')

    await contratar(TENANT_A, 'credit.management')
    await svc(
      `insert into public.customers (organization_id, company_id, kind, code, name, email)
       values ($1, $2, 'company', 'C-DEUDOR', 'Deudor', 'deudor@cliente.test')
       on conflict do nothing`,
      [TENANT_A.organizationId, TENANT_A.companyId],
    )
    await svc(
      `insert into public.ar_documents
         (organization_id, company_id, customer_id, document_number, currency, amount, issued_at, due_at)
       values ($1, $2, (select id from public.customers where email = 'deudor@cliente.test'),
               'F-001', 'PEN', 500.00, current_date - 45, current_date - 40)`,
      [TENANT_A.organizationId, TENANT_A.companyId],
    )

    const conModulo = await watch(claimsFor(TENANT_A), storeOf[TENANT_A.slug]!)
    // 40 días de retraso pasan del umbral de 30: crítico.
    expect(find(conModulo, 'credit.overdue')).toMatchObject({ severity: 'critica', module: 'credit' })

    await svc(`delete from public.ar_documents`)
    await svc(`delete from public.tenant_entitlements where entitlement_code = 'ecommerce.credit.management'`)
  })

  it('ninguna cifra de otra sociedad se cuela, y su tienda se rechaza', async () => {
    const result = await watch(claimsFor(TENANT_A), storeOf[TENANT_A.slug]!)
    expect(find(result, 'orders.unpaid')?.count).toBe(4)
    expect(await expectFailure(() => watch(claimsFor(TENANT_A), storeOf[TENANT_B.slug]!))).toContain('SIN_PERMISO')
  })

  it('un lector no recibe los avisos de pedidos', async () => {
    const claims = claimsFor(TENANT_A, { sub: VIEWER, email: 'lector@tenant-a.com' })
    const result = await watch(claims, storeOf[TENANT_A.slug]!)
    expect(keys(result)).not.toContain('orders.unpaid')
  })

  it('anon no vigila nada', async () => {
    const message = await expectFailure(() =>
      asRole(db, 'anon', null, () => svc(`select public.watch_findings(null)`)),
    )
    expect(message).toMatch(/permission denied|SIN_PERMISO/)
  })
})

describe('silenciar', () => {
  async function silenciar(key: string, fingerprint: string) {
    return asRole(db, 'authenticated', claimsFor(TENANT_A), () =>
      svc(`select public.watch_dismiss($1, $2, $3) as r`, [key, fingerprint, storeOf[TENANT_A.slug]]),
    )
  }

  it('descartar lo aparta de la lista, lo cuenta aparte y guarda quién fue', async () => {
    await silenciar('orders.unpaid', '4')
    const result = await watch(claimsFor(TENANT_A), storeOf[TENANT_A.slug]!)
    expect(keys(result)).not.toContain('orders.unpaid')
    expect(result.dismissed.map((item) => item.key)).toContain('orders.unpaid')

    const fila = await svc<{ dismissed_by: string; finding_key: string }>(
      `select dismissed_by, finding_key from public.watch_dismissals`,
    )
    expect(fila[0]).toMatchObject({ finding_key: 'orders.unpaid', dismissed_by: TENANT_A.ownerId })
  })

  /** Silenciar «4 pedidos» no puede silenciar los 5 de mañana. */
  it('si la cifra cambia, el aviso vuelve solo', async () => {
    await silenciar('orders.unpaid', '4')
    await pedido(TENANT_A, 'A-IMPAGO-NUEVO', { diasAtras: 4 })
    const result = await watch(claimsFor(TENANT_A), storeOf[TENANT_A.slug]!)
    expect(find(result, 'orders.unpaid')).toMatchObject({ count: 5 })
    await svc(`delete from public.orders where order_number = 'A-IMPAGO-NUEVO'`)
  })

  it('un descarte caducado deja de tapar', async () => {
    await silenciar('orders.unpaid', '4')
    await svc(`update public.watch_dismissals set expires_at = now() - interval '1 minute'`)
    expect(keys(await watch(claimsFor(TENANT_A), storeOf[TENANT_A.slug]!))).toContain('orders.unpaid')
  })

  it('devolver el aviso lo saca del silencio', async () => {
    await silenciar('orders.unpaid', '4')
    await asRole(db, 'authenticated', claimsFor(TENANT_A), () =>
      svc(`select public.watch_restore($1, $2)`, ['orders.unpaid', storeOf[TENANT_A.slug]]),
    )
    expect(keys(await watch(claimsFor(TENANT_A), storeOf[TENANT_A.slug]!))).toContain('orders.unpaid')
  })

  it('un lector no puede silenciar', async () => {
    const claims = claimsFor(TENANT_A, { sub: VIEWER, email: 'lector@tenant-a.com' })
    const message = await expectFailure(() =>
      asRole(db, 'authenticated', claims, () =>
        svc(`select public.watch_dismiss($1, $2, $3)`, ['orders.unpaid', '4', storeOf[TENANT_A.slug]]),
      ),
    )
    expect(message).toContain('SIN_PERMISO')
  })

  it('el silencio es de la sociedad: el de A no toca a B', async () => {
    await silenciar('orders.unpaid', '4')
    const enB = await svc(`select count(*)::int as n from public.watch_dismissals where organization_id = $1`, [
      TENANT_B.organizationId,
    ])
    expect(enB[0]).toEqual({ n: 0 })
  })
})
