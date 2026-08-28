// @vitest-environment node
/**
 * P14-SaaS · webhooks salientes contra Postgres real.
 *
 * Lo que no puede fallar:
 *
 *  - un destino solo puede ser `https` y una dirección PÚBLICA: el CHECK es
 *    defensa contra SSRF, no cosmética;
 *  - el secreto no se guarda: se guarda el NOMBRE de su variable;
 *  - un hecho de dominio se reparte solo a quien lo pidió, y el comodín de
 *    dominio (`order.*`) es de dominio, no universal;
 *  - **el mismo hecho no se entrega dos veces**: la identidad del evento es la
 *    del hecho de dominio, que ya es idempotente;
 *  - **el fan-out no puede tumbar una venta**: cuelga de la transacción del
 *    pedido, así que lo que falla queda como incidente y no como excepción;
 *  - reproducir exige rol, módulo y motivo, conserva el `event_id` y firma
 *    quién lo ordenó;
 *  - el disyuntor es POR endpoint: uno roto no corta la entrega a los sanos;
 *  - un tenant no ve ni toca los destinos del otro.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import {
  TENANT_A,
  TENANT_B,
  asRole,
  claimsFor,
  createTestDatabase,
  expectFailure,
} from './harness.ts'
import { isWebhookEnvelope } from '../../src/domain/ports/webhook.ts'

type Row = Record<string, unknown>

let db: PGlite
const ENTITLEMENT = 'ecommerce.integrations.enterprise'
const VIEWER_USER = '0a000000-0000-4000-8000-0000000000e1'
let storeA = ''

async function svc<T = Row>(query: string, params: unknown[] = []): Promise<T[]> {
  return asRole(db, 'service_role', null, async () => (await db.query<T>(query, params)).rows)
}

async function asUser<T = Row>(
  tenant: typeof TENANT_A,
  query: string,
  params: unknown[] = [],
  overrides: Parameters<typeof claimsFor>[1] = {},
): Promise<T[]> {
  return asRole(db, 'authenticated', claimsFor(tenant, overrides), async () => {
    return (await db.query<T>(query, params)).rows
  })
}

async function sync(tenant: typeof TENANT_A, entitlements: string[]): Promise<void> {
  await svc(
    `select public.sync_platform_context($1, $2, true, $3, 'hub'::public.entitlement_source, null)`,
    [tenant.organizationId, tenant.companyId, entitlements],
  )
}

/** Alta de destino POR LA MISMA PUERTA que usa el backoffice: RLS, no service_role. */
async function createEndpoint(
  tenant: typeof TENANT_A,
  name: string,
  events: string[],
  url = 'https://erp.cliente.test/hooks/ebim',
): Promise<string> {
  const [row] = await asUser<{ id: string }>(
    tenant,
    `insert into public.webhook_endpoints (name, url, secret_ref, organization_id, company_id)
     values ($1, $2, 'EBIM_WEBHOOK_SECRET_ERP', $3, $4)
     returning id`,
    [name, url, tenant.organizationId, tenant.companyId],
  )
  const id = String(row?.id)
  for (const eventType of events) {
    await asUser(
      tenant,
      `insert into public.webhook_subscriptions
         (organization_id, company_id, endpoint_id, event_type)
       values ($1, $2, $3, $4)`,
      [tenant.organizationId, tenant.companyId, id, eventType],
    )
  }
  return id
}

async function publish(
  tenant: typeof TENANT_A,
  eventType: string,
  dedupeKey: string,
  payload: Record<string, unknown> = { n: 1 },
): Promise<string> {
  const [row] = await svc<{ id: string }>(
    `select ebim.publish_event($1, $2, null, $3, 'order', null, $4::jsonb, $5) as id`,
    [tenant.organizationId, tenant.companyId, eventType, JSON.stringify(payload), dedupeKey],
  )
  return String(row?.id)
}

