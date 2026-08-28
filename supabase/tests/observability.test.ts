// @vitest-environment node
/**
 * P13-SaaS · Observabilidad operativa, contra Postgres REAL.
 *
 * Este archivo prueba la **Definition of Done** de la fase, literalmente:
 *
 *   «PASS si un incidente de checkout/integracion puede rastrearse end-to-end
 *    con correlation id.»
 *
 * El ultimo bloque lo hace: una peticion con un hilo recorre intento de compra,
 * pedido, cobro, hecho de dominio, mensaje al exterior e incidente, y
 * `trace_by_correlation` devuelve los seis en orden y sin que ninguna funcion de
 * dominio haya tenido que aceptar un parametro nuevo.
 *
 * Lo demas es lo que sostiene esa propiedad:
 *
 *  · el hilo se cose SOLO, por DEFAULT de columna;
 *  · los cuatro tipos de fallo se proyectan a `ops_events` por trigger;
 *  · el mismo fallo repetido es UN incidente con contador, no cien;
 *  · `ops_health` no acepta tenant: lo deriva del JWT;
 *  · un tenant no ve la cola, los incidentes ni el rastro del otro;
 *  · atender un incidente exige rol y motivo, y queda auditado.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { TENANT_A, TENANT_B, asRole, claimsFor, createTestDatabase, expectFailure } from './harness.ts'

type Row = Record<string, unknown>
type Json = Record<string, unknown>

let db: PGlite

const STORE_A_SLUG = 'tienda-a'
const STORE_B_SLUG = 'tienda-b'
const HILO = 'ec-incidente-0001'

let storeA: string
let storeB: string
let channelA: string
let channelB: string
let metodoA: string

/**
 * Un miembro REAL con rol de solo lectura.
 *
 * No basta con cambiar el `role` del claim: `ebim.has_role` mira
 * `tenant_members`, o sea la membresia de verdad, y no lo que el token diga de
 * si mismo. Que haga falta dar de alta a una persona para probar el 403 es,
 * precisamente, la propiedad que se esta probando.
 */
const MIRON = {
  ...TENANT_A,
  ownerId: '0a000000-0000-4000-8000-0000000000aa',
  adminEmail: 'miron@tenant-a.com',
}

async function sql(query: string, params: unknown[] = []): Promise<Row[]> {
  return (await db.query<Row>(query, params)).rows
}

async function svc(query: string, params: unknown[] = []): Promise<Row[]> {
  return asRole(db, 'service_role', null, () => sql(query, params))
}

async function member(
  query: string,
  params: unknown[] = [],
  tenant = TENANT_A,
  overrides: Record<string, unknown> = {},
): Promise<Row[]> {
  return asRole(db, 'authenticated', claimsFor(tenant, overrides), () => sql(query, params))
}

async function id(query: string, params: unknown[] = []): Promise<string> {
  const rows = await svc(query, params)
  return String(rows[0]?.id)
}

/** Ejecuta con el hilo puesto, como haria PostgREST con la cabecera. */
async function withTrace<T>(hilo: string, run: () => Promise<T>): Promise<T> {
  await sql(`select set_config('ebim.correlation_id', $1, false)`, [hilo])
  try {
    return await run()
  } finally {
    await sql(`select set_config('ebim.correlation_id', '', false)`)
  }
}

async function incidents(tenant = TENANT_A): Promise<Row[]> {
  return sql(
    `select * from public.ops_events where organization_id = $1 order by occurred_at`,
    [tenant.organizationId],
  )
}

let seq = 0

async function newIntent(
  tenant = TENANT_A,
  store = storeA,
  updatedAt: string | null = null,
): Promise<string> {
  seq += 1
  // `updated_at` se pone en el INSERT y no con un UPDATE posterior: el trigger
  // `checkout_intents_updated_at` lo reescribiria a `now()` y el intento
  // «atascado desde hace media hora» seria un intento de hace un segundo.
  return id(
    `insert into public.checkout_intents
       (organization_id, company_id, store_id, idempotency_key, request_hash, updated_at)
     values ($1, $2, $3, $4, repeat('b', 64), coalesce($5::timestamptz, now())) returning id`,
    [
      tenant.organizationId, tenant.companyId, store,
      `idem-obs-${String(seq).padStart(4, '0')}-${'y'.repeat(16)}`,
      updatedAt,
    ],
  )
}

