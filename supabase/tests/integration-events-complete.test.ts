// @vitest-environment node
/**
 * 2026-11-26 · Integración con el ERP: los hechos que faltaban, contra Postgres
 * real (migración 20261126100000, encima del contrato v1 de 20261124*).
 *
 * Lo que no puede fallar:
 *
 *  - TODO pedido avisa `order.created`, venga de la vitrina, de la API o del
 *    hub, y uno que ya avisó no avisa dos veces;
 *  - editar un pedido avisa `order.updated` con lo que cambió;
 *  - una guía registrada por el ERP avisa UNA vez `shipment.created`, y un
 *    cambio posterior `shipment.updated`;
 *  - el sobre lleva `schema_version` y `aggregate.version`, y sigue llevando
 *    `data.order` completo;
 *  - el seguimiento por API avanza el envío, es idempotente y solo toca
 *    pedidos del tenant de la credencial y con su scope.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import {
  TENANT_A,
  TENANT_B,
  asRole,
  claimsFor,
  createTestDatabase,
  expectFailure,
  vaciarPagosYEntregas,
} from './harness.ts'
import { isWebhookEnvelope } from '../../src/domain/ports/webhook.ts'

type Row = Record<string, unknown>

let db: PGlite
let storeA = ''
let storeB = ''
let productA = ''
let clientA = ''
let readOnlyA = ''
let clientB = ''
let compradorSeq = 0

const ENTITLEMENT = 'ecommerce.integrations.enterprise'
const LIMA = { address: 'Av. Primavera 120', city: 'Lima', region: 'Lima', postal_code: '15023', country: 'PE' }

async function svc<T = Row>(query: string, params: unknown[] = []): Promise<T[]> {
  return asRole(db, 'service_role', null, async () => (await db.query<T>(query, params)).rows)
}

async function asUser<T = Row>(
  claims: ReturnType<typeof claimsFor>,
  query: string,
  params: unknown[] = [],
): Promise<T[]> {
  return asRole(db, 'authenticated', claims, async () => (await db.query<T>(query, params)).rows)
}

async function bootstrap(tenant: typeof TENANT_A): Promise<string> {
  await svc(`select public.bootstrap_tenant($1, $2, $3, $3, $4, $5, $6, 'Tienda', 'PEN')`, [
    tenant.organizationId,
    tenant.companyId,
    tenant.slug,
    tenant.adminEmail,
    tenant.ownerId,
    tenant.storeSlug,
  ])
  const [store] = await svc(`select id from public.stores where slug = $1`, [tenant.storeSlug])
  const storeId = String(store?.id)
  await svc(`update public.stores set status = 'active' where id = $1`, [storeId])
  return storeId
}

async function credential(tenant: typeof TENANT_A, scopes: string[]): Promise<string> {
  const [row] = await asUser<{ data: { id: string } }>(
    claimsFor(tenant),
    `select public.api_client_create($1, $2) as data`,
    [`erp-${scopes.length}`, scopes],
  )
  return String(row?.data.id)
}

/** Un pedido de la vitrina con entrega a domicilio: nace con su entrega. */
async function place(): Promise<{ id: string; number: string }> {
  compradorSeq += 1
  const [row] = await svc<{ result: { order_id: string; order_number: string } }>(
    `select public.create_order_for_slug(
       $1, $2, $3::jsonb, 'Cliente Prueba', '+51999999999', $4::jsonb, null, null,
       'storefront', null, null, null, null, $5::jsonb) as result`,
    [
      TENANT_A.storeSlug,
      `compradora${compradorSeq}@correo.test`,
      JSON.stringify([{ product_id: productA, quantity: 2 }]),
      JSON.stringify(LIMA),
      JSON.stringify({ method_code: 'estandar' }),
    ],
  )
  return { id: String(row?.result.order_id), number: String(row?.result.order_number) }
}

/** La guía, por la puerta que ya existía: POST /v1/orders/{n}/status + shipment. */
async function ship(number: string, tracking: string): Promise<string> {
  await svc(`select public.api_order_update($1, $2, null, $3::jsonb)`, [
    clientA,
    number,
    JSON.stringify({ shipment: { tracking_number: tracking, carrier: 'courier-local' } }),
  ])
  const [row] = await svc<{ id: string }>(
    `select id from public.shipments where tracking_number = $1`,
    [tracking],
  )
  return String(row?.id)
}

async function rejects(run: () => Promise<unknown>, pattern: RegExp): Promise<void> {
  expect(await expectFailure(run)).toMatch(pattern)
}