beforeAll(async () => {
  db = await createTestDatabase()
  await asRole(db, 'service_role', null, async () => {
    for (const tenant of [TENANT_A, TENANT_B]) {
      await db.query(`select public.bootstrap_tenant($1, $2, $3, $4, $5, $6, $7, $8, 'PEN')`, [
        tenant.organizationId,
        tenant.companyId,
        tenant.slug,
        `Cuenta ${tenant.slug}`,
        tenant.adminEmail,
        tenant.ownerId,
        tenant.storeSlug,
        `Tienda ${tenant.slug}`,
      ])
    }
    await db.query(
      `insert into public.tenant_members (organization_id, company_id, user_id, email, role)
       values ($1, $2, $3, 'lector@tenant-a.com', 'viewer')`,
      [TENANT_A.organizationId, TENANT_A.companyId, VIEWER_USER],
    )
  })
  await svc(`update public.stores set status = 'active'`)
  const [store] = await svc<{ id: string }>(`select id from public.stores where slug = $1`, [
    TENANT_A.storeSlug,
  ])
  storeA = String(store?.id)
}, 180_000)

beforeEach(async () => {
  await svc(`delete from public.webhook_deliveries`)
  await svc(`delete from public.webhook_subscriptions`)
  await svc(`delete from public.webhook_endpoints`)
  await svc(`delete from public.integration_messages`)
  await svc(`delete from public.integration_outbox`)
  await svc(`delete from public.integration_circuit`)
  await svc(`delete from public.domain_events`)
  await svc(`delete from public.tenant_integrations where provider_code = 'webhook'`)
  await sync(TENANT_A, [ENTITLEMENT])
  await sync(TENANT_B, [ENTITLEMENT])
})

afterAll(async () => {
  await db?.close()
})

// ---------------------------------------------------------------------------

describe('el destino', () => {
  it('crear un endpoint HABILITA el transporte de la sociedad', async () => {
    await createEndpoint(TENANT_A, 'erp', ['order.created'])
    const [row] = await svc<{ is_active: boolean }>(
      `select is_active from public.tenant_integrations
        where organization_id = $1 and provider_code = 'webhook'`,
      [TENANT_A.organizationId],
    )
    expect(row?.is_active).toBe(true)
  })

  it('solo https: un destino en claro se rechaza en la BASE', async () => {
    const message = await expectFailure(() =>
      createEndpoint(TENANT_A, 'inseguro', [], 'http://erp.cliente.test/hooks'),
    )
    expect(message).toMatch(/webhook_endpoints_url_https|violates check/i)
  })

  /**
   * El trabajador entrega con credenciales de servidor y desde dentro de la red
   * del proyecto: un destino apuntando al enlace-local sería pedirnos que
   * leamos metadatos de la instancia y se los mandemos firmados.
   */
  it('ninguna direccion privada, de bucle local ni de enlace-local', async () => {
    const prohibidas = [
      'https://localhost/hooks',
      'https://127.0.0.1/hooks',
      'https://10.0.0.5/hooks',
      'https://192.168.1.10/hooks',
      'https://169.254.169.254/latest/meta-data',
      'https://172.16.0.1/hooks',
      'https://erp.internal/hooks',
    ]
    for (const url of prohibidas) {
      const message = await expectFailure(() => createEndpoint(TENANT_A, 'malo', [], url))
      expect(`${url}: ${message}`).toMatch(/webhook_endpoints_url_public|violates check/i)
    }
  })

  it('el secreto NO se guarda: se guarda el nombre de su variable', async () => {
    const id = await createEndpoint(TENANT_A, 'erp', [])
    const [row] = await svc<{ secret_ref: string }>(
      `select secret_ref from public.webhook_endpoints where id = $1`,
      [id],
    )
    expect(row?.secret_ref).toBe('EBIM_WEBHOOK_SECRET_ERP')

    const columnas = await svc<{ column_name: string }>(`
      select column_name from information_schema.columns
       where table_schema = 'public' and table_name = 'webhook_endpoints'
    `)
    expect(columnas.map((c) => c.column_name)).not.toContain('secret')
  })

  it('sin el addon contratado no se puede dar de alta un destino', async () => {
    await sync(TENANT_A, [])
    const message = await expectFailure(() => createEndpoint(TENANT_A, 'erp', []))
    expect(message).toMatch(/row-level security|permission denied/i)
  })

  it('un viewer no da de alta destinos', async () => {
    const message = await expectFailure(() =>
      asUser(
        TENANT_A,
        `insert into public.webhook_endpoints (name, url, secret_ref, organization_id, company_id)
         values ('erp', 'https://erp.cliente.test/h', 'EBIM_X', $1, $2)`,
        [TENANT_A.organizationId, TENANT_A.companyId],
        {
          sub: VIEWER_USER,
          email: 'lector@tenant-a.com',
          companies: [{ id: TENANT_A.companyId, role: 'viewer' }],
        },
      ),
    )
    expect(message).toMatch(/row-level security|permission denied/i)
  })

  it('anon no ve ni toca ninguna de las tres tablas', async () => {
    for (const table of ['webhook_endpoints', 'webhook_subscriptions', 'webhook_deliveries']) {
      const message = await expectFailure(() =>
        asRole(db, 'anon', null, async () => db.query(`select * from public.${table}`)),
      )
      expect(`${table}: ${message}`).toMatch(/permission denied/i)
    }
  })
})