async function newOrder(tenant = TENANT_A, store = storeA, channel = channelA): Promise<string> {
  seq += 1
  return id(
    `insert into public.orders
       (organization_id, company_id, store_id, channel_id, order_number, customer_email,
        currency, subtotal, tax_total, grand_total)
     values ($1, $2, $3, $4, $5, 'comprador@example.com', 'PEN', '100.00', 0, '100.00')
     returning id`,
    [tenant.organizationId, tenant.companyId, store, channel, `EC-OBS-${seq}`],
  )
}

beforeAll(async () => {
  db = await createTestDatabase()

  for (const [tenant, storeSlug] of [
    [TENANT_A, STORE_A_SLUG],
    [TENANT_B, STORE_B_SLUG],
  ] as const) {
    await svc(`select public.bootstrap_tenant($1, $2, $3, $4, $5, $6, $7, 'Tienda', 'PEN')`, [
      tenant.organizationId, tenant.companyId, tenant.slug, tenant.slug,
      tenant.adminEmail, tenant.ownerId, storeSlug,
    ])
  }
  await svc(`update public.stores set status = 'active'`)

  const stores = await svc(`select id, slug from public.stores order by slug`)
  storeA = String(stores.find((s) => s.slug === STORE_A_SLUG)?.id)
  storeB = String(stores.find((s) => s.slug === STORE_B_SLUG)?.id)

  const channels = await svc(`select id, store_id from public.channels where is_default`)
  channelA = String(channels.find((c) => c.store_id === storeA)?.id)
  channelB = String(channels.find((c) => c.store_id === storeB)?.id)

  metodoA = await id(
    `insert into public.payment_methods
       (organization_id, company_id, store_id, code, kind, display_name, provider_code)
     values ($1, $2, $3, 'sandbox', 'card', 'Pasarela de pruebas', 'sandbox')
     returning id`,
    [TENANT_A.organizationId, TENANT_A.companyId, storeA],
  )

  await svc(
    `insert into public.tenant_members (organization_id, company_id, user_id, email, role)
     values ($1, $2, $3, $4, 'viewer')`,
    [MIRON.organizationId, MIRON.companyId, MIRON.ownerId, MIRON.adminEmail],
  )
}, 180_000)

afterAll(async () => {
  await db?.close()
})

beforeEach(async () => {
  // Los recuentos de un test no pueden depender de que otro haya corrido antes.
  await sql(`delete from public.ops_events`)
  await sql(`delete from public.domain_events`)
  await sql(`delete from public.integration_outbox`)
  await sql(`delete from public.checkout_intents`)
  await sql(`alter table public.audit_log disable trigger audit_log_append_only`)
  await sql(`delete from public.audit_log`)
  await sql(`alter table public.audit_log enable trigger audit_log_append_only`)
})

// ---------------------------------------------------------------------------

describe('el hilo se cose solo', () => {
  it('las ocho tablas del camino de una compra tienen `correlation_id` con DEFAULT', async () => {
    const rows = await sql(`
      select c.relname as tabla, a.attname as columna,
             pg_get_expr(d.adbin, d.adrelid) as por_defecto
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        join pg_attribute a on a.attrelid = c.oid and a.attname = 'correlation_id'
        left join pg_attrdef d on d.adrelid = c.oid and d.adnum = a.attnum
       where n.nspname = 'public' and c.relkind = 'r'
       order by c.relname
    `)
    const conDefault = rows
      .filter((r) => String(r.por_defecto ?? '').includes('correlation_id'))
      .map((r) => r.tabla)
    for (const tabla of [
      'checkout_intents', 'orders', 'payment_intents', 'payment_events',
      'fulfillments', 'domain_events', 'integration_outbox', 'integration_inbox',
    ]) {
      expect(conDefault).toContain(tabla)
    }
  })

  it('una escritura DENTRO de la peticion queda cosida sin tocar ninguna funcion', async () => {
    const order = await withTrace(HILO, () => newOrder())
    const rows = await sql(`select correlation_id from public.orders where id = $1`, [order])
    expect(rows[0]?.correlation_id).toBe(HILO)
  })

  it('sin hilo, la columna queda NULL: no se inventa uno', async () => {
    const order = await newOrder()
    const rows = await sql(`select correlation_id from public.orders where id = $1`, [order])
    expect(rows[0]?.correlation_id).toBeNull()
  })

  it('el backoffice puede LEER el hilo del intento de compra', async () => {
    // `checkout_intents` tiene GRANT por columna desde P07. Sin el GRANT
    // explicito de P13, el hilo del checkout —justo el que la Definition of Done
    // nombra— seria invisible para el comercio.
    await withTrace(HILO, () => newIntent())
    const rows = await member(
      `select correlation_id from public.checkout_intents where correlation_id is not null`,
    )
    expect(rows[0]?.correlation_id).toBe(HILO)
  })
})

