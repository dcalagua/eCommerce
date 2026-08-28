// @vitest-environment node
/**
 * P14-SaaS · el MONITOR de integraciones contra Postgres real.
 *
 * La Definition of Done de la fase pide que «la operación de fallos sea visible
 * y recuperable». Eso son dos propiedades y las dos se comprueban aquí:
 *
 *  VISIBLE      la cola se ve entera con lo que hace falta para decidir
 *               —estado, intentos, próximo reintento, disyuntor, hilo y destino
 *               con nombre— y el contenido de un mensaje se puede mirar SIN que
 *               salgan datos de tarjeta, correos ni la URL con su token dentro.
 *
 *  RECUPERABLE  un mensaje muerto se reintenta y un disyuntor se cierra desde
 *               la pantalla, con permiso, con motivo y con firma en la
 *               bitácora — y una cola que el navegador pudiera reescribir no
 *               garantizaría nada, así que tampoco puede.
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

type Row = Record<string, unknown>

let db: PGlite
const ENTITLEMENT = 'ecommerce.integrations.enterprise'
const VIEWER_USER = '0a000000-0000-4000-8000-0000000000f1'

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

const viewerClaims = {
  sub: VIEWER_USER,
  email: 'lector@tenant-a.com',
  companies: [{ id: TENANT_A.companyId, role: 'viewer' }],
}

async function enqueue(
  tenant: typeof TENANT_A,
  key: string,
  payload: Record<string, unknown> = { n: 1 },
  target = '',
): Promise<string> {
  const [row] = await svc<{ id: string }>(
    `select public.integration_enqueue($1, $2, 'sap_r3', 'order.create', $3::jsonb, $4, $5) as id`,
    [tenant.organizationId, tenant.companyId, JSON.stringify(payload), key, target],
  )
  return String(row?.id)
}

/**
 * Lleva un mensaje hasta la cola muerta Y abre su disyuntor con UN fallo.
 *
 * El umbral por defecto son cinco fallos seguidos; aquí se siembra el circuito
 * con umbral 1 en vez de repetir el ciclo cinco veces, porque lo que estos
 * casos comprueban es el MONITOR y no el contador —que ya tiene sus pruebas en
 * `integration-framework.test.ts`—.
 */
async function kill(tenant: typeof TENANT_A, outboxId: string): Promise<void> {
  await svc(`update public.integration_outbox set max_attempts = 1 where id = $1`, [outboxId])
  await svc(
    `insert into public.integration_circuit
       (organization_id, company_id, provider_code, operation, target, threshold)
     values ($1, $2, 'sap_r3', 'order.create', '', 1)
     on conflict do nothing`,
    [tenant.organizationId, tenant.companyId],
  )
  await svc(`select * from public.integration_claim('sap_r3', 'w1', 10)`)
  await svc(`select public.integration_fail($1, 'el destino no contesta', 503)`, [outboxId])
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
      await db.query(
        `insert into public.tenant_integrations
           (organization_id, company_id, provider_code, is_active)
         values ($1, $2, 'sap_r3', true)`,
        [tenant.organizationId, tenant.companyId],
      )
    }
    await db.query(
      `insert into public.tenant_members (organization_id, company_id, user_id, email, role)
       values ($1, $2, $3, 'lector@tenant-a.com', 'viewer')`,
      [TENANT_A.organizationId, TENANT_A.companyId, VIEWER_USER],
    )
  })
  await svc(`update public.stores set status = 'active'`)
}, 180_000)

beforeEach(async () => {
  await svc(`delete from public.webhook_deliveries`)
  await svc(`delete from public.webhook_subscriptions`)
  await svc(`delete from public.webhook_endpoints`)
  await svc(`delete from public.integration_messages`)
  await svc(`delete from public.integration_outbox`)
  await svc(`delete from public.integration_circuit`)
  await svc(
    `select public.sync_platform_context($1, $2, true, $3, 'hub'::public.entitlement_source, null)`,
    [TENANT_A.organizationId, TENANT_A.companyId, [ENTITLEMENT]],
  )
})

afterAll(async () => {
  await db?.close()
})

// ---------------------------------------------------------------------------