describe('el reparto', () => {
  it('entrega solo a quien se suscribio a ese hecho', async () => {
    const pedidos = await createEndpoint(TENANT_A, 'erp-pedidos', ['order.created'])
    await createEndpoint(TENANT_A, 'erp-cobros', ['payment.captured'])

    await publish(TENANT_A, 'order.created', 'pedido-0001')

    const rows = await svc<{ endpoint_id: string }>(
      `select endpoint_id from public.webhook_deliveries`,
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]?.endpoint_id).toBe(pedidos)
  })

  it('el comodin es de DOMINIO, no universal', async () => {
    await createEndpoint(TENANT_A, 'erp-todo-pedidos', ['order.*'])

    await publish(TENANT_A, 'order.created', 'pedido-0002')
    await publish(TENANT_A, 'order.cancelled', 'pedido-0003')
    await publish(TENANT_A, 'payment.captured', 'cobro-0001')

    const rows = await svc<{ event_type: string }>(
      `select event_type from public.webhook_deliveries order by event_type`,
    )
    expect(rows.map((r) => r.event_type)).toEqual(['order.cancelled', 'order.created'])
  })

  it('el mensaje lleva la IDENTIDAD del evento, que es la del hecho de dominio', async () => {
    await createEndpoint(TENANT_A, 'erp', ['order.created'])
    const eventId = await publish(TENANT_A, 'order.created', 'pedido-0004')

    const [delivery] = await svc<{ event_id: string; outbox_id: string }>(
      `select event_id, outbox_id from public.webhook_deliveries`,
    )
    expect(delivery?.event_id).toBe(eventId)

    const [outbox] = await svc<{ payload: Row; target: string; operation: string }>(
      `select payload, target, operation from public.integration_outbox where id = $1`,
      [delivery?.outbox_id],
    )
    expect(outbox?.operation).toBe('event.publish')
    expect(outbox?.payload.event_id).toBe(eventId)
    expect(outbox?.payload.event_type).toBe('order.created')
    // El SOBRE tiene la forma que el contrato publicado promete: sin esto, el
    // contrato de `src/domain/ports/webhook.ts` sería un comentario.
    expect(isWebhookEnvelope(outbox?.payload)).toBe(true)
  })

  /**
   * La propiedad que hace innecesaria toda disciplina: la identidad del evento
   * es la del hecho de dominio, y `domain_events` ya deduplica por
   * `dedupe_key`. Republicar el mismo hecho no entrega dos veces.
   */
  it('republicar el MISMO hecho no entrega dos veces', async () => {
    await createEndpoint(TENANT_A, 'erp', ['order.created'])
    const primera = await publish(TENANT_A, 'order.created', 'pedido-0005')
    const segunda = await publish(TENANT_A, 'order.created', 'pedido-0005')

    expect(segunda).toBe(primera)
    const rows = await svc(`select id from public.webhook_deliveries`)
    expect(rows).toHaveLength(1)
  })

  it('los datos de TARJETA no salen del sistema, ni siquiera hacia el propio tenant', async () => {
    await createEndpoint(TENANT_A, 'erp', ['order.created'])
    await publish(TENANT_A, 'order.created', 'pedido-0006', {
      total: '100.00',
      card_number: '4111111111111111',
      cvv: '123',
    })

    const [outbox] = await svc<{ payload: Row }>(
      `select payload from public.integration_outbox`,
    )
    const data = outbox?.payload.data as Row
    expect(data.total).toBe('100.00')
    expect(String(data.card_number)).not.toContain('4111')
    expect(String(data.cvv)).not.toBe('123')
  })

  it('sin transporte habilitado no hay entregas, y tampoco error', async () => {
    await createEndpoint(TENANT_A, 'erp', ['order.created'])
    await svc(
      `update public.tenant_integrations set is_active = false
        where organization_id = $1 and provider_code = 'webhook'`,
      [TENANT_A.organizationId],
    )

    const eventId = await publish(TENANT_A, 'order.created', 'pedido-0007')
    expect(eventId).toBeTruthy()
    expect(await svc(`select id from public.webhook_deliveries`)).toHaveLength(0)
  })

  /**
   * La prueba que protege la venta. El fan-out cuelga de un trigger sobre
   * `domain_events`, y `domain_events` se escribe DENTRO de la transacción del
   * pedido: una excepción aquí tumbaría la compra.
   */
  it('si encolar falla, el HECHO se publica igual y queda un incidente', async () => {
    await createEndpoint(TENANT_A, 'erp', ['order.created'])
    // Se le retira al conector la operación que declara: encolar levantará.
    await svc(`update public.integration_providers set capabilities = '{}' where code = 'webhook'`)

    try {
      const eventId = await publish(TENANT_A, 'order.created', 'pedido-0008')
      expect(eventId).toBeTruthy()

      expect(await svc(`select id from public.webhook_deliveries`)).toHaveLength(0)

      const incidentes = await svc<{ code: string; kind: string }>(
        `select code, kind::text as kind from public.ops_events where code = 'WEBHOOK_NO_ENCOLADO'`,
      )
      expect(incidentes).toHaveLength(1)
      expect(incidentes[0]?.kind).toBe('integration_failed')
    } finally {
      await svc(
        `update public.integration_providers set capabilities = '{event.publish}'
          where code = 'webhook'`,
      )
    }
  })

  it('un destino desactivado deja de recibir', async () => {
    const id = await createEndpoint(TENANT_A, 'erp', ['order.created'])
    await asUser(TENANT_A, `update public.webhook_endpoints set is_active = false where id = $1`, [
      id,
    ])
    await publish(TENANT_A, 'order.created', 'pedido-0009')
    expect(await svc(`select id from public.webhook_deliveries`)).toHaveLength(0)
  })
})