describe('los cuatro fallos se proyectan a la bitacora de operacion', () => {
  it('un checkout que se cierra sin pedido', async () => {
    const intent = await withTrace(HILO, async () => {
      const created = await newIntent()
      await svc(
        `update public.checkout_intents
            set status = 'failed', error_code = 'STOCK_INSUFICIENTE',
                error_stage = 'reserve_inventory', error_detail = 'no quedaban unidades'
          where id = $1`,
        [created],
      )
      return created
    })

    const rows = await incidents()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.kind).toBe('checkout_failed')
    expect(rows[0]?.code).toBe('STOCK_INSUFICIENTE')
    expect(rows[0]?.severity).toBe('error')
    expect(rows[0]?.entity_id).toBe(intent)
    expect(rows[0]?.correlation_id).toBe(HILO)
    expect((rows[0]?.context as Json).stage).toBe('reserve_inventory')
  })

  it('un cobro que la pasarela rechaza, con el codigo del PROVEEDOR sin traducir', async () => {
    const order = await newOrder()
    const intent = await id(
      `insert into public.payment_intents
         (organization_id, company_id, store_id, order_id, payment_method_id,
          provider_code, currency, amount, idempotency_key)
       values ($1, $2, $3, $4, $5, 'sandbox', 'PEN', '100.00', 'pay-idem-0001')
       returning id`,
      [TENANT_A.organizationId, TENANT_A.companyId, storeA, order, metodoA],
    )
    await svc(
      `update public.payment_intents
          set status = 'failed', last_error_code = 'insufficient_funds',
              last_error_detail = 'la tarjeta no tiene saldo'
        where id = $1`,
      [intent],
    )

    const rows = await incidents()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.kind).toBe('payment_failed')
    expect(rows[0]?.code).toBe('INSUFFICIENT_FUNDS')
    expect((rows[0]?.context as Json).provider).toBe('sandbox')
  })

  it('un mensaje al exterior: `failed` avisa, `dead` es critico', async () => {
    const outbox = await id(
      `insert into public.integration_outbox
         (organization_id, company_id, provider_code, operation, idempotency_key)
       values ($1, $2, 'sandbox', 'order.create', 'outbox-idem-0001') returning id`,
      [TENANT_A.organizationId, TENANT_A.companyId],
    )
    await svc(
      `update public.integration_outbox set status = 'failed', last_error = 'timeout', attempts = 1
        where id = $1`,
      [outbox],
    )
    let rows = await incidents()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.severity).toBe('warning')
    expect(rows[0]?.code).toBe('INTEGRACION_FALLIDA')

    await svc(`update public.integration_outbox set status = 'dead' where id = $1`, [outbox])
    rows = await incidents()
    // Es el MISMO incidente, no uno nuevo: la clave de deduplicacion es la fila.
    expect(rows).toHaveLength(1)
    expect(rows[0]?.severity).toBe('critical')
    expect(rows[0]?.code).toBe('INTEGRACION_FALLIDA')
    expect((rows[0]?.context as Json).repeats).toBe(2)
  })

  it('un hecho de dominio que llega a la cola muerta', async () => {
    const evento = await id(
      `insert into public.domain_events
         (organization_id, company_id, store_id, event_type, aggregate_type, dedupe_key)
       values ($1, $2, $3, 'order.created', 'order', 'dedupe-obs-0001') returning id`,
      [TENANT_A.organizationId, TENANT_A.companyId, storeA],
    )
    await svc(
      `update public.domain_events set status = 'dead', last_error = 'sin consumidor' where id = $1`,
      [evento],
    )
    const rows = await incidents()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.kind).toBe('event_undelivered')
    expect(rows[0]?.severity).toBe('critical')
  })

  it('el mismo fallo repetido es UN incidente con contador, no cien filas', async () => {
    const intent = await newIntent()
    for (const detalle of ['uno', 'dos', 'tres']) {
      await svc(
        `update public.checkout_intents
            set status = 'running' where id = $1`,
        [intent],
      )
      await svc(
        `update public.checkout_intents
            set status = 'failed', error_code = 'PRECIO_CAMBIADO', error_detail = $2
          where id = $1`,
        [intent, detalle],
      )
    }
    const rows = await incidents()
    expect(rows).toHaveLength(1)
    expect((rows[0]?.context as Json).repeats).toBe(3)
    // El mensaje es el del ULTIMO golpe: es el que sirve para diagnosticar hoy.
    expect(rows[0]?.message).toBe('tres')
  })
})