async function events(aggregateId: string, type: string): Promise<Row[]> {
  return svc(
    `select * from public.domain_events where aggregate_id = $1 and event_type = $2 order by created_at`,
    [aggregateId, type],
  )
}

async function outboxFor(eventType: string, aggregateId: string): Promise<Record<string, unknown>[]> {
  const rows = await svc<{ payload: Record<string, unknown> }>(
    `select o.payload
       from public.integration_outbox o
      where o.operation = 'event.publish'
        and o.payload ->> 'event_type' = $1
        and o.payload #>> '{aggregate,id}' = $2
      order by o.created_at`,
    [eventType, aggregateId],
  )
  return rows.map((r) => r.payload)
}

beforeAll(async () => {
  db = await createTestDatabase()
  storeA = await bootstrap(TENANT_A)
  storeB = await bootstrap(TENANT_B)
  await vaciarPagosYEntregas(db, [storeA, storeB])

  const [product] = await svc(
    `insert into public.products
       (organization_id, company_id, store_id, sku, slug, name, price, currency, stock,
        status, published_at, shipping_weight)
     values ($1, $2, $3, 'SKU-ERP', 'sku-erp', 'Producto ERP', 100.00, 'PEN', 500,
             'published', now(), 1.000)
     returning id`,
    [TENANT_A.organizationId, TENANT_A.companyId, storeA],
  )
  productA = String(product?.id)

  const [zona] = await svc(
    `insert into public.delivery_zones
       (organization_id, company_id, store_id, code, name, country, regions, postal_prefixes)
     values ($1, $2, $3, 'lima', 'Lima', 'PE', array['Lima'], array['150'])
     returning id`,
    [TENANT_A.organizationId, TENANT_A.companyId, storeA],
  )
  const [metodo] = await svc(
    `insert into public.delivery_methods
       (organization_id, company_id, store_id, code, strategy, display_name,
        lead_time_min_days, lead_time_max_days, is_active)
     values ($1, $2, $3, 'estandar', 'ship', 'Envio estandar', 1, 3, true)
     returning id`,
    [TENANT_A.organizationId, TENANT_A.companyId, storeA],
  )
  await svc(
    `insert into public.delivery_rates
       (organization_id, company_id, store_id, delivery_method_id, zone_id, currency,
        base_amount, free_over_subtotal)
     values ($1, $2, $3, $4, $5, 'PEN', 15.00, 500.00)`,
    [TENANT_A.organizationId, TENANT_A.companyId, storeA, metodo?.id, zona?.id],
  )

  for (const tenant of [TENANT_A, TENANT_B]) {
    await svc(
      `select public.sync_platform_context($1, $2, true, $3, 'hub'::public.entitlement_source, null)`,
      [tenant.organizationId, tenant.companyId, [ENTITLEMENT, 'ecommerce.fulfillment']],
    )
  }

  clientA = await credential(TENANT_A, ['order.read', 'order.create', 'order.update'])
  readOnlyA = await credential(TENANT_A, ['order.read'])
  clientB = await credential(TENANT_B, ['order.read', 'order.update'])

  // Un destino de webhooks de A suscrito a pedidos y envíos, por la misma
  // puerta que el backoffice.
  const [endpoint] = await asUser<{ id: string }>(
    claimsFor(TENANT_A),
    `insert into public.webhook_endpoints (name, url, secret_ref, organization_id, company_id)
     values ('erp-principal', 'https://erp.cliente.test/hooks', 'EBIM_WEBHOOK_SECRET_ERP', $1, $2)
     returning id`,
    [TENANT_A.organizationId, TENANT_A.companyId],
  )
  for (const eventType of ['order.*', 'shipment.*']) {
    await asUser(
      claimsFor(TENANT_A),
      `insert into public.webhook_subscriptions (organization_id, company_id, endpoint_id, event_type)
       values ($1, $2, $3, $4)`,
      [TENANT_A.organizationId, TENANT_A.companyId, endpoint?.id, eventType],
    )
  }
}, 180_000)

afterAll(async () => {
  await db?.close()
})

// ---------------------------------------------------------------------------