describe('el disyuntor es POR destino', () => {
  it('un endpoint roto no corta la entrega a los sanos', async () => {
    const roto = await createEndpoint(TENANT_A, 'erp-roto', ['order.created'])
    const sano = await createEndpoint(
      TENANT_A,
      'erp-sano',
      ['order.created'],
      'https://otro.cliente.test/hooks',
    )
    await publish(TENANT_A, 'order.created', 'pedido-0010')

    // Circuito abierto SOLO para el destino roto.
    await svc(
      `insert into public.integration_circuit
         (organization_id, company_id, provider_code, operation, target, state, opened_at)
       values ($1, $2, 'webhook', 'event.publish', $3, 'open', now())`,
      [TENANT_A.organizationId, TENANT_A.companyId, roto],
    )

    const claimed = await svc<{ target: string }>(
      `select target from public.integration_claim('webhook', 'w1', 10)`,
    )
    expect(claimed.map((row) => row.target)).toEqual([sano])
  })
})

describe('reproducir', () => {
  async function seedDelivery(): Promise<string> {
    await createEndpoint(TENANT_A, 'erp', ['order.created'])
    await publish(TENANT_A, 'order.created', 'pedido-replay')
    const [row] = await svc<{ id: string }>(`select id from public.webhook_deliveries`)
    return String(row?.id)
  }

  it('conserva el event_id y crea un mensaje NUEVO', async () => {
    const original = await seedDelivery()
    const [before] = await svc<{ event_id: string }>(
      `select event_id from public.webhook_deliveries where id = $1`,
      [original],
    )

    const [result] = await asUser<{ data: Row }>(
      TENANT_A,
      `select public.webhook_replay($1, 'el ERP perdio el aviso') as data`,
      [original],
    )
    expect(result?.data.event_id).toBe(before?.event_id)

    const deliveries = await svc<{ id: string; replay_of: string | null; event_id: string }>(
      `select id, replay_of, event_id from public.webhook_deliveries order by created_at`,
    )
    expect(deliveries).toHaveLength(2)
    expect(deliveries[1]?.replay_of).toBe(original)
    expect(deliveries[1]?.event_id).toBe(before?.event_id)

    const outbox = await svc(`select id from public.integration_outbox`)
    expect(outbox).toHaveLength(2)
  })

  it('exige motivo', async () => {
    const original = await seedDelivery()
    const message = await expectFailure(() =>
      asUser(TENANT_A, `select public.webhook_replay($1, '  ')`, [original]),
    )
    expect(message).toMatch(/MOTIVO_REQUERIDO/)
  })

  it('un viewer no puede reproducir', async () => {
    const original = await seedDelivery()
    const message = await expectFailure(() =>
      asUser(TENANT_A, `select public.webhook_replay($1, 'porque si')`, [original], {
        sub: VIEWER_USER,
        email: 'lector@tenant-a.com',
        companies: [{ id: TENANT_A.companyId, role: 'viewer' }],
      }),
    )
    expect(message).toMatch(/SIN_PERMISO/)
  })

  it('sin el addon tampoco', async () => {
    const original = await seedDelivery()
    await sync(TENANT_A, [])
    const message = await expectFailure(() =>
      asUser(TENANT_A, `select public.webhook_replay($1, 'porque si')`, [original]),
    )
    expect(message).toMatch(/SIN_MODULO/)
  })

  it('el tenant de al lado no puede reproducir una entrega ajena', async () => {
    const original = await seedDelivery()
    const message = await expectFailure(() =>
      asUser(TENANT_B, `select public.webhook_replay($1, 'curioseando')`, [original]),
    )
    expect(message).toMatch(/SIN_PERMISO/)
  })

  it('queda registrado quien lo ordeno y por que', async () => {
    const original = await seedDelivery()
    await asUser(TENANT_A, `select public.webhook_replay($1, 'el ERP perdio el aviso')`, [original])

    const [row] = await svc<{ action: string; metadata: Row; actor_email: string }>(
      `select action, metadata, actor_email from public.audit_log
        where action = 'webhook_delivery.replayed'`,
    )
    expect(row?.actor_email).toBe(TENANT_A.adminEmail)
    expect(row?.metadata.reason).toBe('el ERP perdio el aviso')

    const [delivery] = await svc<{ replayed_by: string; replay_reason: string }>(
      `select replayed_by, replay_reason from public.webhook_deliveries where replay_of is not null`,
    )
    expect(delivery?.replayed_by).toBe(TENANT_A.ownerId)
    expect(delivery?.replay_reason).toBe('el ERP perdio el aviso')
  })

  it('un destino desactivado no se puede reproducir', async () => {
    const original = await seedDelivery()
    await svc(`update public.webhook_endpoints set is_active = false`)
    const message = await expectFailure(() =>
      asUser(TENANT_A, `select public.webhook_replay($1, 'a ver si cuela')`, [original]),
    )
    expect(message).toMatch(/ENDPOINT_INACTIVO/)
  })
})

