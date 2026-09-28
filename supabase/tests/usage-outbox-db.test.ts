// @vitest-environment node
/**
 * Outbox de uso `ebim.usage/v1` (CCP fase 17) sobre Postgres real (PGlite con
 * TODAS las migraciones).
 *
 * Lo que se defiende:
 *   · privacidad: esquema propio sin USAGE ni GRANT para nadie; RPC solo
 *     service_role;
 *   · la fila nace en la MISMA transacción que la traza de IA (`ai_record*`),
 *     también cuando la llamada falló, y desaparece si esa transacción se
 *     deshace;
 *   · atribución en origen: tenant del mapping de provisioning ACTIVE; sin
 *     mapping → PENDING con TENANT_NOT_MAPPED y nunca se reclama;
 *   · `internal` solo con lo que devolvió el proveedor (nunca 0, nunca texto);
 *   · el hecho es inmutable; solo cambian las columnas de entrega;
 *   · reclamo con lease, marcas SENT/DEAD/RETRY y backoff del contrato.
 */
import type { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { asRole, claimsFor, createTestDatabase, expectFailure, TENANT_A, TENANT_B } from './harness.ts'

type Row = Record<string, unknown>
let db: PGlite

const su = async <T = Row>(query: string, params: unknown[] = []): Promise<T[]> =>
  (await db.query<T>(query, params)).rows
const svc = async <T = Row>(query: string, params: unknown[] = []): Promise<T[]> =>
  asRole(db, 'service_role', null, async () => (await db.query<T>(query, params)).rows)

const CPT_A = '17a00000-0000-4000-8000-00000000000a'

type OutboxRow = {
  event_id: string
  source_interaction_id: string | null
  meter_code: string
  quantity: string
  unit: string
  control_plane_tenant_id: string | null
  external_company_id: string | null
  capability_code: string | null
  internal: Record<string, unknown>
  status: string
  attempts: number
  last_error_code: string | null
  sent_at: string | null
  next_attempt_at: string
}

async function outboxFor(interactionId: string): Promise<OutboxRow | undefined> {
  const [row] = await su<OutboxRow>(
    'select * from platform_usage.usage_outbox where source_interaction_id = $1',
    [interactionId],
  )
  return row
}

/** Traza del servidor (vitrina / service_role): `ebim.ai_record_for`. */
async function recordFor(
  tenant: typeof TENANT_A,
  opts: { status?: string; model?: string | null; input?: number; output?: number; cache?: number; latency?: number | null; errorKind?: string | null; feature?: string } = {},
): Promise<string> {
  const [row] = await svc<{ id: string }>(
    `select ebim.ai_record_for($1, $2, $3, $4, $5, 'prompt con datos del cliente', 'respuesta del modelo',
                               $6, $7, $8, $9, $10) as id`,
    [
      tenant.organizationId,
      tenant.companyId,
      opts.feature ?? 'content',
      opts.status ?? 'ai',
      opts.model === undefined ? 'claude-sonnet-5' : opts.model,
      opts.input ?? 120,
      opts.output ?? 45,
      opts.cache ?? 0,
      opts.latency === undefined ? 850 : opts.latency,
      opts.errorKind ?? null,
    ],
  )
  return row!.id
}

async function claim(limit = 500, lease = 120): Promise<OutboxRow[]> {
  const [row] = await svc<{ r: OutboxRow[] }>('select public.platform_usage_outbox_claim($1, $2) as r', [limit, lease])
  return row!.r
}

async function mark(results: unknown[]): Promise<Row> {
  const [row] = await svc<{ r: Row }>('select public.platform_usage_outbox_mark($1::jsonb) as r', [
    JSON.stringify(results),
  ])
  return row!.r
}

beforeAll(async () => {
  db = await createTestDatabase()
  for (const tenant of [TENANT_A, TENANT_B]) {
    await su(`select public.bootstrap_tenant($1, $2, $3, $4, $5, $6, $7, 'Tienda', 'PEN')`, [
      tenant.organizationId,
      tenant.companyId,
      tenant.slug,
      tenant.slug,
      tenant.adminEmail,
      tenant.ownerId,
      tenant.storeSlug,
    ])
  }
  // TENANT_A llegó por MasterAdmin (mapping ACTIVE); TENANT_B es legado (sin mapping).
  await su(
    `insert into platform_provisioning.requests (
       control_plane_tenant_id, idempotency_key, request_hash, tenant_organization_id,
       tenant_company_id, tenant_slug, admin_email, deployment_mode, status, correlation_id,
       m2m_subject, m2m_jti, request_payload, completed_at)
     values ($1, 'usage-test-a', $2, $3, $4, 'tenant-a', 'admin@tenant-a.com', 'SHARED', 'ACTIVE', $1,
             'masteradmin-provisioning', 'jti-usage-a', '{}'::jsonb, now())`,
    [CPT_A, 'c'.repeat(64), TENANT_A.organizationId, TENANT_A.companyId],
  )
}, 120_000)

afterAll(async () => {
  await db?.close()
})

describe('privacidad', () => {
  it('esquema propio sin USAGE para anon/authenticated y tablas sin GRANT', async () => {
    const [row] = await su<Row>(`
      select has_schema_privilege('anon', 'platform_usage', 'USAGE') as anon_usage,
             has_schema_privilege('authenticated', 'platform_usage', 'USAGE') as auth_usage,
             (select count(*)::int from information_schema.role_table_grants
               where table_schema = 'platform_usage'
                 and grantee in ('anon', 'authenticated', 'service_role', 'PUBLIC')) as grants,
             (select c.relrowsecurity and c.relforcerowsecurity from pg_class c
               where c.oid = 'platform_usage.usage_outbox'::regclass) as rls`)
    expect(row).toEqual({ anon_usage: false, auth_usage: false, grants: 0, rls: true })
  })

  it('authenticated no lee el outbox', async () => {
    const message = await expectFailure(() =>
      asRole(db, 'authenticated', claimsFor(TENANT_A), () => db.query('select * from platform_usage.usage_outbox')),
    )
    expect(message).toMatch(/permission denied/)
  })

  it('las RPC de entrega son solo de service_role, DEFINER con search_path fijo', async () => {
    const rows = await su<Row>(`
      select p.proname as fn,
             has_function_privilege('anon', p.oid, 'EXECUTE') as anon,
             has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth,
             has_function_privilege('service_role', p.oid, 'EXECUTE') as svc,
             p.prosecdef as definer,
             array_to_string(p.proconfig, ',') as config
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname like 'platform_usage_outbox_%'
       order by 1`)
    expect(rows).toEqual([
      { fn: 'platform_usage_outbox_claim', anon: false, auth: false, svc: true, definer: true, config: 'search_path=""' },
      { fn: 'platform_usage_outbox_mark', anon: false, auth: false, svc: true, definer: true, config: 'search_path=""' },
    ])
  })

  it('las funciones internas del esquema no las ejecuta nadie de fuera', async () => {
    const [row] = await su<{ n: number }>(`
      select count(*)::int as n from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'platform_usage'
         and (has_function_privilege('anon', p.oid, 'EXECUTE')
              or has_function_privilege('authenticated', p.oid, 'EXECUTE')
              or has_function_privilege('service_role', p.oid, 'EXECUTE'))`)
    expect(row!.n).toBe(0)
  })

  it('el reclamo usa FOR UPDATE SKIP LOCKED', async () => {
    const [row] = await su<{ src: string }>(
      `select lower(pg_get_functiondef('public.platform_usage_outbox_claim(integer, integer)'::regprocedure)) as src`,
    )
    expect(row!.src).toMatch(/for update skip locked/)
  })
})

describe('se escribe en la misma transacción que la traza de IA', () => {
  it('traza del servidor → un evento ecommerce.ai.calls con el tenant de MasterAdmin', async () => {
    const id = await recordFor(TENANT_A, { input: 120, output: 45, cache: 0, latency: 850 })
    const row = await outboxFor(id)
    expect(row).toMatchObject({
      meter_code: 'ecommerce.ai.calls',
      unit: 'call',
      control_plane_tenant_id: CPT_A,
      external_company_id: TENANT_A.companyId,
      capability_code: 'ecommerce.ai.content',
      status: 'PENDING',
      attempts: 0,
      last_error_code: null,
      sent_at: null,
    })
    expect(Number(row!.quantity)).toBe(1)
    expect(row!.event_id).toMatch(/^[0-9a-f-]{36}$/)
    expect(row!.event_id).not.toBe(id)
    // Solo lo que devolvió el proveedor: el 0 de caché NO se envía.
    expect(row!.internal).toEqual({
      provider: 'anthropic',
      model: 'claude-sonnet-5',
      inputTokens: 120,
      outputTokens: 45,
      latencyMs: 850,
    })
    // Nunca el texto del prompt o de la respuesta.
    expect(JSON.stringify(row)).not.toMatch(/prompt|respuesta|cliente/)
  })

  it('también en fallo: la llamada que no respondió se mide igual', async () => {
    const id = await recordFor(TENANT_A, {
      status: 'error',
      errorKind: 'timeout',
      model: 'desconocido',
      input: 0,
      output: 0,
      latency: 0,
    })
    const row = await outboxFor(id)
    expect(row).toMatchObject({ meter_code: 'ecommerce.ai.calls', status: 'PENDING', control_plane_tenant_id: CPT_A })
    expect(Number(row!.quantity)).toBe(1)
    // Sin tokens del proveedor, sin modelo real: `internal` vacío (nunca 0 inventado).
    expect(row!.internal).toEqual({})
  })

  it('si la transacción de la traza se deshace, el evento también', async () => {
    const before = await su<{ n: number }>('select count(*)::int as n from platform_usage.usage_outbox')
    await db.exec('begin')
    await recordFor(TENANT_A)
    await db.exec('rollback')
    const after = await su<{ n: number }>('select count(*)::int as n from platform_usage.usage_outbox')
    expect(after[0]!.n).toBe(before[0]!.n)
  })

  it('la ruta JWT (`public.ai_record` con ticket) también encola', async () => {
    await su(
      `insert into public.tenant_entitlements (organization_id, company_id, entitlement_code, is_active, source)
       values ($1, $2, 'ecommerce.ai.insights', true, 'hub')
       on conflict (organization_id, company_id, entitlement_code) do update set is_active = true`,
      [TENANT_A.organizationId, TENANT_A.companyId],
    )
    const id = await asRole(db, 'authenticated', claimsFor(TENANT_A), async () => {
      await db.query(`select ebim.ai_consume('orders', 1)`)
      const { rows } = await db.query<{ id: string | null }>(
        `select public.ai_record('orders', 'error', 'claude-sonnet-5', 'p', null, 10, 0, 0, 30, 'rate_limit') as id`,
      )
      return rows[0]!.id
    })
    expect(id).toMatch(/^[0-9a-f-]{36}$/)
    const row = await outboxFor(id!)
    expect(row).toMatchObject({ capability_code: 'ecommerce.ai.insights', control_plane_tenant_id: CPT_A })
    expect(row!.internal).toEqual({ provider: 'anthropic', model: 'claude-sonnet-5', inputTokens: 10, latencyMs: 30 })
  })

  it('sin mapping de provisioning ACTIVE: PENDING con TENANT_NOT_MAPPED, sin tenant inventado', async () => {
    const id = await recordFor(TENANT_B)
    const row = await outboxFor(id)
    expect(row).toMatchObject({
      status: 'PENDING',
      control_plane_tenant_id: null,
      last_error_code: 'TENANT_NOT_MAPPED',
      external_company_id: TENANT_B.companyId,
    })
  })

  it('una traza sin sociedad o de una funcionalidad no declarada no encola', async () => {
    const before = await su<{ n: number }>('select count(*)::int as n from platform_usage.usage_outbox')
    await svc(`select ebim.ai_record_for($1, $2, 'inventada', 'ai')`, [TENANT_A.organizationId, TENANT_A.companyId])
    const after = await su<{ n: number }>('select count(*)::int as n from platform_usage.usage_outbox')
    expect(after[0]!.n).toBe(before[0]!.n)
  })
})

describe('el hecho es inmutable', () => {
  it.each([
    ['quantity', 'quantity = 2'],
    ['meter_code', "meter_code = 'ecommerce.ai.other'"],
    ['control_plane_tenant_id', "control_plane_tenant_id = '17a00000-0000-4000-8000-0000000000ff'"],
    ['occurred_at', "occurred_at = now() - interval '1 day'"],
    ['internal', `internal = '{"inputTokens": 1}'::jsonb`],
    ['event_id', 'event_id = gen_random_uuid()'],
  ])('%s no cambia', async (_col, set) => {
    const id = await recordFor(TENANT_A)
    const message = await expectFailure(() =>
      su(`update platform_usage.usage_outbox set ${set} where source_interaction_id = $1`, [id]),
    )
    expect(message).toMatch(/USAGE_FACT_IMMUTABLE/)
  })

  it('no se borra', async () => {
    const id = await recordFor(TENANT_A)
    const message = await expectFailure(() =>
      su('delete from platform_usage.usage_outbox where source_interaction_id = $1', [id]),
    )
    expect(message).toMatch(/USAGE_FACT_IMMUTABLE/)
  })

  it('la cantidad nunca es negativa', async () => {
    const message = await expectFailure(() =>
      su(`insert into platform_usage.usage_outbox
            (occurred_at, meter_code, quantity, unit, organization_id, company_id)
          values (now(), 'ecommerce.ai.calls', -1, 'call', $1, $2)`, [TENANT_A.organizationId, TENANT_A.companyId]),
    )
    expect(message).toMatch(/usage_outbox_quantity_ck|check constraint/)
  })
})

describe('reclamo, marcas y backoff', () => {
  it('reclama solo lo mapeado y vencido; el lease impide un segundo reclamo', async () => {
    const first = await claim()
    expect(first.length).toBeGreaterThan(0)
    expect(first.every((r) => r.control_plane_tenant_id === CPT_A)).toBe(true)
    // Ningún evento sin tenant sale del outbox.
    expect(first.some((r) => r.external_company_id === TENANT_B.companyId)).toBe(false)
    const again = await claim()
    expect(again).toEqual([])
    // Vence el lease → se puede volver a reclamar (el trabajador se cayó).
    await su(`update platform_usage.usage_outbox set next_attempt_at = now() - interval '1 second'
               where control_plane_tenant_id is not null and status = 'PENDING'`)
    const retaken = await claim(2)
    expect(retaken).toHaveLength(2)
  })

  it('SENT (ACCEPTED/DUPLICATE), DEAD con código y RETRY con backoff', async () => {
    await su(`update platform_usage.usage_outbox set next_attempt_at = now() - interval '1 second'
               where status = 'PENDING'`)
    const rows = await claim(3)
    expect(rows).toHaveLength(3)
    const [a, b, c] = rows as [OutboxRow, OutboxRow, OutboxRow]
    const r = await mark([
      { eventId: a.event_id, outcome: 'SENT' },
      { eventId: b.event_id, outcome: 'DEAD', code: 'UNKNOWN_METER' },
      { eventId: c.event_id, outcome: 'RETRY', code: 'USAGE_INGEST_DISABLED' },
    ])
    expect(r).toEqual({ sent: 1, dead: 1, retry: 1, ignored: 0 })

    const [ra] = await su<Row>(
      'select status, sent_at is not null as has_sent, last_error_code from platform_usage.usage_outbox where event_id = $1',
      [a.event_id],
    )
    expect(ra).toEqual({ status: 'SENT', has_sent: true, last_error_code: null })
    const [rb] = await su<Row>('select status, last_error_code from platform_usage.usage_outbox where event_id = $1', [b.event_id])
    expect(rb).toEqual({ status: 'DEAD', last_error_code: 'UNKNOWN_METER' })
    const [rc] = await su<Row>(
      `select status, attempts, last_error_code,
              round(extract(epoch from (next_attempt_at - now())))::int as wait
         from platform_usage.usage_outbox where event_id = $1`,
      [c.event_id],
    )
    expect(rc).toEqual({ status: 'PENDING', attempts: 1, last_error_code: 'USAGE_INGEST_DISABLED', wait: 30 })
  })

  it('backoff min(30·2^(n−1), 21600) por intento', async () => {
    const id = await recordFor(TENANT_A)
    const row = await outboxFor(id)
    const waits: number[] = []
    for (let n = 1; n <= 11; n += 1) {
      await mark([{ eventId: row!.event_id, outcome: 'RETRY', code: 'HTTP_502' }])
      const [r] = await su<{ attempts: number; wait: number }>(
        `select attempts, round(extract(epoch from (next_attempt_at - now())))::int as wait
           from platform_usage.usage_outbox where event_id = $1`,
        [row!.event_id],
      )
      expect(r!.attempts).toBe(n)
      waits.push(r!.wait)
    }
    expect(waits).toEqual([30, 60, 120, 240, 480, 960, 1920, 3840, 7680, 15360, 21600])
  })

  it('SENT y DEAD son terminales: una marca posterior se ignora y el UPDATE directo falla', async () => {
    const id = await recordFor(TENANT_A)
    const row = await outboxFor(id)
    await mark([{ eventId: row!.event_id, outcome: 'SENT' }])
    const r = await mark([{ eventId: row!.event_id, outcome: 'RETRY', code: 'HTTP_500' }])
    expect(r).toEqual({ sent: 0, dead: 0, retry: 0, ignored: 1 })
    const message = await expectFailure(() =>
      su(`update platform_usage.usage_outbox set status = 'PENDING', sent_at = null where event_id = $1`, [row!.event_id]),
    )
    expect(message).toMatch(/USAGE_FACT_IMMUTABLE/)
  })

  it('un evento sin tenant nunca se marca como enviado', async () => {
    const id = await recordFor(TENANT_B)
    const row = await outboxFor(id)
    const r = await mark([{ eventId: row!.event_id, outcome: 'SENT' }])
    expect(r).toEqual({ sent: 0, dead: 0, retry: 0, ignored: 1 })
    expect((await outboxFor(id))!.status).toBe('PENDING')
  })

  it('una marca malformada se rechaza entera', async () => {
    const id = await recordFor(TENANT_A)
    const row = await outboxFor(id)
    const message = await expectFailure(() => mark([{ eventId: row!.event_id, outcome: 'BORRAR' }]))
    expect(message).toMatch(/USAGE_MARK_INVALID/)
    expect((await outboxFor(id))!.status).toBe('PENDING')
  })
})
