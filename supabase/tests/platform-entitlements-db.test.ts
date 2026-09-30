// @vitest-environment node
/**
 * Receptor de entitlements de EBIM MasterAdmin — mitad de base de datos, sobre
 * Postgres real (PGlite con TODAS las migraciones).
 *
 * Lo que se defiende:
 *   · privacidad: esquema propio sin USAGE para anon/authenticated, tablas con
 *     RLS forzada y sin GRANT, RPC solo para service_role; auditoría append-only;
 *   · reglas de versión: aplicar, replay idempotente, stale, conflicto, código
 *     desconocido (guardado, nunca concedido), tenant sin provisioning;
 *   · modos: SHADOW guarda y compara pero NO decide; DUAL_READ/PRIMARY deciden
 *     con el snapshot (materializado con `source = 'masteradmin'`); un paso por
 *     vez; volver atrás restaura el estado legado;
 *   · kill switches locales solo restan; appActive=false retira lo vendible y
 *     conserva lo baseline (D-14 regla 2, 2026-09-29);
 *   · PRIMARY de PRODUCTO no cambia a las sociedades legadas sin mapping;
 *   · IA: la capacidad Y la asignación del snapshot; el hard gate `ai_consume_for`
 *     sigue siendo el que corta;
 *   · H-ECO-1: en PRIMARY el camino legado (hub / clave estática) queda bloqueado;
 *   · offline last-good y deriva local reparada desde el último snapshot.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { asRole, createTestDatabase, expectFailure, type JwtClaims } from './harness.ts'
import { applyMeta, ecommerceSnapshot, provisionTenant, SELLABLE_CODES } from './entitlements-helpers.ts'
import type { EntitlementSnapshot } from '../functions/_shared/platformEntitlements/contract.ts'

type Row = Record<string, unknown>
let db: PGlite

const svc = async <T = Row>(query: string, params: unknown[] = []): Promise<T[]> =>
  asRole(db, 'service_role', null, async () => (await db.query<T>(query, params)).rows)
const su = async <T = Row>(query: string, params: unknown[] = []): Promise<T[]> =>
  (await db.query<T>(query, params)).rows

let seq = 0
function tenantIds(label: string) {
  seq += 1
  const n = seq.toString(16).padStart(2, '0')
  return {
    cpt: `7e0000${n}-0000-4000-8000-000000000001`,
    org: `7e0000${n}-0000-4000-8000-0000000000a0`,
    company: `7e0000${n}-0000-4000-8000-0000000000c0`,
    slug: `ent-${label}`,
  }
}
type Ids = ReturnType<typeof tenantIds>

async function apply(ids: Ids, snapshot: EntitlementSnapshot, tenantPath = ids.cpt): Promise<{ httpStatus: number; body: Row }> {
  const [row] = await svc<{ r: { httpStatus: number; body: Row } }>(
    'select public.platform_apply_entitlements($1::uuid, $2::jsonb, $3::jsonb) as r',
    [tenantPath, JSON.stringify(snapshot), JSON.stringify(applyMeta())],
  )
  return row!.r
}

async function getApplied(cpt: string): Promise<Row | null> {
  const [row] = await svc<{ r: Row | null }>('select public.platform_get_entitlements($1::uuid) as r', [cpt])
  return row!.r
}

async function setMode(scope: string, mode: string): Promise<Row> {
  const [row] = await svc<{ r: Row }>(
    'select public.platform_set_entitlement_enforcement_mode($1, $2, $3) as r',
    [scope, mode, 'test'],
  )
  return row!.r
}

async function toPrimary(ids: Ids): Promise<void> {
  await setMode(ids.cpt, 'DUAL_READ')
  await setMode(ids.cpt, 'PRIMARY')
}

async function entitled(ids: Ids, capability: string): Promise<boolean> {
  const [row] = await svc<{ ok: boolean }>('select ebim.company_is_entitled($1, $2, $3) as ok', [
    ids.org,
    ids.company,
    capability,
  ])
  return row!.ok
}

async function snap(ids: Ids, version: number, extra: Partial<Parameters<typeof ecommerceSnapshot>[0]> = {}) {
  return ecommerceSnapshot({ tenant: ids.cpt, version, organizationId: ids.org, companyId: ids.company, ...extra })
}

async function legacySync(ids: Ids, codes: string[], source = 'provisioning'): Promise<Row> {
  const [row] = await svc<{ r: Row }>(
    `select public.sync_platform_context($1, $2, true, $3::text[], $4::public.entitlement_source, null) as r`,
    [ids.org, ids.company, codes, source],
  )
  return row!.r
}

async function newTenant(label: string): Promise<Ids> {
  const ids = tenantIds(label)
  await provisionTenant(db, ids)
  return ids
}

beforeAll(async () => {
  db = await createTestDatabase()
}, 120_000)

afterAll(async () => {
  await db?.close()
})

describe('privacidad del receptor', () => {
  it('las tablas viven en `platform_entitlements` con RLS activada y forzada', async () => {
    const rows = await su<{ relname: string; on: boolean; forced: boolean }>(`
      select c.relname, c.relrowsecurity as on, c.relforcerowsecurity as forced
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'platform_entitlements' and c.relkind = 'r' order by 1`)
    expect(rows.map((r) => r.relname)).toEqual([
      'applied',
      'apply_audit',
      'enforcement_mode',
      'jti_replay',
      'legacy_backup',
      'legacy_write_alerts',
      'metered_codes',
      'mode_events',
      'shadow_diffs',
    ])
    expect(rows.every((r) => r.on && r.forced)).toBe(true)
  })

  it('ni anon ni authenticated tienen USAGE del esquema; nadie tiene GRANT de tabla', async () => {
    const [row] = await su<Row>(`
      select has_schema_privilege('anon', 'platform_entitlements', 'USAGE') as anon_usage,
             has_schema_privilege('authenticated', 'platform_entitlements', 'USAGE') as auth_usage,
             (select count(*)::int from information_schema.role_table_grants
               where table_schema = 'platform_entitlements'
                 and grantee in ('anon', 'authenticated', 'service_role', 'PUBLIC')) as grants`)
    expect(row).toEqual({ anon_usage: false, auth_usage: false, grants: 0 })
  })

  it('las RPC del receptor solo las ejecuta service_role', async () => {
    const rows = await su<{ fn: string; anon: boolean; auth: boolean; svc: boolean; definer: boolean }>(`
      select p.proname as fn, p.prosecdef as definer,
             has_function_privilege('anon', p.oid, 'EXECUTE') as anon,
             has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth,
             has_function_privilege('service_role', p.oid, 'EXECUTE') as svc
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname like 'platform\\_%entitlement%' order by 1`)
    expect(rows).toEqual([
      { fn: 'platform_apply_entitlements', definer: true, anon: false, auth: false, svc: true },
      { fn: 'platform_entitlements_use_jti', definer: true, anon: false, auth: false, svc: true },
      { fn: 'platform_get_entitlements', definer: true, anon: false, auth: false, svc: true },
      { fn: 'platform_reconcile_entitlements', definer: true, anon: false, auth: false, svc: true },
      { fn: 'platform_set_entitlement_enforcement_mode', definer: true, anon: false, auth: false, svc: true },
    ])
  })

  it('las funciones internas del esquema no son ejecutables por PUBLIC', async () => {
    const [row] = await su<{ n: number }>(`
      select count(*)::int as n from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'platform_entitlements'
         and (has_function_privilege('anon', p.oid, 'EXECUTE')
              or has_function_privilege('authenticated', p.oid, 'EXECUTE'))`)
    expect(row!.n).toBe(0)
  })

  it('la auditoría es append-only (UPDATE, DELETE y TRUNCATE rechazados)', async () => {
    const ids = await newTenant('audit')
    await apply(ids, await snap(ids, 1))
    expect(await expectFailure(() => su('update platform_entitlements.apply_audit set outcome = outcome'))).toMatch(
      /append-only/,
    )
    expect(await expectFailure(() => su('delete from platform_entitlements.apply_audit'))).toMatch(/append-only/)
    expect(await expectFailure(() => su('truncate platform_entitlements.apply_audit'))).toMatch(/append-only/)
  })

  it('el registro de códigos del receptor = manifiesto (sellables + asignación IA)', async () => {
    const rows = await su<{ code: string; kind: string }>(
      'select code, kind from platform_entitlements.known_codes order by code',
    )
    expect(rows.filter((r) => r.kind !== 'ALLOWANCE').map((r) => r.code)).toEqual(SELLABLE_CODES)
    expect(rows.filter((r) => r.kind === 'ALLOWANCE').map((r) => r.code)).toEqual(['ecommerce.ai.credits'])
    const ai = rows.filter((r) => r.kind === 'AI_FEATURE').map((r) => r.code)
    expect(ai).toEqual(['ecommerce.ai.assist', 'ecommerce.ai.catalog.copy', 'ecommerce.ai.content', 'ecommerce.ai.insights'])
  })
})

describe('reglas de versión (FIX-ENT-v1 §3)', () => {
  it('tenant sin provisioning → 404 TENANT_NOT_PROVISIONED', async () => {
    const ids = tenantIds('nope')
    const r = await apply(ids, await snap(ids, 1))
    expect(r.httpStatus).toBe(404)
    expect(r.body.error).toBe('TENANT_NOT_PROVISIONED')
    expect(await getApplied(ids.cpt)).toBeNull()
  })

  it('tenant del path distinto del cuerpo → 422 SNAPSHOT_INVALID', async () => {
    const ids = await newTenant('path')
    const other = tenantIds('other')
    const r = await apply(ids, await snap(other, 1), ids.cpt)
    expect(r).toMatchObject({ httpStatus: 422, body: { error: 'SNAPSHOT_INVALID' } })
  })

  it('aplica, replay idempotente, stale, conflicto y salto de versión', async () => {
    const ids = await newTenant('versions')
    expect(await getApplied(ids.cpt)).toMatchObject({ appliedVersion: null, status: 'NONE', enforcementMode: 'SHADOW' })

    const v1 = await snap(ids, 1, { enabled: ['ecommerce.promotions'] })
    const first = await apply(ids, v1)
    expect(first.httpStatus).toBe(200)
    expect(first.body).toMatchObject({ appliedVersion: 1, appliedChecksum: v1.checksum, status: 'APPLIED', replayed: false })
    expect(first.body.appliedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/)
    expect(first.body.unknownCapabilities).toEqual([])

    const replay = await apply(ids, v1)
    expect(replay).toMatchObject({ httpStatus: 200, body: { appliedVersion: 1, replayed: true, appliedAt: first.body.appliedAt } })

    const v3 = await snap(ids, 3, { enabled: ['ecommerce.promotions', 'ecommerce.payments'] })
    expect((await apply(ids, v3)).body).toMatchObject({ appliedVersion: 3, replayed: false })

    const stale = await apply(ids, await snap(ids, 2))
    expect(stale).toMatchObject({ httpStatus: 409, body: { error: 'STALE_SNAPSHOT', appliedVersion: 3 } })

    const conflict = await apply(ids, await snap(ids, 3, { enabled: [] }))
    expect(conflict).toMatchObject({ httpStatus: 409, body: { error: 'VERSION_CONFLICT', appliedVersion: 3 } })

    expect(await getApplied(ids.cpt)).toMatchObject({ appliedVersion: 3, appliedChecksum: v3.checksum, status: 'APPLIED' })

    const outcomes = await su<{ outcome: string; snapshot_version: number }>(
      `select outcome, snapshot_version from platform_entitlements.apply_audit
        where control_plane_tenant_id = $1 order by id`,
      [ids.cpt],
    )
    expect(outcomes).toEqual([
      { outcome: 'APPLIED', snapshot_version: 1 },
      { outcome: 'REPLAYED', snapshot_version: 1 },
      { outcome: 'APPLIED', snapshot_version: 3 },
      { outcome: 'STALE_SNAPSHOT', snapshot_version: 2 },
      { outcome: 'VERSION_CONFLICT', snapshot_version: 3 },
    ])
  })

  it('código desconocido: se guarda, se devuelve en unknownCapabilities y NUNCA se concede', async () => {
    const ids = await newTenant('unknown')
    const r = await apply(ids, await snap(ids, 1, { extraCapabilities: ['ecommerce.future.module'] }))
    expect(r.body).toMatchObject({ status: 'APPLIED_WITH_WARNINGS', unknownCapabilities: ['ecommerce.future.module'] })
    await toPrimary(ids)
    const [row] = await su<{ n: number }>(
      `select count(*)::int as n from public.tenant_entitlements
        where organization_id = $1 and entitlement_code = 'ecommerce.future.module' and is_active`,
      [ids.org],
    )
    expect(row!.n).toBe(0)
    expect(await getApplied(ids.cpt)).toMatchObject({ status: 'APPLIED_WITH_WARNINGS', unknownCapabilities: ['ecommerce.future.module'] })
  })

  it('jti de un solo uso por emisor', async () => {
    const use = async (iss: string, jti: string) =>
      (await svc<{ ok: boolean }>(
        `select public.platform_entitlements_use_jti($1, $2, now() + interval '2 minutes') as ok`,
        [iss, jti],
      ))[0]!.ok
    expect(await use('masteradmin.ebim', 'jti-a')).toBe(true)
    expect(await use('masteradmin.ebim', 'jti-a')).toBe(false)
    expect(await use('otro.emisor', 'jti-a')).toBe(true)
  })
})

describe('modos de enforcement', () => {
  it('SHADOW (por defecto): guarda y compara, NO decide ni toca la caché legada', async () => {
    const ids = await newTenant('shadow')
    // Nunca sincronizado: `payments` sigue abierto por el fallback legado.
    expect(await entitled(ids, 'payments')).toBe(true)
    await apply(ids, await snap(ids, 1, { enabled: ['ecommerce.promotions'] }))

    expect(await entitled(ids, 'payments')).toBe(true)
    expect(await entitled(ids, 'promotions')).toBe(false)
    const [ctx] = await su<{ n: number }>(
      'select count(*)::int as n from public.tenant_platform_context where organization_id = $1',
      [ids.org],
    )
    expect(ctx!.n).toBe(0)

    const diffs = await su<{ capability_code: string; legacy_decision: boolean; snapshot_decision: boolean }>(
      `select capability_code, legacy_decision, snapshot_decision from platform_entitlements.shadow_diffs
        where control_plane_tenant_id = $1 order by capability_code`,
      [ids.cpt],
    )
    expect(diffs).toEqual([
      { capability_code: 'ecommerce.catalog.advanced', legacy_decision: true, snapshot_decision: false },
      { capability_code: 'ecommerce.fulfillment', legacy_decision: true, snapshot_decision: false },
      { capability_code: 'ecommerce.payments', legacy_decision: true, snapshot_decision: false },
      { capability_code: 'ecommerce.promotions', legacy_decision: false, snapshot_decision: true },
    ])
  })

  it('un paso por vez, modos válidos y bitácora de cambios', async () => {
    const ids = await newTenant('steps')
    expect(await expectFailure(() => setMode(ids.cpt, 'PRIMARY'))).toMatch(/UN_PASO/)
    expect(await expectFailure(() => setMode(ids.cpt, 'TODO'))).toMatch(/MODO_INVALIDO/)
    expect(await expectFailure(() => setMode('no-es-uuid', 'DUAL_READ'))).toMatch(/ALCANCE_INVALIDO/)
    await setMode(ids.cpt, 'DUAL_READ')
    await setMode(ids.cpt, 'PRIMARY')
    await setMode(ids.cpt, 'DUAL_READ')
    const events = await su<{ from_mode: string; to_mode: string }>(
      `select from_mode, to_mode from platform_entitlements.mode_events where scope_key = $1 order by id`,
      [ids.cpt],
    )
    expect(events).toEqual([
      { from_mode: 'SHADOW', to_mode: 'DUAL_READ' },
      { from_mode: 'DUAL_READ', to_mode: 'PRIMARY' },
      { from_mode: 'PRIMARY', to_mode: 'DUAL_READ' },
    ])
  })

  it('PRIMARY: decide SOLO el snapshot; `legacy_until_synced` queda resuelto', async () => {
    const ids = await newTenant('primary')
    await apply(ids, await snap(ids, 1, { enabled: ['ecommerce.promotions', 'ecommerce.content.white_label'] }))
    await toPrimary(ids)

    expect(await entitled(ids, 'promotions')).toBe(true)
    expect(await entitled(ids, 'content.white_label')).toBe(true)
    expect(await entitled(ids, 'payments')).toBe(false) // antes abierta por el fallback legado
    expect(await entitled(ids, 'catalog')).toBe(true) // baseline

    const [ctx] = await su<{ source: string; plan: string; app_active: boolean }>(
      'select source::text, plan, app_active from public.tenant_platform_context where organization_id = $1',
      [ids.org],
    )
    expect(ctx).toEqual({ source: 'masteradmin', plan: 'ecommerce-shared-standard', app_active: true })

    // El guard de comandos del servidor corta con el mismo veredicto.
    expect(
      await expectFailure(() => svc(`select ebim.assert_capability($1, $2, 'payments')`, [ids.org, ids.company])),
    ).toMatch(/MODULO_NO_CONTRATADO/)

    // v2 revoca promociones: se apaga en la misma transacción del PUT.
    await apply(ids, await snap(ids, 2, { enabled: ['ecommerce.content.white_label'] }))
    expect(await entitled(ids, 'promotions')).toBe(false)
    expect(await getApplied(ids.cpt)).toMatchObject({ appliedVersion: 2, enforcementMode: 'PRIMARY' })
  })

  it('PRIMARY: un miembro ve el veredicto del snapshot; otro tenant no ve nada', async () => {
    const ids = await newTenant('member')
    const other = await newTenant('member-b')
    await apply(ids, await snap(ids, 1, { enabled: ['ecommerce.promotions'] }))
    await toPrimary(ids)
    const user = '7e0000ff-0000-4000-8000-0000000000d1'
    await su(
      `insert into public.tenant_members (organization_id, company_id, user_id, email, role)
       values ($1, $2, $3, 'admin@member.test', 'admin')`,
      [ids.org, ids.company, user],
    )
    const claims = (org: string, company: string): JwtClaims => ({
      sub: user,
      email: 'admin@member.test',
      org_id: org,
      companies: [{ id: company, role: 'admin' }],
      active_company: company,
      apps: ['ecommerce'],
    })
    const [mine] = await asRole(db, 'authenticated', claims(ids.org, ids.company), async () =>
      (await db.query<{ p: boolean; pay: boolean }>(
        `select ebim.has_capability($1, $2, 'promotions') as p, ebim.has_capability($1, $2, 'payments') as pay`,
        [ids.org, ids.company],
      )).rows,
    )
    expect(mine).toEqual({ p: true, pay: false })
    const [theirs] = await asRole(db, 'authenticated', claims(ids.org, ids.company), async () =>
      (await db.query<{ p: boolean }>(`select ebim.has_capability($1, $2, 'catalog') as p`, [
        other.org,
        other.company,
      ])).rows,
    )
    expect(theirs).toEqual({ p: false })
  })

  it('kill switch local: solo resta, nunca concede', async () => {
    const ids = await newTenant('flags')
    await apply(ids, await snap(ids, 1, { enabled: ['ecommerce.promotions'] }))
    await toPrimary(ids)
    await su(
      `insert into public.tenant_feature_flags (organization_id, company_id, flag_key, is_enabled)
       values ($1, $2, 'promotions', false), ($1, $2, 'payments', true), ($1, $2, 'catalog', false)`,
      [ids.org, ids.company],
    )
    expect(await entitled(ids, 'promotions')).toBe(false) // concedida y apagada localmente
    expect(await entitled(ids, 'payments')).toBe(false) // el flag a true no concede
    expect(await entitled(ids, 'catalog')).toBe(true) // un flag no apaga lo baseline
  })

  it('appActive=false retira lo comercial y NO la operación: baseline sigue, sin borrar datos (D-14 regla 2)', async () => {
    const ids = await newTenant('inactive')
    await apply(ids, await snap(ids, 1, { enabled: ['ecommerce.promotions', 'ecommerce.ai.assist'], appActive: false, aiCredits: 5 }))
    await toPrimary(ids)
    for (const baseline of ['catalog', 'storefront', 'checkout', 'orders', 'analytics.basic']) {
      expect(`${baseline}: ${await entitled(ids, baseline)}`).toBe(`${baseline}: true`)
    }
    expect(await entitled(ids, 'promotions')).toBe(false)
    expect(await entitled(ids, 'ai.assist')).toBe(false)
    // De vuelta a activa (versión siguiente): lo contratado vuelve.
    await apply(ids, await snap(ids, 2, { enabled: ['ecommerce.promotions'], appActive: true }))
    expect(await entitled(ids, 'promotions')).toBe(true)
    expect(await entitled(ids, 'catalog')).toBe(true)
    const [tenant] = await su<{ n: number }>('select count(*)::int as n from public.tenants where organization_id = $1', [
      ids.org,
    ])
    expect(tenant!.n).toBe(1)
  })

  it('alcance COMPANY con lista explícita de compañías de MasterAdmin: no se concede (fail-closed)', async () => {
    const ids = await newTenant('company')
    await apply(ids, await snap(ids, 1, { companyScoped: ['ecommerce.promotions'] }))
    await toPrimary(ids)
    expect(await entitled(ids, 'promotions')).toBe(false)
    const [row] = await su<{ u: string[] }>(
      'select unmapped_scope_capabilities as u from platform_entitlements.applied where control_plane_tenant_id = $1',
      [ids.cpt],
    )
    expect(row!.u).toEqual(['ecommerce.promotions'])
  })

  it('PRIMARY sin haber recibido snapshot: solo baseline', async () => {
    const ids = await newTenant('none')
    await toPrimary(ids)
    expect(await entitled(ids, 'catalog')).toBe(true)
    expect(await entitled(ids, 'payments')).toBe(false)
    expect(await getApplied(ids.cpt)).toMatchObject({ status: 'NONE', enforcementMode: 'PRIMARY' })
  })

  it('volver atrás restaura el estado legado y conserva el snapshot aplicado', async () => {
    const ids = await newTenant('rollback')
    await legacySync(ids, ['ecommerce.pricing.lists'])
    await apply(ids, await snap(ids, 1, { enabled: ['ecommerce.promotions'] }))
    await toPrimary(ids)
    expect(await entitled(ids, 'pricing.lists')).toBe(false)
    expect(await entitled(ids, 'promotions')).toBe(true)

    await setMode(ids.cpt, 'DUAL_READ')
    await setMode(ids.cpt, 'SHADOW')
    expect(await entitled(ids, 'pricing.lists')).toBe(true)
    expect(await entitled(ids, 'promotions')).toBe(false)
    const [ctx] = await su<{ source: string }>(
      'select source::text from public.tenant_platform_context where organization_id = $1',
      [ids.org],
    )
    expect(ctx!.source).toBe('provisioning')
    expect(await getApplied(ids.cpt)).toMatchObject({ appliedVersion: 1, enforcementMode: 'SHADOW' })
  })

  it('el modo del PRODUCTO aplica a los tenants sin modo propio', async () => {
    const ids = await newTenant('product')
    await apply(ids, await snap(ids, 1, { enabled: ['ecommerce.promotions'] }))
    await setMode('PRODUCT', 'DUAL_READ')
    try {
      expect(await entitled(ids, 'promotions')).toBe(true)
      expect(await getApplied(ids.cpt)).toMatchObject({ enforcementMode: 'DUAL_READ' })
    } finally {
      await setMode('PRODUCT', 'SHADOW')
    }
    expect(await entitled(ids, 'promotions')).toBe(false)
  })
})

describe('PRIMARY de PRODUCTO y tenants legados sin mapping (D-14 regla 4)', () => {
  it('una sociedad legada (sin provisioning de MasterAdmin) decide y escribe igual en PRODUCT PRIMARY', async () => {
    const legacy = { org: '7e5eed00-0000-4000-8000-000000000001', company: '7e5eed00-0000-4000-8000-0000000000c1' }
    await su(`insert into public.tenants (organization_id, slug, name, admin_email, status)
              values ($1, 'legado-d14', 'Legado D14', 'admin@legado-d14.demo', 'active')`, [legacy.org])
    // Como la semilla `miquimica`: entitlements del camino de aprovisionamiento, sin fila de contexto.
    await su(`insert into public.tenant_entitlements (organization_id, company_id, entitlement_code, is_active, source)
              values ($1, $2, 'ecommerce.trade.quotes', true, 'provisioning')`, [legacy.org, legacy.company])
    const decisions = async () =>
      svc<{ code: string; ok: boolean }>(
        `select cap.code, ebim.company_is_entitled($1, $2, cap.code) as ok from public.app_capabilities cap order by cap.code`,
        [legacy.org, legacy.company],
      )
    const before = await decisions()
    expect(before.find((d) => d.code === 'trade.quotes')?.ok).toBe(true)
    expect(before.find((d) => d.code === 'payments')?.ok).toBe(true) // fallback legado: nunca sincronizada

    await setMode('PRODUCT', 'DUAL_READ')
    await setMode('PRODUCT', 'PRIMARY')
    try {
      expect(await decisions()).toEqual(before)
      const [policy] = await svc<{ p: string }>(
        `select platform_entitlements.legacy_write_policy($1, $2, 'hub', '{}'::text[]) as p`,
        [legacy.org, legacy.company],
      )
      expect(policy!.p).toBe('ALLOW')
    } finally {
      await setMode('PRODUCT', 'DUAL_READ')
      await setMode('PRODUCT', 'SHADOW')
    }
    expect(await decisions()).toEqual(before)
  })
})

describe('camino legado frente al snapshot (H-ECO-1)', () => {
  it('LEGACY/SHADOW: el hub y la clave estática siguen escribiendo igual que antes', async () => {
    const ids = await newTenant('legacy-open')
    const r = await legacySync(ids, ['ecommerce.promotions'], 'hub')
    expect(r).toMatchObject({ source: 'hub' })
    expect(await entitled(ids, 'promotions')).toBe(true)
  })

  it('PRIMARY: el camino legado queda BLOQUEADO en servidor', async () => {
    const ids = await newTenant('legacy-blocked')
    await apply(ids, await snap(ids, 1, { enabled: [] }))
    await toPrimary(ids)
    expect(await expectFailure(() => legacySync(ids, ['ecommerce.payments'], 'provisioning'))).toMatch(
      /FUENTE_LEGADA_BLOQUEADA/,
    )
    expect(await expectFailure(() => legacySync(ids, ['ecommerce.payments'], 'hub'))).toMatch(/FUENTE_LEGADA_BLOQUEADA/)
    expect(await entitled(ids, 'payments')).toBe(false)
  })

  it('DUAL_READ con snapshot: la escritura legada se acepta, se ignora y alerta', async () => {
    const ids = await newTenant('legacy-dual')
    await apply(ids, await snap(ids, 1, { enabled: [] }))
    await setMode(ids.cpt, 'DUAL_READ')
    const r = await legacySync(ids, ['ecommerce.payments'], 'hub')
    expect(r).toMatchObject({ ignored: true, reason: 'SNAPSHOT_GOVERNS' })
    expect(await entitled(ids, 'payments')).toBe(false)
    const alerts = await su<{ action: string; source: string }>(
      `select action, source from platform_entitlements.legacy_write_alerts where organization_id = $1`,
      [ids.org],
    )
    expect(alerts).toEqual([{ action: 'IGNORED', source: 'hub' }])
  })

  it('DUAL_READ sin snapshot: cae a legado y alerta', async () => {
    const ids = await newTenant('legacy-fallback')
    await setMode(ids.cpt, 'DUAL_READ')
    await legacySync(ids, ['ecommerce.promotions'], 'hub')
    expect(await entitled(ids, 'promotions')).toBe(true)
    const alerts = await su<{ action: string }>(
      `select action from platform_entitlements.legacy_write_alerts where organization_id = $1`,
      [ids.org],
    )
    expect(alerts).toEqual([{ action: 'FALLBACK' }])
  })

  it('nadie escribe `source = masteradmin` fuera del receptor', async () => {
    const ids = await newTenant('reserved')
    expect(await expectFailure(() => legacySync(ids, ['ecommerce.payments'], 'masteradmin'))).toMatch(/FUENTE_RESERVADA/)
  })
})

describe('IA: capacidad + asignación del snapshot, hard gate intacto', () => {
  const consume = async (ids: Ids) =>
    (await svc<{ r: Row }>(`select ebim.ai_consume_for($1, $2, 'assistant', 1) as r`, [ids.org, ids.company]))[0]!.r

  it('la asignación `ecommerce.ai.credits` fija la cuota y `ai_consume_for` corta al agotarla', async () => {
    const ids = await newTenant('ai-allow')
    await apply(ids, await snap(ids, 1, { enabled: ['ecommerce.ai.assist'], aiCredits: 3 }))
    await toPrimary(ids)
    for (let i = 1; i <= 3; i += 1) expect(await consume(ids)).toMatchObject({ allowed: true, quota: 3, used: i })
    expect(await consume(ids)).toMatchObject({ allowed: false, reason: 'QUOTA_EXCEEDED', quota: 3 })
  })

  it('asignación sin la capacidad IA: DISABLED (la capacidad manda sobre la cuota)', async () => {
    const ids = await newTenant('ai-nocap')
    await apply(ids, await snap(ids, 1, { enabled: [], aiCredits: 100 }))
    await toPrimary(ids)
    expect(await consume(ids)).toMatchObject({ allowed: false, reason: 'DISABLED' })
  })

  it('PRIMARY sin asignación: cuota 0 (ausente nunca es ilimitado)', async () => {
    const ids = await newTenant('ai-none')
    await apply(ids, await snap(ids, 1, { enabled: ['ecommerce.ai.assist'] }))
    await toPrimary(ids)
    expect(await consume(ids)).toMatchObject({ allowed: false, quota: 0 })
  })

  it('DUAL_READ sin asignación: se mantiene la cuota legada (valor no decidido, D-03)', async () => {
    const ids = await newTenant('ai-dual')
    await apply(ids, await snap(ids, 1, { enabled: ['ecommerce.ai.assist'] }))
    await setMode(ids.cpt, 'DUAL_READ')
    expect(await consume(ids)).toMatchObject({ allowed: true, plan: 'trial', quota: 25 })
  })

  it('SHADOW: la IA sigue decidiéndose como antes', async () => {
    const ids = await newTenant('ai-shadow')
    await apply(ids, await snap(ids, 1, { enabled: ['ecommerce.ai.assist'], aiCredits: 1 }))
    expect(await consume(ids)).toMatchObject({ allowed: false, reason: 'DISABLED' })
  })
})

describe('offline last-good y deriva', () => {
  it('sin MasterAdmin: el gate sigue decidiendo con el último snapshot, y un push inválido no lo altera', async () => {
    const ids = await newTenant('offline')
    await apply(ids, await snap(ids, 5, { enabled: ['ecommerce.promotions'] }))
    await toPrimary(ids)
    // Pasa el tiempo sin MasterAdmin: el snapshot no caduca.
    await su(
      `update platform_entitlements.applied set applied_at = now() - interval '90 days' where control_plane_tenant_id = $1`,
      [ids.cpt],
    )
    expect(await entitled(ids, 'promotions')).toBe(true)
    // Un push rechazado (stale) no toca lo aplicado.
    expect((await apply(ids, await snap(ids, 4, { enabled: [] }))).httpStatus).toBe(409)
    expect(await entitled(ids, 'promotions')).toBe(true)
    // Y el hub no puede pisarlo.
    await expectFailure(() => legacySync(ids, [], 'hub'))
    expect(await entitled(ids, 'promotions')).toBe(true)
  })

  it('deriva local (caché tocada fuera del receptor) → reconcile la detecta y repara desde el último snapshot', async () => {
    const ids = await newTenant('drift')
    await apply(ids, await snap(ids, 1, { enabled: ['ecommerce.promotions'], aiCredits: 10 }))
    await toPrimary(ids)
    const reconcile = async () =>
      (await svc<{ r: Row }>('select public.platform_reconcile_entitlements($1::uuid) as r', [ids.cpt]))[0]!.r

    expect(await reconcile()).toMatchObject({ drift: false, repaired: false })

    await su(
      `insert into public.tenant_entitlements (organization_id, company_id, entitlement_code, is_active, source)
       values ($1, $2, 'ecommerce.payments', true, 'hub')`,
      [ids.org, ids.company],
    )
    await su(
      `update public.tenant_entitlements set is_active = false
        where organization_id = $1 and entitlement_code = 'ecommerce.promotions'`,
      [ids.org],
    )
    await su(`update public.ai_quotas set monthly_quota = 999 where organization_id = $1`, [ids.org])
    expect(await entitled(ids, 'payments')).toBe(true)

    const r = await reconcile()
    expect(r).toMatchObject({
      drift: true,
      repaired: true,
      extra: ['ecommerce.payments'],
      missing: ['ecommerce.promotions'],
      aiQuotaDrift: true,
    })
    expect(await entitled(ids, 'payments')).toBe(false)
    expect(await entitled(ids, 'promotions')).toBe(true)
    expect(await reconcile()).toMatchObject({ drift: false })
    const [audit] = await su<{ n: number }>(
      `select count(*)::int as n from platform_entitlements.apply_audit
        where control_plane_tenant_id = $1 and outcome = 'DRIFT_REPAIRED'`,
      [ids.cpt],
    )
    expect(audit!.n).toBe(1)
  })

  it('SHADOW: reconcile recalcula las diferencias sin tocar la decisión legada', async () => {
    const ids = await newTenant('drift-shadow')
    await apply(ids, await snap(ids, 1, { enabled: ['ecommerce.promotions'] }))
    const [r] = await svc<{ r: Row }>('select public.platform_reconcile_entitlements($1::uuid) as r', [ids.cpt])
    expect(r!.r).toMatchObject({ mode: 'SHADOW', drift: true, repaired: false, shadowDiffs: 4 })
    expect(await entitled(ids, 'payments')).toBe(true)
  })
})