describe('aislamiento entre tenants', () => {
  it('cada sociedad ve solo sus destinos, suscripciones y entregas', async () => {
    await createEndpoint(TENANT_A, 'erp-a', ['order.created'])
    await createEndpoint(TENANT_B, 'erp-b', ['order.created'])
    await publish(TENANT_A, 'order.created', 'pedido-a')
    await publish(TENANT_B, 'order.created', 'pedido-b')

    const endpoints = await asUser<{ name: string }>(
      TENANT_A,
      `select name from public.webhook_endpoints`,
    )
    expect(endpoints.map((row) => row.name)).toEqual(['erp-a'])

    const deliveries = await asUser(TENANT_A, `select id from public.webhook_deliveries`)
    expect(deliveries).toHaveLength(1)

    const subs = await asUser(TENANT_A, `select id from public.webhook_subscriptions`)
    expect(subs).toHaveLength(1)
  })

  it('un tenant no puede colgar una suscripcion del destino del otro', async () => {
    const deB = await createEndpoint(TENANT_B, 'erp-b', [])
    const message = await expectFailure(() =>
      asUser(
        TENANT_A,
        `insert into public.webhook_subscriptions
           (organization_id, company_id, endpoint_id, event_type)
         values ($1, $2, $3, 'order.created')`,
        [TENANT_A.organizationId, TENANT_A.companyId, deB],
      ),
    )
    // La FK compuesta (endpoint, org, company) lo impide ANTES que la RLS: una
    // fila hija no puede declarar un tenant distinto al de su padre.
    expect(message).toMatch(/foreign key|row-level security|violates/i)
  })

  it('el hecho de una sociedad no llega al destino de la otra', async () => {
    await createEndpoint(TENANT_B, 'erp-b', ['order.created'])
    await publish(TENANT_A, 'order.created', 'pedido-cruzado')
    expect(await svc(`select id from public.webhook_deliveries`)).toHaveLength(0)
  })

  it('las entregas no se escriben a mano desde el navegador', async () => {
    const id = await createEndpoint(TENANT_A, 'erp', [])
    const message = await expectFailure(() =>
      asUser(
        TENANT_A,
        `insert into public.webhook_deliveries
           (organization_id, company_id, endpoint_id, event_id, event_type)
         values ($1, $2, $3, gen_random_uuid(), 'order.created')`,
        [TENANT_A.organizationId, TENANT_A.companyId, id],
      ),
    )
    expect(message).toMatch(/permission denied/i)
  })
})

describe('el hilo', () => {
  it('la entrega y su mensaje aparecen en el rastro del incidente', async () => {
    await createEndpoint(TENANT_A, 'erp', ['order.created'])

    const correlation = 'ec-hilo-de-prueba-0001'
    await asRole(db, 'service_role', null, async () => {
      await db.query(`select set_config('ebim.correlation_id', $1, false)`, [correlation])
      await db.query(
        `select ebim.publish_event($1, $2, $3, 'order.created', 'order', null, '{}'::jsonb, $4)`,
        [TENANT_A.organizationId, TENANT_A.companyId, storeA, 'pedido-hilo'],
      )
      await db.query(`select set_config('ebim.correlation_id', '', false)`)
    })

    const pasos = await asUser<{ domain: string }>(
      TENANT_A,
      `select domain from public.trace_by_correlation($1)`,
      [correlation],
    )
    expect(pasos.map((row) => row.domain)).toContain('webhooks')
    expect(pasos.map((row) => row.domain)).toContain('integrations')
  })
})
