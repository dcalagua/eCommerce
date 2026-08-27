// @vitest-environment node
/**
 * Framework de integraciones (F0 · cimientos), sobre Postgres real.
 *
 * Lo que no puede fallar, porque de esto depende que un pedido llegue a SAP:
 *  - encolar es idempotente: el mismo pedido dos veces es UN mensaje;
 *  - dos workers en paralelo no se llevan el mismo mensaje;
 *  - el backoff crece y el mensaje agotado va a la cola muerta, no al bucle;
 *  - el disyuntor se abre tras N fallos y deja de servir mensajes;
 *  - un worker muerto no pierde el mensaje para siempre;
 *  - un tenant no ve la cola del otro, y nadie escribe la cola a mano;
 *  - una config con pinta de credencial se rechaza en la base.
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

async function svc<T = Row>(query: string, params: unknown[] = []): Promise<T[]> {
  return asRole(db, 'service_role', null, async () => {
    const result = await db.query<T>(query, params)
    return result.rows
  })
}

async function enqueue(
  tenant: typeof TENANT_A,
  key: string,
  operation = 'order.create',
): Promise<string> {
  const [row] = await svc(
    `select public.integration_enqueue($1, $2, 'sap_r3', $4, '{"n":1}'::jsonb, $3) as id`,
    [tenant.organizationId, tenant.companyId, key, operation],
  )
  return String(row?.id)
}

async function claim(worker = 'w1', limit = 10): Promise<Row[]> {
  return svc(`select * from public.integration_claim('sap_r3', $1, $2)`, [worker, limit])
}

beforeAll(async () => {
  db = await createTestDatabase()
  for (const tenant of [TENANT_A, TENANT_B]) {
    await svc(
      `insert into public.tenants (organization_id, slug, name, admin_email, status)
         values ($1, $2, $2, $3, 'active')`,
      [tenant.organizationId, tenant.slug, tenant.adminEmail],
    )
    await svc(
      `insert into public.tenant_members
         (organization_id, company_id, user_id, email, role, status)
       values ($1, $2, $3, $4, 'owner', 'active')`,
      [tenant.organizationId, tenant.companyId, tenant.ownerId, tenant.adminEmail],
    )
    await svc(
      `insert into public.tenant_integrations
         (organization_id, company_id, provider_code, is_active)
       values ($1, $2, 'sap_r3', true)`,
      [tenant.organizationId, tenant.companyId],
    )
  }
}, 120_000)

beforeEach(async () => {
  await svc(`delete from public.integration_messages`)
  await svc(`delete from public.integration_outbox`)
  await svc(`delete from public.integration_circuit`)
})

afterAll(async () => {
  await db?.close()
})

describe('encolar', () => {
  it('es idempotente: la misma clave dos veces es UN mensaje', async () => {
    const uno = await enqueue(TENANT_A, 'pedido-EC-0001')
    const dos = await enqueue(TENANT_A, 'pedido-EC-0001')

    expect(dos).toBe(uno)
    const [count] = await svc(`select count(*)::int as n from public.integration_outbox`)
    expect(count?.n).toBe(1)
  })

  it('la misma clave en OTRO tenant si es otro mensaje', async () => {
    await enqueue(TENANT_A, 'pedido-EC-0001')
    await enqueue(TENANT_B, 'pedido-EC-0001')
    const [count] = await svc(`select count(*)::int as n from public.integration_outbox`)
    expect(count?.n).toBe(2)
  })

  it('rechaza una integracion no habilitada', async () => {
    await svc(
      `update public.tenant_integrations set is_active = false
        where organization_id = $1 and provider_code = 'sap_r3'`,
      [TENANT_A.organizationId],
    )
    const message = await expectFailure(() => enqueue(TENANT_A, 'pedido-apagado'))
    expect(message).toMatch(/INTEGRACION_NO_ACTIVA/)
    await svc(
      `update public.tenant_integrations set is_active = true
        where organization_id = $1 and provider_code = 'sap_r3'`,
      [TENANT_A.organizationId],
    )
  })

  it('rechaza una operacion que el proveedor no declara', async () => {
    const message = await expectFailure(() =>
      enqueue(TENANT_A, 'pedido-raro', 'message.whatsapp'),
    )
    expect(message).toMatch(/OPERACION_NO_SOPORTADA/)
  })
})

describe('reclamar', () => {
  it('marca en vuelo, cuenta el intento y anota el worker', async () => {
    await enqueue(TENANT_A, 'pedido-1')
    const claimed = await claim('worker-a')

    expect(claimed).toHaveLength(1)
    expect(claimed[0]?.status).toBe('in_flight')
    expect(claimed[0]?.attempts).toBe(1)
    expect(claimed[0]?.claimed_by).toBe('worker-a')
  })

  it('un mensaje ya reclamado no se sirve otra vez', async () => {
    await enqueue(TENANT_A, 'pedido-1')
    expect(await claim('worker-a')).toHaveLength(1)
    expect(await claim('worker-b')).toHaveLength(0)
  })

  it('respeta el limite', async () => {
    for (let i = 0; i < 5; i += 1) await enqueue(TENANT_A, `pedido-lote-${i}`)
    expect(await claim('worker-a', 2)).toHaveLength(2)
    expect(await claim('worker-b', 3)).toHaveLength(3)
  })

  it('no sirve un mensaje cuyo reintento aun no toca', async () => {
    const id = await enqueue(TENANT_A, 'pedido-futuro')
    await svc(`update public.integration_outbox set next_retry_at = now() + interval '1 hour' where id = $1`, [id])
    expect(await claim()).toHaveLength(0)
  })
})

describe('resultado del intento', () => {
  it('el exito cierra el mensaje y deja rastro en la bitacora', async () => {
    const id = await enqueue(TENANT_A, 'pedido-ok')
    await claim()
    await svc(`select public.integration_succeed($1, 120)`, [id])

    const [row] = await svc(`select status, completed_at from public.integration_outbox where id = $1`, [id])
    expect(row?.status).toBe('succeeded')
    expect(row?.completed_at).not.toBeNull()

    const [log] = await svc(
      `select succeeded, attempt, latency_ms from public.integration_messages where outbox_id = $1`,
      [id],
    )
    expect(log).toMatchObject({ succeeded: true, attempt: 1, latency_ms: 120 })
  })

  it('el fallo reprograma con backoff creciente', async () => {
    const id = await enqueue(TENANT_A, 'pedido-falla')

    await claim()
    await svc(`select public.integration_fail($1, 'timeout')`, [id])
    const [tras1] = await svc(
      `select status, attempts, extract(epoch from (next_retry_at - now())) as espera
         from public.integration_outbox where id = $1`,
      [id],
    )
    expect(tras1?.status).toBe('pending')
    expect(tras1?.attempts).toBe(1)

    // Se adelanta el reloj para poder reclamarlo otra vez.
    await svc(`update public.integration_outbox set next_retry_at = now() where id = $1`, [id])
    await claim()
    await svc(`select public.integration_fail($1, 'timeout')`, [id])
    const [tras2] = await svc(
      `select attempts, extract(epoch from (next_retry_at - now())) as espera
         from public.integration_outbox where id = $1`,
      [id],
    )
    expect(tras2?.attempts).toBe(2)
    // 2^2 con jitter [0.5, 1.5) siempre supera al minimo de 2^1.
    expect(Number(tras2?.espera)).toBeGreaterThan(Number(tras1?.espera))
  })

  it('agotados los intentos, el mensaje va a la cola muerta y deja de servirse', async () => {
    const id = await enqueue(TENANT_A, 'pedido-imposible')
    await svc(`update public.integration_outbox set max_attempts = 2 where id = $1`, [id])

    for (let i = 0; i < 2; i += 1) {
      await svc(`update public.integration_outbox set next_retry_at = now() where id = $1`, [id])
      await claim()
      await svc(`select public.integration_fail($1, 'destino caido')`, [id])
    }

    const [row] = await svc(`select status, last_error from public.integration_outbox where id = $1`, [id])
    expect(row?.status).toBe('dead')
    expect(String(row?.last_error)).toMatch(/destino caido/)
    expect(await claim()).toHaveLength(0)
  })

  it('no se puede cerrar un mensaje que no estaba en vuelo', async () => {
    const id = await enqueue(TENANT_A, 'pedido-sin-reclamar')
    const message = await expectFailure(() => svc(`select public.integration_succeed($1)`, [id]))
    expect(message).toMatch(/MENSAJE_NO_EN_VUELO/)
  })
})

describe('disyuntor', () => {
  it('se abre tras N fallos seguidos y deja de servir mensajes', async () => {
    await svc(
      `insert into public.integration_circuit
         (organization_id, company_id, provider_code, operation, threshold)
       values ($1, $2, 'sap_r3', 'order.create', 2)`,
      [TENANT_A.organizationId, TENANT_A.companyId],
    )

    for (let i = 0; i < 2; i += 1) {
      const id = await enqueue(TENANT_A, `pedido-circuito-${i}`)
      await claim()
      await svc(`select public.integration_fail($1, 'SAP caido')`, [id])
    }

    const [circuito] = await svc(
      `select state, consecutive_fail from public.integration_circuit
        where organization_id = $1 and operation = 'order.create'`,
      [TENANT_A.organizationId],
    )
    expect(circuito?.state).toBe('open')

    // Con el circuito abierto no se sirve nada aunque haya mensajes esperando.
    await enqueue(TENANT_A, 'pedido-tras-apertura')
    expect(await claim()).toHaveLength(0)
  })

  it('un exito lo cierra y borra el historial de fallos', async () => {
    await svc(
      `insert into public.integration_circuit
         (organization_id, company_id, provider_code, operation, state, consecutive_fail, threshold)
       values ($1, $2, 'sap_r3', 'order.create', 'half_open', 4, 5)`,
      [TENANT_A.organizationId, TENANT_A.companyId],
    )
    const id = await enqueue(TENANT_A, 'pedido-recuperado')
    await claim()
    await svc(`select public.integration_succeed($1)`, [id])

    const [circuito] = await svc(
      `select state, consecutive_fail from public.integration_circuit
        where organization_id = $1 and operation = 'order.create'`,
      [TENANT_A.organizationId],
    )
    expect(circuito).toMatchObject({ state: 'closed', consecutive_fail: 0 })
  })

  it('el circuito de una operacion no bloquea a otra', async () => {
    await svc(
      `insert into public.integration_circuit
         (organization_id, company_id, provider_code, operation, state, opened_at)
       values ($1, $2, 'sap_r3', 'order.create', 'open', now())`,
      [TENANT_A.organizationId, TENANT_A.companyId],
    )
    await enqueue(TENANT_A, 'lectura-cliente', 'customer.read')
    expect(await claim()).toHaveLength(1)
  })
})

describe('worker muerto', () => {
  it('el mensaje huerfano se rescata y vuelve a la cola', async () => {
    const id = await enqueue(TENANT_A, 'pedido-huerfano')
    await claim('worker-que-muere')
    await svc(`update public.integration_outbox set claimed_at = now() - interval '30 minutes' where id = $1`, [id])

    const [rescatados] = await svc(`select public.integration_reclaim_stale() as n`)
    expect(rescatados?.n).toBe(1)

    const [row] = await svc(`select status, claimed_by from public.integration_outbox where id = $1`, [id])
    expect(row?.status).toBe('pending')
    expect(row?.claimed_by).toBeNull()
    expect(await claim()).toHaveLength(1)
  })
})

describe('aislamiento y blindaje', () => {
  it('un tenant no ve la cola del otro', async () => {
    await enqueue(TENANT_A, 'clave-de-tenant-a')
    await enqueue(TENANT_B, 'clave-de-tenant-b')

    const vistos = await asRole(db, 'authenticated', claimsFor(TENANT_A), async () => {
      const r = await db.query<Row>(`select idempotency_key from public.integration_outbox`)
      return r.rows
    })
    expect(vistos.map((r) => r.idempotency_key)).toEqual(['clave-de-tenant-a'])
  })

  it('el backoffice mira la cola pero no la escribe', async () => {
    const intentos: Array<[string, unknown[]]> = [
      [
        `insert into public.integration_outbox
           (organization_id, company_id, provider_code, operation, idempotency_key)
         values ($1, $2, 'sap_r3', 'order.create', 'inyectado-a-mano')`,
        [TENANT_A.organizationId, TENANT_A.companyId],
      ],
      [`update public.integration_outbox set status = 'succeeded'`, []],
      [`delete from public.integration_outbox`, []],
    ]

    for (const [sql, params] of intentos) {
      const message = await expectFailure(() =>
        asRole(db, 'authenticated', claimsFor(TENANT_A), async () => {
          await db.query(sql, params)
        }),
      )
      expect(message).toMatch(/permission denied|denied/i)
    }
  })

  it('anon no toca nada del framework', async () => {
    for (const tabla of [
      'integration_outbox',
      'integration_inbox',
      'integration_messages',
      'tenant_integrations',
    ]) {
      const message = await expectFailure(() =>
        asRole(db, 'anon', null, async () => {
          await db.query(`select 1 from public.${tabla}`)
        }),
      )
      expect(`${tabla}: ${message}`).toMatch(/permission denied|denied/i)
    }
  })

  it('ni anon ni el backoffice pueden mover la cola con las funciones', async () => {
    for (const role of ['anon', 'authenticated'] as const) {
      const message = await expectFailure(() =>
        asRole(db, role, role === 'authenticated' ? claimsFor(TENANT_A) : null, async () => {
          await db.query(`select public.integration_claim('sap_r3', 'intruso', 1)`)
        }),
      )
      expect(`${role}: ${message}`).toMatch(/permission denied|denied/i)
    }
  })

  it('una config con pinta de credencial se rechaza en la base', async () => {
    for (const clave of ['password', 'api_key', 'client_secret', 'token']) {
      const message = await expectFailure(() =>
        svc(
          `update public.tenant_integrations
              set config = jsonb_build_object($2::text, 'esto-no-va-aqui')
            where organization_id = $1 and provider_code = 'sap_r3'`,
          [TENANT_A.organizationId, clave],
        ),
      )
      expect(`${clave}: ${message}`).toMatch(/tenant_integrations_no_secrets|violates check/i)
    }
  })
})