describe('el borde escribe por su propia puerta', () => {
  it('`ops_record_event` acepta lo que la base no puede ver: una firma invalida', async () => {
    await svc(
      `select public.ops_record_event($1, $2, 'webhook_rejected', 'FIRMA_INVALIDA',
                                      'edge:payments-webhook:0001', 'error',
                                      'la firma no valida', 'edge:payments-webhook')`,
      [TENANT_A.organizationId, TENANT_A.companyId],
    )
    const rows = await incidents()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.kind).toBe('webhook_rejected')
    expect(rows[0]?.source).toBe('edge:payments-webhook')
  })

  it('y una operacion lenta, con su duracion', async () => {
    await svc(
      `select public.ops_record_event($1, $2, 'slow_operation', 'OPERACION_LENTA',
                                      'edge:checkout:0001', 'warning', null,
                                      'edge:checkout', 'checkout', 2400)`,
      [TENANT_A.organizationId, TENANT_A.companyId],
    )
    const rows = await incidents()
    expect(rows[0]?.duration_ms).toBe(2400)
  })

  it('el navegador NO puede escribir un incidente', async () => {
    const message = await expectFailure(() =>
      member(
        `select public.ops_record_event($1, $2, 'webhook_rejected', 'FALSO', 'inventado-0001')`,
        [TENANT_A.organizationId, TENANT_A.companyId],
      ),
    )
    expect(message).toMatch(/permission denied|permiso/i)
  })

  it('el contexto de un incidente tambien pasa por la guarda de PII', async () => {
    const message = await expectFailure(() =>
      svc(
        `insert into public.ops_events
           (organization_id, company_id, kind, code, dedupe_key, context)
         values ($1, $2, 'webhook_rejected', 'PRUEBA_PII', 'directo-0001',
                 '{"body": "de juan@example.com"}'::jsonb)`,
        [TENANT_A.organizationId, TENANT_A.companyId],
      ),
    )
    expect(message).toMatch(/ops_events_context_clean/)
  })
})

