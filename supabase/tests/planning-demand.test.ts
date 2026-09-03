// @vitest-environment node
import type { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  asRole,
  claimsFor,
  createTestDatabase,
  expectFailure,
  TENANT_A,
  TENANT_B,
} from './harness'

/**
 * Recomendación de pedido y forecast, contra Postgres real (fases 14 y 15).
 *
 * La regla que define esta frontera: **la sugerencia NO crea pedidos**. Produce
 * una lista que una persona confirma. Un sistema que pide por ti es un sistema
 * que se equivoca por ti, y en distribución eso se paga en devoluciones y en
 * mercadería vencida.
 *
 * Por eso cada línea guarda su MOTIVO: es lo que permite que un preventista
 * defienda la cifra delante del cliente y lo que permite auditar después por
 * qué el sistema propuso lo que propuso. Una sugerencia sin motivo es un número
 * que nadie discute y por tanto nadie corrige.
 */

let db: PGlite

let STORE = ''
let CANAL = ''

async function svc(query: string, params: unknown[] = []) {
  const result = await db.query<Record<string, unknown>>(query, params)
  return result.rows
}

async function producto(sku: string): Promise<string> {
  const rows = await svc(
    `insert into public.products
       (organization_id, company_id, store_id, sku, slug, name, price, currency, stock, status)
     values ($1, $2, $3, $4, lower($4), $4, '10.00', 'PEN', 100, 'draft') returning id`,
    [TENANT_A.organizationId, TENANT_A.companyId, STORE, sku],
  )
  return rows[0]?.id as string
}

async function clienteConCuenta(code: string): Promise<{ customer: string; account: string }> {
  const c = await svc(
    `insert into public.customers (organization_id, company_id, kind, code, name)
     values ($1, $2, 'company', $3, $3) returning id`,
    [TENANT_A.organizationId, TENANT_A.companyId, code],
  )
  const a = await svc(
    `insert into public.business_accounts
       (organization_id, company_id, customer_id, customer_kind, code, name)
     values ($1, $2, $3, 'company', $4, $4) returning id`,
    [TENANT_A.organizationId, TENANT_A.companyId, c[0]?.id, code],
  )
  return { customer: c[0]?.id as string, account: a[0]?.id as string }
}