describe('la cola se VE', () => {
  it('una fila trae junto todo lo que hace falta para decidir', async () => {
    const id = await enqueue(TENANT_A, 'pedido-monitor-1')
    await kill(TENANT_A, id)

    const [row] = await asUser<Row>(
      TENANT_A,
      `select status, attempts, max_attempts, next_retry_at, circuit_state, last_error,
              provider_name, target_label, is_dead, is_open, age_seconds
         from public.integration_monitor where id = $1`,
      [id],
    )
    expect(row?.status).toBe('dead')
    expect(row?.attempts).toBe(1)
    expect(row?.is_dead).toBe(true)
    expect(row?.is_open).toBe(false)
    // La EDAD la calcula el servidor: con el reloj del portátil mal puesto, un
    // mensaje de hace diez minutos parecería de hace dos horas.
    expect(typeof row?.age_seconds).toBe('number')
    expect(row?.last_error).toMatch(/no contesta/)
    expect(row?.circuit_state).toBe('open')
    expect(row?.target_label).toBeTruthy()
  })

  it('el destino de un webhook se ve con su NOMBRE, no con un uuid', async () => {
    const [endpoint] = await asUser<{ id: string }>(
      TENANT_A,
      `insert into public.webhook_endpoints (name, url, secret_ref, organization_id, company_id)
       values ('erp-pedidos', 'https://erp.cliente.test/h', 'EBIM_WEBHOOK_SECRET_ERP', $1, $2)
       returning id`,
      [TENANT_A.organizationId, TENANT_A.companyId],
    )
    await svc(
      `select public.integration_enqueue($1, $2, 'webhook', 'event.publish',
              '{"event_id":"x"}'::jsonb, 'wh:monitor-1', $3)`,
      [TENANT_A.organizationId, TENANT_A.companyId, endpoint?.id],
    )

    const [row] = await asUser<{ target_label: string }>(
      TENANT_A,
      `select target_label from public.integration_monitor where provider_code = 'webhook'`,
    )
    expect(row?.target_label).toBe('erp-pedidos')
  })

  it('un tenant no ve la cola del otro', async () => {
    await enqueue(TENANT_A, 'monitor-cola-de-a')
    await enqueue(TENANT_B, 'monitor-cola-de-b')

    const rows = await asUser<{ id: string }>(TENANT_A, `select id from public.integration_monitor`)
    expect(rows).toHaveLength(1)
  })

  it('anon no ve nada del monitor', async () => {
    for (const view of ['integration_monitor', 'webhook_monitor']) {
      const message = await expectFailure(() =>
        asRole(db, 'anon', null, async () => db.query(`select * from public.${view}`)),
      )
      expect(`${view}: ${message}`).toMatch(/permission denied/i)
    }
  })
})

describe('la salud', () => {
  it('la ven owner y admin, no cualquier miembro', async () => {
    const message = await expectFailure(() =>
      asUser(TENANT_A, `select public.integration_health()`, [], viewerClaims),
    )
    expect(message).toMatch(/SIN_PERMISO/)
  })

  /**
   * `integration_health` no acepta tenant: lo deriva del JWT. No hay parámetro
   * que validar, así que no hay nada que declarar para mirar la cola de otro.
   */
  it('no acepta tenant y solo cuenta el suyo', async () => {
    await enqueue(TENANT_A, 'salud-a-1')
    await enqueue(TENANT_A, 'salud-a-2')
    await enqueue(TENANT_B, 'salud-b-1')

    const [row] = await asUser<{ data: Row }>(TENANT_A, `select public.integration_health() as data`)
    const providers = row?.data.providers as Row[]
    const erp = providers.find((p) => p.provider_code === 'sap_r3')
    expect(erp?.pending).toBe(2)
    expect(row?.data.organization_id).toBe(TENANT_A.organizationId)

    const [args] = await svc<{ args: string }>(`
      select coalesce(array_to_string(p.proargnames, ','), '') as args
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'integration_health'
    `)
    expect(args?.args).toBe('')
  })

  it('enseña los circuitos abiertos con su destino y su umbral', async () => {
    const id = await enqueue(TENANT_A, 'salud-circuito')
    await kill(TENANT_A, id)

    const [row] = await asUser<{ data: Row }>(TENANT_A, `select public.integration_health() as data`)
    const circuits = row?.data.circuits as Row[]
    expect(circuits).toHaveLength(1)
    expect(circuits[0]?.operation).toBe('order.create')
    expect(circuits[0]?.state).toBe('open')
  })
})