describe('la salud del tenant, y solo del tenant', () => {
  it('`ops_health` no acepta ningun identificador de tenant', async () => {
    const args = await sql(`
      select pg_get_function_arguments(p.oid) as args
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = 'ops_health'
    `)
    expect(String(args[0]?.args)).toBe('p_store_id uuid DEFAULT NULL::uuid')
  })

  it('cuenta la profundidad de cola, la edad de lo mas viejo y los atascados', async () => {
    await svc(
      `insert into public.domain_events
         (organization_id, company_id, store_id, event_type, aggregate_type, dedupe_key, created_at)
       values ($1, $2, $3, 'order.created', 'order', 'salud-0001', now() - interval '10 minutes')`,
      [TENANT_A.organizationId, TENANT_A.companyId, storeA],
    )
    await newIntent(TENANT_A, storeA, new Date(Date.now() - 30 * 60_000).toISOString())

    const rows = await member(`select public.ops_health() as h`)
    const health = rows[0]?.h as Json
    const colas = health.queues as Json
    const eventos = colas.domain_events as Json
    expect(eventos.pending).toBe(1)
    expect(Number(eventos.oldest_pending_seconds)).toBeGreaterThanOrEqual(500)
    expect(health.stuck_checkouts).toBe(1)
  })

  it('un `viewer` no ve la salud: es de quien administra', async () => {
    const message = await expectFailure(() =>
      member(`select public.ops_health()`, [], MIRON),
    )
    expect(message).toMatch(/SIN_PERMISO/)
  })

  it('la cola de un tenant no aparece en la salud del otro', async () => {
    await svc(
      `insert into public.domain_events
         (organization_id, company_id, store_id, event_type, aggregate_type, dedupe_key)
       values ($1, $2, $3, 'order.created', 'order', 'salud-b-0001')`,
      [TENANT_B.organizationId, TENANT_B.companyId, storeB],
    )
    const a = ((await member(`select public.ops_health() as h`))[0]?.h as Json).queues as Json
    const b = ((await member(`select public.ops_health() as h`, [], TENANT_B))[0]?.h as Json)
      .queues as Json
    expect((a.domain_events as Json).pending).toBe(0)
    expect((b.domain_events as Json).pending).toBe(1)
  })

  it('un incidente de A no lo ve el administrador de B', async () => {
    await svc(
      `select public.ops_record_event($1, $2, 'webhook_rejected', 'FIRMA_INVALIDA', 'aisl-0001')`,
      [TENANT_A.organizationId, TENANT_A.companyId],
    )
    const vistosPorB = await member(`select count(*)::int as n from public.ops_events`, [], TENANT_B)
    expect(Number(vistosPorB[0]?.n)).toBe(0)
    const vistosPorA = await member(`select count(*)::int as n from public.ops_events`)
    expect(Number(vistosPorA[0]?.n)).toBe(1)
  })
})

describe('atender un incidente', () => {
  async function unIncidente(): Promise<string> {
    const rows = await svc(
      `select public.ops_record_event($1, $2, 'integration_failed', 'TIMEOUT',
                                      'atender-0001') as id`,
      [TENANT_A.organizationId, TENANT_A.companyId],
    )
    return String(rows[0]?.id)
  }

  it('exige un motivo', async () => {
    const incidente = await unIncidente()
    const message = await expectFailure(() =>
      member(`select public.ops_resolve_event($1, '  ')`, [incidente]),
    )
    expect(message).toMatch(/MOTIVO_REQUERIDO/)
  })

  it('exige rol de administracion', async () => {
    const incidente = await unIncidente()
    const message = await expectFailure(() =>
      member(`select public.ops_resolve_event($1, 'reintentado a mano')`, [incidente], MIRON),
    )
    expect(message).toMatch(/SIN_PERMISO/)
  })

  it('y cuando se atiende, queda firmado y auditado', async () => {
    const incidente = await unIncidente()
    await member(`select public.ops_resolve_event($1, 'reintentado a mano')`, [incidente])

    const rows = await sql(`select * from public.ops_events where id = $1`, [incidente])
    expect(rows[0]?.resolved_at).not.toBeNull()
    expect(rows[0]?.resolved_by).toBe(TENANT_A.ownerId)
    expect(rows[0]?.resolution_note).toBe('reintentado a mano')

    const auditoria = await sql(
      `select * from public.audit_log where action = 'ops_event.resolved'`,
    )
    expect(auditoria).toHaveLength(1)
    expect(auditoria[0]?.actor_email).toBe(TENANT_A.adminEmail)
    expect(auditoria[0]?.entity_id).toBe(incidente)
  })

  it('no hay GRANT de UPDATE: atender no es un `update`', async () => {
    const grants = await sql(`
      select privilege_type from information_schema.role_table_grants
       where table_schema = 'public' and table_name = 'ops_events'
         and grantee = 'authenticated' and privilege_type = 'UPDATE'
    `)
    expect(grants).toEqual([])
  })
})

// ---------------------------------------------------------------------------

