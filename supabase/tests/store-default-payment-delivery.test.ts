// @vitest-environment node
/**
 * Medios de pago y metodos de entrega por defecto al crear una tienda.
 *
 * Lo que no puede fallar:
 *  - toda tienda nace con 5 medios de pago y 5 metodos de entrega, por
 *    `bootstrap_tenant` y por `create_store` (que corre como el usuario);
 *  - en PEN los envios nacen con zona y tarifa y el checkout los ofrece; en otra
 *    moneda nacen inactivos;
 *  - credito y recojo nacen inactivos;
 *  - la siembra es idempotente y no pisa lo que el comercio edito;
 *  - un tenant no ve los medios del otro.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { TENANT_A, TENANT_B, asRole, claimsFor, createTestDatabase } from './harness.ts'

type Row = Record<string, unknown>

let db: PGlite
let storeA: string
let storeB: string

async function svc<T = Row>(query: string, params: unknown[] = []): Promise<T[]> {
  return asRole(db, 'service_role', null, async () => (await db.query<T>(query, params)).rows)
}

async function asOwner<T = Row>(
  tenant: typeof TENANT_A,
  query: string,
  params: unknown[] = [],
): Promise<T[]> {
  return asRole(db, 'authenticated', claimsFor(tenant), async () => (await db.query<T>(query, params)).rows)
}

async function bootstrap(tenant: typeof TENANT_A, currency: string): Promise<string> {
  const [row] = await svc<{ r: { store_id: string } }>(
    `select public.bootstrap_tenant($1, $2, $3, $3, $4, $5, $6, 'Tienda', $7) as r`,
    [
      tenant.organizationId,
      tenant.companyId,
      tenant.slug,
      tenant.adminEmail,
      tenant.ownerId,
      tenant.storeSlug,
      currency,
    ],
  )
  return String(row?.r.store_id)
}

const opciones = async (storeId: string, region: string) => {
  const [row] = await svc<{ o: Array<{ code: string; available: boolean; amount: string | null }> }>(
    `select ebim.delivery_options($1, $2::jsonb, '[]'::jsonb, 100) -> 'options' as o`,
    [storeId, JSON.stringify({ country: 'PE', region })],
  )
  return Object.fromEntries((row?.o ?? []).map((o) => [o.code, o]))
}

beforeAll(async () => {
  db = await createTestDatabase()
  storeA = await bootstrap(TENANT_A, 'PEN')
  storeB = await bootstrap(TENANT_B, 'USD')
}, 120_000)

afterAll(async () => {
  await db?.close()
})

describe('tienda nueva en PEN', () => {
  it('nace con 5 medios de pago: 4 activos y credito inactivo', async () => {
    const rows = await svc<{ code: string; is_active: boolean }>(
      `select code, is_active from public.payment_methods where store_id = $1 order by position`,
      [storeA],
    )
    expect(rows).toEqual([
      { code: 'transferencia', is_active: true },
      { code: 'yape', is_active: true },
      { code: 'plin', is_active: true },
      { code: 'contraentrega', is_active: true },
      { code: 'credito', is_active: false },
    ])
  })

  it('nace con 5 metodos de entrega: envios activos y recojo inactivo', async () => {
    const rows = await svc<{ code: string; is_active: boolean }>(
      `select code, is_active from public.delivery_methods where store_id = $1 order by position`,
      [storeA],
    )
    expect(rows).toEqual([
      { code: 'estandar', is_active: true },
      { code: 'express', is_active: true },
      { code: 'agencia', is_active: true },
      { code: 'reparto-propio', is_active: true },
      { code: 'recojo', is_active: false },
    ])
  })

  it('en Lima el checkout ofrece estandar, express y reparto propio con su tarifa', async () => {
    const o = await opciones(storeA, 'Lima')
    expect(o.estandar).toMatchObject({ available: true, amount: '15.00' })
    expect(o.express).toMatchObject({ available: true, amount: '25.00' })
    expect(o['reparto-propio']).toMatchObject({ available: true, amount: '10.00' })
    expect(o.agencia).toMatchObject({ available: false })
  })

  it('en provincia ofrece estandar y agencia, no express', async () => {
    const o = await opciones(storeA, 'Arequipa')
    expect(o.estandar).toMatchObject({ available: true, amount: '30.00' })
    expect(o.agencia).toMatchObject({ available: true, amount: '20.00' })
    expect(o.express).toMatchObject({ available: false })
  })

  it('Peru queda como pais por defecto del checkout', async () => {
    // El pais solo se publica para tiendas activas, y esta nace en borrador.
    await svc(`update public.stores set status = 'active' where id = $1`, [storeA])
    const [row] = await svc<{ default_country: string | null }>(
      `select default_country from public.public_stores where store_id = $1`,
      [storeA],
    )
    expect(row?.default_country).toBe('PE')
  })

  it('volver a sembrar no duplica ni pisa lo editado', async () => {
    await svc(
      `update public.payment_methods set instructions = 'BCP 191-123', is_active = false
        where store_id = $1 and code = 'transferencia'`,
      [storeA],
    )
    await svc(`select ebim.seed_store_payment_delivery($1)`, [storeA])
    const [pagos] = await svc<{ n: number }>(
      `select count(*)::int as n from public.payment_methods where store_id = $1`,
      [storeA],
    )
    const [tarifas] = await svc<{ n: number }>(
      `select count(*)::int as n from public.delivery_rates where store_id = $1`,
      [storeA],
    )
    const [editado] = await svc<{ instructions: string; is_active: boolean }>(
      `select instructions, is_active from public.payment_methods where store_id = $1 and code = 'transferencia'`,
      [storeA],
    )
    expect(pagos?.n).toBe(5)
    expect(tarifas?.n).toBe(5)
    expect(editado).toEqual({ instructions: 'BCP 191-123', is_active: false })
  })
})

describe('tienda nueva en otra moneda', () => {
  it('tiene los metodos, pero los envios nacen inactivos y sin zonas', async () => {
    const metodos = await svc<{ code: string; is_active: boolean }>(
      `select code, is_active from public.delivery_methods where store_id = $1 order by position`,
      [storeB],
    )
    const [zonas] = await svc<{ n: number }>(
      `select count(*)::int as n from public.delivery_zones where store_id = $1`,
      [storeB],
    )
    expect(metodos).toHaveLength(5)
    expect(metodos.every((m) => !m.is_active)).toBe(true)
    expect(zonas?.n).toBe(0)
  })
})

describe('permisos y aislamiento', () => {
  it('create_store, que corre como el usuario, tambien siembra', async () => {
    const [row] = await asOwner<{ r: { id?: string; store_id?: string } }>(
      TENANT_A,
      `select public.create_store('tienda-a-dos', 'Tienda A dos', 'PEN') as r`,
    )
    const id = row?.r.store_id ?? row?.r.id
    const [n] = await svc<{ pagos: number; entregas: number }>(
      `select (select count(*)::int from public.payment_methods where store_id = $1) as pagos,
              (select count(*)::int from public.delivery_methods where store_id = $1) as entregas`,
      [id],
    )
    expect(n).toEqual({ pagos: 5, entregas: 5 })
  })

  it('un tenant no ve los medios de pago ni las entregas del otro', async () => {
    const pagos = await asOwner(TENANT_B, `select id from public.payment_methods where store_id = $1`, [storeA])
    const entregas = await asOwner(TENANT_B, `select id from public.delivery_methods where store_id = $1`, [storeA])
    expect(pagos).toHaveLength(0)
    expect(entregas).toHaveLength(0)
  })

  it('un usuario no puede llamar a la siembra directamente', async () => {
    await expect(
      asOwner(TENANT_A, `select ebim.seed_store_payment_delivery($1)`, [storeA]),
    ).rejects.toThrow()
  })
})
