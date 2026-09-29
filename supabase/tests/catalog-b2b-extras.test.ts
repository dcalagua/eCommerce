// @vitest-environment node
/**
 * Resumen v2 · El catálogo para el comprador empresa, sobre Postgres real.
 *
 *  · la búsqueda devuelve el SKU (el código con el que pide el comprador);
 *  · el orden `discount` pone primero el mayor PORCENTAJE de rebaja, y lo que
 *    no está rebajado va al final;
 *  · «ya comprado» lista solo lo que pidió la cuenta EFECTIVA del comprador en
 *    esta tienda: ni otra cuenta, ni otro tenant, ni pedidos cancelados; vacío
 *    para quien no tiene cuenta, y cerrado para `anon`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { TENANT_A, TENANT_B, asRole, createTestDatabase, expectFailure } from './harness.ts'

type Row = Record<string, unknown>
type Json = Record<string, unknown>

const COMPRADOR_A = '0d200000-0000-4000-8000-00000000b001'
const COMPRADOR_OTRA = '0d200000-0000-4000-8000-00000000b002'
const CONSUMIDOR = '0d200000-0000-4000-8000-00000000b003'

let db: PGlite
let storeA = ''
let storeB = ''
let taladro = ''
let martillo = ''
let sierra = ''
let cancelado = ''
let deB = ''
let seq = 0

async function svc<T = Row>(query: string, params: unknown[] = []): Promise<T[]> {
  return asRole(db, 'service_role', null, async () => (await db.query<T>(query, params)).rows)
}

async function id(query: string, params: unknown[]): Promise<string> {
  const [row] = await svc<{ id: string }>(query, params)
  return String(row?.id)
}

const claims = (sub: string) => ({ sub, email: `${sub}@test.test`, org_id: '', companies: [], active_company: '' })

async function comprados(sub: string, slug = TENANT_A.storeSlug): Promise<string[]> {
  const rows = await asRole(db, 'authenticated', claims(sub), async () =>
    (await db.query<{ product_id: string }>(
      `select product_id from public.my_purchased_products_for_slug($1)`,
      [slug],
    )).rows,
  )
  return rows.map((r) => r.product_id).sort()
}

async function search(sort: string, slug = TENANT_A.storeSlug): Promise<Json[]> {
  const rows = await asRole(db, 'anon', null, async () =>
    (await db.query<{ r: Json }>(
      `select public.catalog_search_for_slug($1, null, '{}'::jsonb, $2, 24, 0) as r`,
      [slug, sort],
    )).rows,
  )
  return ((rows[0]?.r.items ?? []) as Json[])
}

async function bootstrap(tenant: typeof TENANT_A): Promise<string> {
  await svc(`select public.bootstrap_tenant($1, $2, $3, $3, $4, $5, $6, 'Tienda', 'PEN')`, [
    tenant.organizationId, tenant.companyId, tenant.slug, tenant.adminEmail, tenant.ownerId, tenant.storeSlug,
  ])
  return id(`update public.stores set status = 'active' where slug = $1 returning id`, [tenant.storeSlug])
}

async function producto(
  tenant: typeof TENANT_A,
  store: string,
  sku: string,
  price: string,
  compareAt: string | null,
): Promise<string> {
  return id(
    `insert into public.products
       (organization_id, company_id, store_id, sku, slug, name, price, compare_at_price, currency,
        stock, status, published_at)
     values ($1, $2, $3, $4, lower($4), $4, $5, $6, 'PEN', 10, 'published', now())
     returning id`,
    [tenant.organizationId, tenant.companyId, store, sku, price, compareAt],
  )
}

async function cuenta(code: string, userId: string): Promise<string> {
  const customer = await id(
    `insert into public.customers (organization_id, company_id, kind, code, name, email)
     values ($1, $2, 'company', $3, $3, $4) returning id`,
    [TENANT_A.organizationId, TENANT_A.companyId, code, `${code.toLowerCase()}@cliente.test`],
  )
  const account = await id(
    `insert into public.business_accounts (organization_id, company_id, customer_id, code, name)
     values ($1, $2, $3, $4, $4) returning id`,
    [TENANT_A.organizationId, TENANT_A.companyId, customer, code],
  )
  await svc(
    `insert into public.business_account_users
       (organization_id, company_id, business_account_id, user_id, email, role, status)
     values ($1, $2, $3, $4, $5, 'buyer', 'active')`,
    [TENANT_A.organizationId, TENANT_A.companyId, account, userId, `${userId}@test.test`],
  )
  return account
}

async function pedido(
  tenant: typeof TENANT_A,
  store: string,
  account: string | null,
  productId: string,
  status = 'paid',
): Promise<void> {
  seq += 1
  const [o] = await svc<{ id: string }>(
    `insert into public.orders
       (organization_id, company_id, store_id, order_number, status, payment_status, fulfillment_status,
        currency, subtotal, tax_total, grand_total, customer_email, channel_id, business_account_id)
     values ($1, $2, $3, $4, $5::public.order_status, 'pending'::public.payment_status,
             'unfulfilled'::public.fulfillment_status, 'PEN', '10.00', 0, '10.00', 'x@test.test',
             (select c.id from public.channels c where c.store_id = $3 and c.is_default), $6)
     returning id`,
    [tenant.organizationId, tenant.companyId, store, `B2BX-${seq}`, status, account],
  )
  await svc(
    `insert into public.order_items
       (organization_id, company_id, store_id, order_id, product_id, sku, name, quantity, unit_price)
     values ($1, $2, $3, $4, $5, 'SKU', 'Producto', 1, '10.00')`,
    [tenant.organizationId, tenant.companyId, store, o!.id, productId],
  )
}

beforeAll(async () => {
  db = await createTestDatabase()
  storeA = await bootstrap(TENANT_A)
  storeB = await bootstrap(TENANT_B)

  // 40 % de rebaja en algo barato, 10 % en algo caro, y una sin rebaja.
  taladro = await producto(TENANT_A, storeA, 'TAL-01', '600.00', '666.67')
  martillo = await producto(TENANT_A, storeA, 'MAR-01', '30.00', '50.00')
  sierra = await producto(TENANT_A, storeA, 'SIE-01', '80.00', null)
  cancelado = await producto(TENANT_A, storeA, 'CAN-01', '15.00', null)
  deB = await producto(TENANT_B, storeB, 'B-01', '10.00', null)

  const cuentaA = await cuenta('EMP-A', COMPRADOR_A)
  const cuentaOtra = await cuenta('EMP-OTRA', COMPRADOR_OTRA)

  await pedido(TENANT_A, storeA, cuentaA, taladro)
  await pedido(TENANT_A, storeA, cuentaA, taladro)
  await pedido(TENANT_A, storeA, cuentaA, martillo)
  await pedido(TENANT_A, storeA, cuentaA, cancelado, 'cancelled')
  await pedido(TENANT_A, storeA, cuentaOtra, sierra)
  await pedido(TENANT_A, storeA, null, sierra)
  await pedido(TENANT_B, storeB, null, deB)
}, 180_000)

afterAll(async () => {
  await db?.close()
})

describe('búsqueda para empresa', () => {
  it('cada resultado trae su SKU', async () => {
    const items = await search('relevance')
    const skus = items.map((item) => item.sku).sort()
    expect(skus).toEqual(['CAN-01', 'MAR-01', 'SIE-01', 'TAL-01'])
  })

  it('`discount` ordena por porcentaje de rebaja y deja al final lo no rebajado', async () => {
    const skus = (await search('discount')).map((item) => item.sku)
    expect(skus.slice(0, 2)).toEqual(['MAR-01', 'TAL-01'])
    expect(skus.slice(2).sort()).toEqual(['CAN-01', 'SIE-01'])
  })
})

describe('ya comprado', () => {
  it('lista lo que pidió SU cuenta, sin repetir ni contar lo cancelado', async () => {
    expect(await comprados(COMPRADOR_A)).toEqual([martillo, taladro].sort())
  })

  it('otra cuenta del mismo tenant ve solo lo suyo', async () => {
    expect(await comprados(COMPRADOR_OTRA)).toEqual([sierra])
  })

  it('sin cuenta de empresa, vacío', async () => {
    expect(await comprados(CONSUMIDOR)).toEqual([])
  })

  it('en la tienda de otro tenant, vacío: la cuenta es de A', async () => {
    expect(await comprados(COMPRADOR_A, TENANT_B.storeSlug)).toEqual([])
  })

  it('anon no puede ejecutarla', async () => {
    const message = await expectFailure(() =>
      asRole(db, 'anon', null, () =>
        db.query(`select * from public.my_purchased_products_for_slug($1)`, [TENANT_A.storeSlug]),
      ),
    )
    expect(message).toMatch(/permission denied/i)
  })
})