describe('DEFINITION OF DONE · un incidente se rastrea de punta a punta', () => {
  it('un hilo recorre compra, pedido, cobro, hecho, integracion e incidente', async () => {
    const HILO_DOD = 'ec-dod-checkout-0001'

    const { intent, order } = await withTrace(HILO_DOD, async () => {
      // 1 · el comprador empieza
      const created = await newIntent()
      // 2 · el pedido existe
      const placed = await newOrder()
      // 3 · el cobro se intenta y falla
      const pago = await id(
        `insert into public.payment_intents
           (organization_id, company_id, store_id, order_id, payment_method_id,
            provider_code, currency, amount, idempotency_key)
         values ($1, $2, $3, $4, $5, 'sandbox', 'PEN', '100.00', 'pay-dod-0001')
         returning id`,
        [TENANT_A.organizationId, TENANT_A.companyId, storeA, placed, metodoA],
      )
      await svc(
        `update public.payment_intents
            set status = 'failed', last_error_code = 'gateway_timeout'
          where id = $1`,
        [pago],
      )
      // 4 · el hecho de dominio se publica y no llega a nadie
      const hecho = await id(
        `insert into public.domain_events
           (organization_id, company_id, store_id, event_type, aggregate_type,
            aggregate_id, dedupe_key)
         values ($1, $2, $3, 'order.created', 'order', $4, 'dedupe-dod-0001') returning id`,
        [TENANT_A.organizationId, TENANT_A.companyId, storeA, placed],
      )
      await svc(`update public.domain_events set status = 'dead' where id = $1`, [hecho])
      // 5 · el mensaje al exterior muere
      const salida = await id(
        `insert into public.integration_outbox
           (organization_id, company_id, provider_code, operation, idempotency_key)
         values ($1, $2, 'sandbox', 'order.create', 'outbox-dod-0001') returning id`,
        [TENANT_A.organizationId, TENANT_A.companyId],
      )
      await svc(
        `update public.integration_outbox set status = 'dead', last_error = 'sin respuesta'
          where id = $1`,
        [salida],
      )
      // 6 · y el intento se cierra en fallo
      await svc(
        `update public.checkout_intents
            set status = 'failed', error_code = 'PAGO_RECHAZADO', error_stage = 'authorize_payment'
          where id = $1`,
        [created],
      )
      return { intent: created, order: placed }
    })

    const traza = await member(`select * from public.trace_by_correlation($1)`, [HILO_DOD])
    const dominios = traza.map((r) => r.domain)

    // Los SIETE dominios del camino, en la MISMA consulta.
    expect(dominios).toContain('checkout')
    expect(dominios).toContain('orders')
    expect(dominios).toContain('payments')
    expect(dominios).toContain('events')
    expect(dominios).toContain('integrations')
    expect(dominios).toContain('analytics')
    expect(dominios).toContain('ops')

    // En ORDEN cronologico: es lo que permite decir qué pasó primero.
    const momentos = traza.map((r) => new Date(String(r.occurred_at)).getTime())
    expect(momentos).toEqual([...momentos].sort((a, b) => a - b))

    // Y el diagnostico completo: donde se rompio y por que.
    const checkout = traza.find((r) => r.entity_type === 'checkout_intent')
    expect(checkout?.entity_id).toBe(intent)
    expect(checkout?.status).toBe('failed')

    const pedido = traza.find((r) => r.entity_type === 'order')
    expect(pedido?.entity_id).toBe(order)

    const criticos = traza.filter((r) => r.severity === 'critical')
    expect(criticos.length).toBeGreaterThanOrEqual(2)

    const incidentesDelHilo = traza.filter((r) => r.domain === 'ops')
    expect(incidentesDelHilo.length).toBeGreaterThanOrEqual(3)
  })

  it('el rastro de un tenant no se le devuelve al otro', async () => {
    const HILO_B = 'ec-dod-ajeno-0001'
    await withTrace(HILO_B, () => newOrder(TENANT_B, storeB, channelB))

    const paraB = await member(`select * from public.trace_by_correlation($1)`, [HILO_B], TENANT_B)
    expect(paraB.length).toBeGreaterThan(0)

    const paraA = await member(`select * from public.trace_by_correlation($1)`, [HILO_B])
    expect(paraA).toEqual([])
  })

  it('un identificador con forma invalida se rechaza en vez de barrer la base', async () => {
    const message = await expectFailure(() =>
      member(`select * from public.trace_by_correlation('x')`),
    )
    expect(message).toMatch(/CORRELACION_INVALIDA/)
  })

  it('`anon` no puede rastrear nada', async () => {
    const message = await expectFailure(() =>
      asRole(db, 'anon', null, () =>
        sql(`select * from public.trace_by_correlation($1)`, ['ec-dod-checkout-0001']),
      ),
    )
    expect(message).toMatch(/permission denied|permiso/i)
  })
})
