// @vitest-environment node
/**
 * Límite de tasa del checkout anónimo (P10), sobre Postgres real.
 *
 * `create_order` es la única puerta abierta a internet sin sesión y se sirve con
 * `service_role`. Lo que se prueba aquí es que un bot no puede vaciar el stock
 * ni quemar el contador de pedidos de una tienda:
 *  - corta por correo y por tienda;
 *  - el pedido rechazado NO descuenta stock ni consume número de pedido;
 *  - el techo es configurable por tienda sin migración;
 *  - `checkout_attempts` no es escribible desde el cliente.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import {
  TENANT_A,
  asRole,
  claimsFor,
  createTestDatabase,
  expectFailure,
} from './harness.ts'

type Row = Record<string, unknown>

let db: PGlite
let storeA: string
let producto: string

async function svc<T = Row>(query: string, params: unknown[] = []): Promise<T[]> {
  return asRole(db, 'service_role', null, async () => {
    const result = await db.query<T>(query, params)
    return result.rows
  })
}

async function checkout(email: string): Promise<Row> {
  const rows = await svc(
    `select public.create_order_for_slug(
        $1, $2, jsonb_build_array(jsonb_build_object('product_id', $3::text, 'quantity', 1)),
        'Ana', '+51 999 111 222', '{"address":"Av. Primavera 120"}'::jsonb, null) as result`,
    [TENANT_A.storeSlug, email, producto],
  )
  return rows[0]?.result as Row
}

async function setLimits(perEmail: number, perStore: number): Promise<void> {
  await svc(
    `update public.store_settings
        set config = jsonb_set(config, '{checkout_rate_limit}',
              jsonb_build_object('per_email_hour', $2::int, 'per_store_hour', $3::int))
      where store_id = $1`,
    [storeA, perEmail, perStore],
  )
  await svc(`delete from public.checkout_attempts`)
}

beforeAll(async () => {
  db = await createTestDatabase()
  await svc(`select public.bootstrap_tenant($1, $2, $3, $3, $4, $5, $6, 'Tienda', 'PEN')`, [
    TENANT_A.organizationId,
    TENANT_A.companyId,
    TENANT_A.slug,
    TENANT_A.adminEmail,
    TENANT_A.ownerId,
    TENANT_A.storeSlug,
  ])
  const [store] = await svc(`select id from public.stores where slug = $1`, [TENANT_A.storeSlug])
  storeA = String(store?.id)
  await svc(`update public.stores set status = 'active' where id = $1`, [storeA])

  const [row] = await svc(
    `insert into public.products
       (organization_id, company_id, store_id, sku, slug, name, price, currency, stock, status, published_at)
     values ($1, $2, $3, 'RL-1', 'rl-1', 'RL 1', '10.00', 'PEN', 999, 'published', now())
     returning id`,
    [TENANT_A.organizationId, TENANT_A.companyId, storeA],
  )
  producto = String(row?.id)
}, 120_000)

afterAll(async () => {
  await db?.close()
})

describe('corta por correo', () => {
  it('deja pasar hasta el techo y rechaza el siguiente', async () => {
    await setLimits(3, 0)

    for (let i = 0; i < 3; i += 1) {
      const result = await checkout('bot@spam.test')
      expect(result.order_number).toBeTruthy()
    }

    const message = await expectFailure(() => checkout('bot@spam.test'))
    expect(message).toMatch(/LIMITE_DE_PEDIDOS/)
  })

  it('otro correo sigue comprando: el corte es por correo, no global', async () => {
    const result = await checkout('cliente.legitimo@correo.test')
    expect(result.order_number).toBeTruthy()
  })
})

describe('corta por tienda', () => {
  it('rechaza aunque cada pedido venga de un correo distinto', async () => {
    await setLimits(0, 2)

    await checkout('uno@correo.test')
    await checkout('dos@correo.test')

    const message = await expectFailure(() => checkout('tres@correo.test'))
    expect(message).toMatch(/LIMITE_DE_PEDIDOS/)
  })
})

describe('el rechazo no cuesta nada a la tienda', () => {
  it('no descuenta stock ni consume numero de pedido', async () => {
    await setLimits(1, 0)
    await checkout('gasta@correo.test')

    const [antes] = await svc(
      `select p.stock, s.order_seq from public.products p, public.stores s
        where p.id = $1 and s.id = $2`,
      [producto, storeA],
    )

    const message = await expectFailure(() => checkout('gasta@correo.test'))
    expect(message).toMatch(/LIMITE_DE_PEDIDOS/)

    const [despues] = await svc(
      `select p.stock, s.order_seq from public.products p, public.stores s
        where p.id = $1 and s.id = $2`,
      [producto, storeA],
    )
    expect(despues).toEqual(antes)
  })
})

describe('configuracion y blindaje', () => {
  it('el techo se sube por tienda sin migracion', async () => {
    await setLimits(10, 0)
    for (let i = 0; i < 6; i += 1) {
      const result = await checkout('mayorista@correo.test')
      expect(result.order_number).toBeTruthy()
    }
  })

  it('poner 0 desactiva esa dimension de forma explicita', async () => {
    await setLimits(0, 0)
    for (let i = 0; i < 8; i += 1) {
      await checkout('sin-limite@correo.test')
    }
    const [count] = await svc(
      `select count(*)::int as n from public.orders where customer_email = 'sin-limite@correo.test'`,
    )
    expect(count?.n).toBe(8)
  })

  it('el cliente no puede tocar el contador de intentos', async () => {
    for (const role of ['anon', 'authenticated'] as const) {
      const message = await expectFailure(() =>
        asRole(db, role, role === 'authenticated' ? claimsFor(TENANT_A) : null, async () => {
          await db.query(`delete from public.checkout_attempts`)
        }),
      )
      expect(`${role}: ${message}`).toMatch(/permission denied|denied/i)
    }
  })

  it('la purga limpia la ventana vieja y respeta la reciente', async () => {
    await svc(`delete from public.checkout_attempts`)
    await svc(
      `insert into public.checkout_attempts
         (organization_id, company_id, store_id, customer_email, created_at)
       values ($1, $2, $3, 'viejo@correo.test', now() - interval '48 hours'),
              ($1, $2, $3, 'nuevo@correo.test', now())`,
      [TENANT_A.organizationId, TENANT_A.companyId, storeA],
    )

    const [purged] = await svc(`select public.purge_checkout_attempts() as n`)
    expect(purged?.n).toBe(1)

    const rows = await svc(`select customer_email from public.checkout_attempts`)
    expect(rows.map((r) => r.customer_email)).toEqual(['nuevo@correo.test'])
  })
})