describe('el detalle es SANEADO y deja testigo', () => {
  it('ni tarjeta, ni correo, ni la URL con su cadena de consulta', async () => {
    const [endpoint] = await asUser<{ id: string }>(
      TENANT_A,
      `insert into public.webhook_endpoints (name, url, secret_ref, organization_id, company_id)
       values ('erp', 'https://erp.cliente.test/hooks?token=secreto-del-cliente',
               'EBIM_WEBHOOK_SECRET_ERP', $1, $2)
       returning id`,
      [TENANT_A.organizationId, TENANT_A.companyId],
    )
    const [outbox] = await svc<{ id: string }>(
      `select public.integration_enqueue($1, $2, 'webhook', 'event.publish', $3::jsonb,
              'wh:detalle-1', $4) as id`,
      [
        TENANT_A.organizationId,
        TENANT_A.companyId,
        JSON.stringify({
          event_id: 'x',
          data: {
            total: '100.00',
            email: 'comprador@cliente.com',
            card_number: '4111111111111111',
            cvv: '123',
          },
        }),
        endpoint?.id,
      ],
    )

    const [row] = await asUser<{ data: Row }>(
      TENANT_A,
      `select public.integration_message_detail($1) as data`,
      [outbox?.id],
    )
    const payload = JSON.stringify(row?.data.payload)
    expect(payload).toContain('100.00')
    expect(payload).not.toContain('4111')
    expect(payload).not.toContain('comprador@cliente.com')

    // La URL sale sin la cadena de consulta: un `?token=` dentro es justo el
    // secreto que esta pantalla existe para no enseñar.
    expect(row?.data.target_url).toBe('https://erp.cliente.test/hooks')
  })

  it('trae la bitacora de intentos con su codigo HTTP', async () => {
    const id = await enqueue(TENANT_A, 'detalle-intentos')
    await kill(TENANT_A, id)

    const [row] = await asUser<{ data: Row }>(
      TENANT_A,
      `select public.integration_message_detail($1) as data`,
      [id],
    )
    const attempts = row?.data.attempts_log as Row[]
    expect(attempts).toHaveLength(1)
    expect(attempts[0]?.status_code).toBe(503)
    expect(attempts[0]?.succeeded).toBe(false)
  })

  /** Mirar el contenido de un mensaje es un ACTO, y tiene autor. */
  it('consultar el detalle queda registrado en la bitacora', async () => {
    const id = await enqueue(TENANT_A, 'detalle-auditado')
    await asUser(TENANT_A, `select public.integration_message_detail($1)`, [id])

    // `audit_log` es append-only para TODOS —ni `service_role` la vacía— así que
    // se busca la entrada DE ESTE mensaje, no «la única que hay».
    const rows = await svc<{ actor_email: string; entity_id: string }>(
      `select actor_email, entity_id from public.audit_log
        where action = 'integration_message.inspected' and entity_id = $1`,
      [id],
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]?.actor_email).toBe(TENANT_A.adminEmail)
  })

  it('un viewer no puede mirar el contenido de un mensaje', async () => {
    const id = await enqueue(TENANT_A, 'detalle-denegado')
    const message = await expectFailure(() =>
      asUser(TENANT_A, `select public.integration_message_detail($1)`, [id], viewerClaims),
    )
    expect(message).toMatch(/SIN_PERMISO/)
  })

  it('el tenant de al lado tampoco', async () => {
    const id = await enqueue(TENANT_B, 'detalle-ajeno')
    const message = await expectFailure(() =>
      asUser(TENANT_A, `select public.integration_message_detail($1)`, [id]),
    )
    expect(message).toMatch(/SIN_PERMISO/)
  })
})