/** Un pedido de esa cuenta B2B, con una linea. */
async function pedido(account: string, numero: string, product: string, qty: number) {
  const o = await svc(
    `insert into public.orders
       (organization_id, company_id, store_id, order_number, status, currency,
        subtotal, tax_total, grand_total, customer_email, channel_id, business_account_id)
     values ($1, $2, $3, $4, 'paid', 'PEN', 100, 18, 118, 'cliente@test.com', $5, $6)
     returning id`,
    [TENANT_A.organizationId, TENANT_A.companyId, STORE, numero, CANAL, account],
  )
  // `order_items` guarda `store_id` y no lleva moneda propia: la del pedido
  // manda, que es lo que impide que una linea diga soles y su pedido dolares.
  await svc(
    `insert into public.order_items
       (organization_id, company_id, store_id, order_id, product_id, sku, name,
        quantity, unit_price)
     values ($1, $2, $3, $4, $5, 'SKU', 'Producto', $6, '10.00')`,
    [TENANT_A.organizationId, TENANT_A.companyId, STORE, o[0]?.id, product, qty],
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

describe('el sugerido', () => {
  it('propone lo que ese cliente compró, y explica por qué', async () => {
    const { customer, account } = await clienteConCuenta('CLI-S1')
    const p = await producto('SKU-S1')
    await pedido(account, 'EC-S1-1', p, 7)
    await pedido(account, 'EC-S1-2', p, 4)

    const filas = await svc(`select * from ebim.suggest_order($1, $2, 30)`, [STORE, customer])

    expect(filas).toHaveLength(1)
    expect(Number(filas[0]?.suggested_quantity)).toBe(11)
    // El motivo es lo que el preventista dice delante del cliente.
    expect(String(filas[0]?.reason)).toContain('11')
  })

  it('no mira lo que compró OTRO cliente', async () => {
    const mio = await clienteConCuenta('CLI-S2')
    const ajeno = await clienteConCuenta('CLI-S3')
    const p = await producto('SKU-S2')
    await pedido(ajeno.account, 'EC-S2-1', p, 50)

    const filas = await svc(`select * from ebim.suggest_order($1, $2, 30)`, [STORE, mio.customer])
    expect(filas).toEqual([])
  })

  it('un pedido cancelado no cuenta como historial', async () => {
    const { customer, account } = await clienteConCuenta('CLI-S4')
    const p = await producto('SKU-S4')
    await pedido(account, 'EC-S4-1', p, 9)
    await svc(`update public.orders set status = 'cancelled' where order_number = 'EC-S4-1'`)

    const filas = await svc(`select * from ebim.suggest_order($1, $2, 30)`, [STORE, customer])
    // Sugerir sobre lo que se anuló es sugerir sobre algo que nunca se vendió.
    expect(filas).toEqual([])
  })
})

/**
 * La PUERTA del sugerido, no su calculo.
 *
 * El calculo estaba bien y probado desde el primer dia; lo que faltaba era
 * poder llamarlo. `ebim.suggest_order` vive en el esquema `ebim` y el navegador
 * llama por PostgREST, que solo publica `public`: «Generar sugerido» devolvia
 * «No se pudo completar la operacion» con cualquier cliente y cualquier
 * periodo. Estos tests llaman por donde llama el backoffice.
 */
describe('la puerta publica del sugerido', () => {
  it('existe en `public` y devuelve lo mismo que la de dentro', async () => {
    const { customer, account } = await clienteConCuenta('CLI-P1')
    const p = await producto('SKU-P1')
    await pedido(account, 'EC-P1-1', p, 6)

    const porLaPuerta = await svc(`select * from public.suggest_order($1, $2, 30)`, [STORE, customer])
    const porDentro = await svc(`select * from ebim.suggest_order($1, $2, 30)`, [STORE, customer])

    expect(porLaPuerta).toEqual(porDentro)
    expect(Number(porLaPuerta[0]?.suggested_quantity)).toBe(6)
  })

  it('`anon` no puede ejecutarla: un sugerido es historial de un cliente', async () => {
    const message = await expectFailure(() =>
      asRole(db, 'anon', null, () =>
        svc(`select * from public.suggest_order($1, $2, 30)`, [STORE, STORE]),
      ),
    )
    expect(message).toContain('permission denied')
  })

  it('la RLS sigue mandando: quien llama solo ve el historial de su tienda', async () => {
    const { customer, account } = await clienteConCuenta('CLI-P2')
    const p = await producto('SKU-P2')
    await pedido(account, 'EC-P2-1', p, 12)

    // Miembro de OTRO tenant, preguntando por la tienda y el cliente ajenos.
    const filas = await asRole(db, 'authenticated', claimsFor(TENANT_B), () =>
      svc(`select * from public.suggest_order($1, $2, 30)`, [STORE, customer]),
    )

    // Ni error ni filas: la funcion es `security invoker`, asi que las policies
    // de `orders` y `business_accounts` no le dejan ver nada.
    expect(filas).toEqual([])
  })
})

describe('la sugerencia guardada', () => {
  it('cada línea lleva su motivo, obligatorio', async () => {
    const { customer } = await clienteConCuenta('CLI-G1')
    const p = await producto('SKU-G1')
    const s = await svc(
      `insert into public.order_suggestions
         (organization_id, company_id, store_id, customer_id)
       values ($1, $2, $3, $4) returning id`,
      [TENANT_A.organizationId, TENANT_A.companyId, STORE, customer],
    )

    const message = await expectFailure(() =>
      svc(
        `insert into public.order_suggestion_items
           (organization_id, company_id, suggestion_id, product_id, suggested_quantity, reason)
         values ($1, $2, $3, $4, 5, '   ')`,
        [TENANT_A.organizationId, TENANT_A.companyId, s[0]?.id, p],
      ),
    )
    expect(message).toMatch(/reason_len|violates check/i)
  })

  it('NO crea pedidos: solo apunta al que una persona confirmó', async () => {
    const columnas = await svc(
      `select column_name from information_schema.columns
        where table_schema = 'public' and table_name = 'order_suggestions'
          and column_name = 'order_id'`,
    )
    // `order_id` es una referencia a lo que ya se creó por el pipeline de
    // checkout, no un pedido que esta tabla haya creado.
    expect(columnas).toHaveLength(1)

    const funciones = await svc(
      `select proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'ebim' and proname = 'suggest_order'`,
    )
    const definicion = await svc(
      `select prokind from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'ebim' and proname = 'suggest_order'`,
    )
    expect(funciones).toHaveLength(1)
    // `f` = funcion normal que DEVUELVE filas, no un procedimiento que actúa.
    expect(definicion[0]?.prokind).toBe('f')
  })
})

describe('el forecast', () => {
  it('la confianza vive entre cero y uno', async () => {
    const p = await producto('SKU-F1')
    const message = await expectFailure(() =>
      svc(
        `insert into public.demand_forecasts
           (organization_id, company_id, store_id, product_id, period_start, period_end,
            forecast_quantity, confidence)
         values ($1, $2, $3, $4, current_date, current_date + 30, 100, 5)`,
        [TENANT_A.organizationId, TENANT_A.companyId, STORE, p],
      ),
    )
    expect(message).toMatch(/confidence_range|violates check/i)
  })

  it('puede no traer confianza: hay modelos que no la dan', async () => {
    const p = await producto('SKU-F2')
    await expect(
      svc(
        `insert into public.demand_forecasts
           (organization_id, company_id, store_id, product_id, period_start, period_end,
            forecast_quantity)
         values ($1, $2, $3, $4, current_date, current_date + 30, 100)`,
        [TENANT_A.organizationId, TENANT_A.companyId, STORE, p],
      ),
    ).resolves.toBeDefined()
  })

  it('dos MODELOS pueden prever el mismo periodo: comparar es el caso de uso', async () => {
    const p = await producto('SKU-F3')
    const meter = (modelo: string) =>
      svc(
        `insert into public.demand_forecasts
           (organization_id, company_id, store_id, product_id, period_start, period_end,
            forecast_quantity, model_code)
         values ($1, $2, $3, $4, current_date, current_date + 30, 100, $5)`,
        [TENANT_A.organizationId, TENANT_A.companyId, STORE, p, modelo],
      )

    await meter('naive_v1')
    await expect(meter('holt_v2')).resolves.toBeDefined()

    // El mismo modelo dos veces sobre el mismo periodo sí es un duplicado.
    const message = await expectFailure(() => meter('naive_v1'))
    expect(message).toMatch(/demand_forecasts_unique|duplicate key/i)
  })

  it('la previsión dice CUÁNDO y CON QUÉ se calculó', async () => {
    const columnas = await svc(
      `select column_name, is_nullable from information_schema.columns
        where table_schema = 'public' and table_name = 'demand_forecasts'
          and column_name in ('model_code', 'generated_at')`,
    )
    // Sin las dos, una cifra de demanda es indistinguible de una venta real y
    // alguien acabará sumándola a un informe.
    expect(columnas.map((c) => c.is_nullable)).toEqual(['NO', 'NO'])
  })
})