describe('order.created para todo pedido', () => {
  it('un pedido creado por la API avisa, y una sola vez', async () => {
    const [row] = await svc<{ data: { number: string } }>(
      `select public.api_order_create($1, $2::jsonb) as data`,
      [
        clientA,
        JSON.stringify({
          customer: { email: 'compras@cliente.test', name: 'Cliente' },
          items: [{ sku: 'SKU-ERP', quantity: 1 }],
          shipping_address: LIMA,
        }),
      ],
    )
    const [order] = await svc<{ id: string }>(`select id from public.orders where order_number = $1`, [
      row?.data.number,
    ])
    expect(await events(String(order?.id), 'order.created')).toHaveLength(1)
  })

  it('un pedido del hub (create_order_for_slug) también avisa', async () => {
    const order = await place()
    expect(await events(order.id, 'order.created')).toHaveLength(1)
  })

  it('si la vitrina ya publicó el suyo en la misma transacción, no se repite', async () => {
    compradorSeq += 1
    await svc(`
      do $$
      declare v jsonb;
      begin
        v := public.create_order_for_slug(
          '${TENANT_A.storeSlug}', 'unico${compradorSeq}@correo.test',
          jsonb_build_array(jsonb_build_object('product_id', '${productA}'::uuid, 'quantity', 1)),
          null, null, '${JSON.stringify(LIMA)}'::jsonb, null, null, 'storefront',
          null, null, null, null, null);
        perform ebim.publish_event(
          '${TENANT_A.organizationId}'::uuid, '${TENANT_A.companyId}'::uuid, '${storeA}'::uuid,
          'order.created', 'order', (v ->> 'order_id')::uuid,
          '{"desde":"vitrina"}'::jsonb, 'order.created:vitrina:' || (v ->> 'order_id'));
      end $$;`)
    const [last] = await svc<{ id: string }>(
      `select id from public.orders where customer_email = $1`,
      [`unico${compradorSeq}@correo.test`],
    )
    const published = await events(String(last?.id), 'order.created')
    expect(published).toHaveLength(1)
    expect((published[0]?.payload as Row).desde).toBe('vitrina')
  })
})

describe('sobre versionado', () => {
  it('schema_version, aggregate.version y data.order igual a la API', async () => {
    const order = await place()
    const [message] = await outboxFor('order.created', order.id)
    expect(isWebhookEnvelope(message)).toBe(true)
    expect(message?.schema_version).toBe(2)
    expect(message?.aggregate).toMatchObject({ type: 'order', id: order.id, version: 1 })

    const snapshot = (message?.data as { order: Row }).order
    const [api] = await svc<{ data: Row }>(`select public.api_order_get($1, $2) as data`, [
      clientA,
      order.number,
    ])
    expect(api?.data).toEqual(snapshot)
  })

  it('editar el pedido avisa order.updated con lo que cambió, en la versión siguiente', async () => {
    const order = await place()
    await svc(`update public.orders set notes = 'Tocar timbre' where id = $1`, [order.id])
    const updated = await events(order.id, 'order.updated')
    expect(updated).toHaveLength(1)
    expect((updated[0]?.payload as Row).changed).toEqual(['notes'])

    const [message] = await outboxFor('order.updated', order.id)
    expect(((message?.data as Row).order as Row).notes).toBe('Tocar timbre')
    const [count] = await svc<{ n: number }>(
      `select count(*)::int as n from public.domain_events where aggregate_type = 'order' and aggregate_id = $1`,
      [order.id],
    )
    expect((message?.aggregate as Row).version).toBe(count?.n)
  })

  it('un cambio que no es de contenido no avisa order.updated', async () => {
    const order = await place()
    await svc(`update public.orders set notes = notes where id = $1`, [order.id])
    expect(await events(order.id, 'order.updated')).toHaveLength(0)
  })
})

describe('envíos', () => {
  it('la guía del ERP avisa UNA vez shipment.created, con el pedido completo', async () => {
    const order = await place()
    const shipmentId = await ship(order.number, 'TRK-0001')
    expect(await events(shipmentId, 'shipment.created')).toHaveLength(1)
    expect(await events(shipmentId, 'shipment.updated')).toHaveLength(0)

    const [message] = await outboxFor('shipment.created', shipmentId)
    expect(message?.aggregate).toMatchObject({ type: 'shipment', id: shipmentId, version: 1 })
    const data = message?.data as Row
    expect(data).toMatchObject({ tracking_number: 'TRK-0001', order_number: order.number })
    expect((data.order as Row).number).toBe(order.number)
  })

  it('reenviar la misma guía con más datos avisa shipment.updated', async () => {
    const order = await place()
    const shipmentId = await ship(order.number, 'TRK-0002')
    await svc(`select public.api_order_update($1, $2, null, $3::jsonb)`, [
      clientA,
      order.number,
      JSON.stringify({ shipment: { tracking_number: 'TRK-0002', estimated_delivery: '2026-12-01' } }),
    ])
    const updates = await events(shipmentId, 'shipment.updated')
    expect(updates).toHaveLength(1)
    expect((updates[0]?.payload as Row).changed).toEqual(['estimated_delivery'])
  })
})