describe('la cola es RECUPERABLE', () => {
  it('la cola NO se puede reescribir desde el navegador', async () => {
    const id = await enqueue(TENANT_A, 'inmutable')
    for (const query of [
      `update public.integration_outbox set status = 'succeeded' where id = $1`,
      `delete from public.integration_outbox where id = $1`,
      `insert into public.integration_outbox
         (organization_id, company_id, provider_code, operation, idempotency_key)
       values ($1, $1, 'sap_r3', 'order.create', 'a-mano-0001')`,
    ]) {
      const message = await expectFailure(() => asUser(TENANT_A, query, [id]))
      expect(message).toMatch(/permission denied/i)
    }
  })

  it('reintentar devuelve el mensaje a la cola SIN borrar los intentos gastados', async () => {
    const id = await enqueue(TENANT_A, 'reintento-1')
    await kill(TENANT_A, id)

    await asUser(TENANT_A, `select public.integration_retry($1, 'el destino ya responde')`, [id])

    const [row] = await svc<{ status: string; attempts: number; max_attempts: number }>(
      `select status::text as status, attempts, max_attempts
         from public.integration_outbox where id = $1`,
      [id],
    )
    expect(row?.status).toBe('pending')
    // Los intentos gastados son la PRUEBA de lo que pasó: no se borran.
    expect(row?.attempts).toBe(1)
    expect(row?.max_attempts).toBe(2)
  })

  it('reintentar cierra el disyuntor de ese destino', async () => {
    const id = await enqueue(TENANT_A, 'reintento-2')
    await kill(TENANT_A, id)
    const [antes] = await svc<{ state: string }>(
      `select state::text as state from public.integration_circuit`,
    )
    expect(antes?.state).toBe('open')

    await asUser(TENANT_A, `select public.integration_retry($1, 'ya responde')`, [id])

    const [despues] = await svc<{ state: string; consecutive_fail: number }>(
      `select state::text as state, consecutive_fail from public.integration_circuit`,
    )
    expect(despues?.state).toBe('closed')
    expect(despues?.consecutive_fail).toBe(0)
  })

  it('un mensaje YA ENTREGADO no se reintenta', async () => {
    const id = await enqueue(TENANT_A, 'reintento-3')
    await svc(`select * from public.integration_claim('sap_r3', 'w1', 10)`)
    await svc(`select public.integration_succeed($1, 10, 200)`, [id])

    const message = await expectFailure(() =>
      asUser(TENANT_A, `select public.integration_retry($1, 'por si acaso')`, [id]),
    )
    expect(message).toMatch(/MENSAJE_YA_ENTREGADO/)
  })

  it('un mensaje EN VUELO tampoco', async () => {
    const id = await enqueue(TENANT_A, 'reintento-4')
    await svc(`select * from public.integration_claim('sap_r3', 'w1', 10)`)
    const message = await expectFailure(() =>
      asUser(TENANT_A, `select public.integration_retry($1, 'impaciente')`, [id]),
    )
    expect(message).toMatch(/MENSAJE_EN_VUELO/)
  })

  it('reintentar exige motivo y rol, y queda firmado', async () => {
    const id = await enqueue(TENANT_A, 'reintento-5')
    await kill(TENANT_A, id)

    const sinMotivo = await expectFailure(() =>
      asUser(TENANT_A, `select public.integration_retry($1, ' ')`, [id]),
    )
    expect(sinMotivo).toMatch(/MOTIVO_REQUERIDO/)

    const sinRol = await expectFailure(() =>
      asUser(TENANT_A, `select public.integration_retry($1, 'porque si')`, [id], viewerClaims),
    )
    expect(sinRol).toMatch(/SIN_PERMISO/)

    await asUser(TENANT_A, `select public.integration_retry($1, 'el destino ya responde')`, [id])
    const [row] = await svc<{ metadata: Row; actor_email: string }>(
      `select metadata, actor_email from public.audit_log
        where action = 'integration_message.retried' and entity_id = $1`,
      [id],
    )
    expect(row?.actor_email).toBe(TENANT_A.adminEmail)
    expect(row?.metadata.reason).toBe('el destino ya responde')
  })

  it('el tenant de al lado no reintenta un mensaje ajeno', async () => {
    const id = await enqueue(TENANT_B, 'reintento-ajeno')
    await kill(TENANT_B, id)
    const message = await expectFailure(() =>
      asUser(TENANT_A, `select public.integration_retry($1, 'curioseando')`, [id]),
    )
    expect(message).toMatch(/SIN_PERMISO/)
  })

  it('cerrar un disyuntor a mano exige motivo, rol y deja firma', async () => {
    const id = await enqueue(TENANT_A, 'circuito-1')
    await kill(TENANT_A, id)
    const [circuit] = await svc<{ id: string }>(`select id from public.integration_circuit`)

    const sinMotivo = await expectFailure(() =>
      asUser(TENANT_A, `select public.integration_circuit_reset($1, '')`, [circuit?.id]),
    )
    expect(sinMotivo).toMatch(/MOTIVO_REQUERIDO/)

    const sinRol = await expectFailure(() =>
      asUser(
        TENANT_A,
        `select public.integration_circuit_reset($1, 'porque si')`,
        [circuit?.id],
        viewerClaims,
      ),
    )
    expect(sinRol).toMatch(/SIN_PERMISO/)

    await asUser(TENANT_A, `select public.integration_circuit_reset($1, 'el sistema volvio')`, [
      circuit?.id,
    ])
    const [row] = await svc<{ state: string }>(
      `select state::text as state from public.integration_circuit where id = $1`,
      [circuit?.id],
    )
    expect(row?.state).toBe('closed')

    const [audit] = await svc<{ metadata: Row }>(
      `select metadata from public.audit_log
        where action = 'integration_circuit.reset' and entity_id = $1`,
      [circuit?.id],
    )
    expect(audit?.metadata.reason).toBe('el sistema volvio')
  })
})