describe('POST /v1/orders/{number}/tracking', () => {
  it('entrega el envío, es idempotente y avisa shipment.updated', async () => {
    const order = await place()
    const shipmentId = await ship(order.number, 'TRK-0003')
    const body = JSON.stringify({
      tracking_number: 'TRK-0003',
      events: [{ id: 'e-1', status: 'delivered', occurred_at: '2026-11-28T11:42:00Z', location: 'Lima' }],
    })

    const [first] = await svc<{ data: Row }>(
      `select public.api_order_tracking_add($1, $2, null, $3::jsonb) as data`,
      [clientA, order.number, body],
    )
    expect(first?.data.number).toBe(order.number)
    expect(first?.data.tracking).toMatchObject({ accepted: 1, duplicated: 0 })
    const ful = (first?.data.fulfillments as Row[])[0] as Row
    expect((ful.shipments as Row[])[0]).toMatchObject({ tracking_number: 'TRK-0003', state: 'delivered' })

    const [repeat] = await svc<{ data: Row }>(
      `select public.api_order_tracking_add($1, $2, null, $3::jsonb) as data`,
      [clientA, order.number, body],
    )
    expect(repeat?.data.tracking).toMatchObject({ accepted: 0, duplicated: 1 })

    const updates = await events(shipmentId, 'shipment.updated')
    expect(updates.length).toBeGreaterThanOrEqual(1)
    expect((updates.at(-1)?.payload as Row).to).toBe('delivered')
  })

  it('rechaza con código de dominio lo que no cuadra', async () => {
    const order = await place()
    await ship(order.number, 'TRK-0004')
    const call = (payload: unknown) =>
      svc(`select public.api_order_tracking_add($1, $2, null, $3::jsonb)`, [
        clientA,
        order.number,
        JSON.stringify(payload),
      ])
    await rejects(() => call({ events: [{ status: 'delivered' }] }), /GUIA_REQUERIDA/)
    await rejects(() => call({ tracking_number: 'TRK-0004', events: [] }), /EVENTOS_REQUERIDOS/)
    await rejects(() => call({ tracking_number: 'NO-EXISTE', events: [{ status: 'delivered' }] }), /ENVIO_NO_ENCONTRADO/)
    await rejects(() => call({ tracking_number: 'TRK-0004', events: [{ status: 'volando' }] }), /ESTADO_NO_VALIDO/)
    await rejects(() => call({ tracking_number: 'TRK-0004', otro: 1, events: [{ status: 'info' }] }), /CAMPO_NO_PERMITIDO/)
    await rejects(
      () => call({ tracking_number: 'TRK-0004', events: [{ status: 'info', sorpresa: true }] }),
      /CAMPO_NO_PERMITIDO/,
    )
  })

  it('sin el scope order.update no se escribe', async () => {
    const order = await place()
    await ship(order.number, 'TRK-0005')
    await rejects(
      () =>
        svc(`select public.api_order_tracking_add($1, $2, null, $3::jsonb)`, [
          readOnlyA,
          order.number,
          JSON.stringify({ tracking_number: 'TRK-0005', events: [{ status: 'delivered' }] }),
        ]),
      /SCOPE_INSUFICIENTE/,
    )
  })

  it('la credencial de otro tenant no encuentra el pedido', async () => {
    const order = await place()
    await ship(order.number, 'TRK-0006')
    await rejects(
      () =>
        svc(`select public.api_order_tracking_add($1, $2, null, $3::jsonb)`, [
          clientB,
          order.number,
          JSON.stringify({ tracking_number: 'TRK-0006', events: [{ status: 'delivered' }] }),
        ]),
      /(PEDIDO_NO_ENCONTRADO|TIENDA)/,
    )
    const [row] = await svc<{ state: string }>(
      `select state::text from public.shipments where tracking_number = 'TRK-0006'`,
    )
    expect(row?.state).not.toBe('delivered')
  })

  it('el navegador no ejecuta la función de la API', async () => {
    const order = await place()
    await rejects(
      () =>
        asUser(claimsFor(TENANT_A), `select public.api_order_tracking_add($1, $2, null, $3::jsonb)`, [
          clientA,
          order.number,
          JSON.stringify({ tracking_number: 'X', events: [{ status: 'info' }] }),
        ]),
      /permission denied/,
    )
  })
})
