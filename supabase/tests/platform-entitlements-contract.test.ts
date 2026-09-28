// @vitest-environment node
/**
 * `ebim.entitlements/v1` de punta a punta sin red: JWT ES256 firmado aquí con
 * una clave de prueba, handler REAL de `platform-provisioning` para las rutas
 * de entitlements, y las RPC reales sobre Postgres (PGlite, todas las
 * migraciones).
 *
 *   · FIX-ENT-v1: los 13 fixtures dorados de MasterAdmin producen EXACTAMENTE
 *     `expected/put-responses.json` y `expected/get-applied.json`;
 *   · transporte: sin configuración 503; token inválido 401; scope incorrecto y
 *     credencial SOLO de provisioning 403; `jti` reutilizado 401; media type,
 *     contrato, Idempotency-Key, tamaño; el cuerpo nunca devuelve el snapshot;
 *   · manifiesto: `GET /entitlements/manifest` = archivo versionado byte a byte;
 *   · las rutas de provisioning NO pasan por aquí (INV-1).
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { asRole, createTestDatabase } from './harness.ts'
import { ecommerceSnapshot, provisionTenant } from './entitlements-helpers.ts'
import { loadEntitlementsConfig, type EntitlementsConfig } from '../functions/_shared/platformEntitlements/config.ts'
import {
  handleEntitlementsRequest,
  isEntitlementsRoute,
  type EntitlementsDeps,
} from '../functions/_shared/platformEntitlements/handler.ts'
import { manifestJson } from '../functions/_shared/platformEntitlements/manifest.ts'
import { createEntitlementsRpcRepository } from '../functions/_shared/platformEntitlements/repository.ts'
import { importMasterAdminPublicKey } from '../functions/_shared/platformProvisioning/m2m.ts'
import type { RpcClient } from '../functions/_shared/platformProvisioning/repository.ts'

type Row = Record<string, unknown>

const HERE = dirname(fileURLToPath(import.meta.url))
const FIX = join(HERE, 'fixtures', 'entitlements-v1')
const BASE = 'https://example.supabase.co/functions/v1/platform-provisioning'
const NOW = 1_790_000_000

let db: PGlite
let keys: CryptoKeyPair
let otherKeys: CryptoKeyPair
let publicKeyB64: string
let logs: Record<string, unknown>[]

// ── JWT ────────────────────────────────────────────────────────────────────
const b64url = (bytes: Uint8Array) =>
  Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const b64urlJson = (value: unknown) => b64url(new TextEncoder().encode(JSON.stringify(value)))

async function sign(claims: Record<string, unknown>, key: CryptoKey = keys.privateKey): Promise<string> {
  const input = `${b64urlJson({ alg: 'ES256', typ: 'JWT' })}.${b64urlJson(claims)}`
  const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(input))
  return `${input}.${b64url(new Uint8Array(signature))}`
}

function tokenClaims(scope: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    iss: 'masteradmin.ebim',
    aud: 'ecommerce.ebim',
    sub: 'masteradmin-provisioning',
    iat: NOW - 10,
    exp: NOW + 110,
    jti: crypto.randomUUID(),
    scope,
    actor_id: '10000000-0000-4000-a000-000000000002',
    actor_role: 'TECH_LEAD',
    ...overrides,
  }
}

function envFor(overrides: Record<string, string | undefined> = {}) {
  const values: Record<string, string | undefined> = {
    EBIM_MASTERADMIN_M2M_ENABLED: 'true',
    EBIM_MASTERADMIN_M2M_ISSUER: 'masteradmin.ebim',
    EBIM_MASTERADMIN_M2M_AUDIENCE: 'ecommerce.ebim',
    EBIM_MASTERADMIN_M2M_SUBJECT: 'masteradmin-provisioning',
    EBIM_MASTERADMIN_M2M_ALGORITHM: 'ES256',
    EBIM_MASTERADMIN_M2M_MAX_TOKEN_LIFETIME: '300',
    EBIM_MASTERADMIN_M2M_CREATE_SCOPE: 'ecommerce:tenant:create',
    EBIM_MASTERADMIN_M2M_READ_SCOPE: 'ecommerce:tenant:read',
    EBIM_MASTERADMIN_M2M_PUBLIC_KEY_B64: publicKeyB64,
    EBIM_MASTERADMIN_M2M_ENTITLEMENTS_WRITE_SCOPE: 'ecommerce:entitlements:write',
    EBIM_MASTERADMIN_M2M_ENTITLEMENTS_READ_SCOPE: 'ecommerce:entitlements:read',
    EBIM_ENTITLEMENTS_ENVIRONMENT: 'DEV',
    ...overrides,
  }
  return { get: (key: string) => values[key] }
}

// ── RPC sobre PGlite, como supabase-js con service_role ─────────────────────
const pgliteRpc: RpcClient = {
  async rpc(fn, args) {
    try {
      const data = await asRole(db, 'service_role', null, async () => {
        const call = async (sql: string, params: unknown[]) => (await db.query<{ v: unknown }>(sql, params)).rows[0]?.v ?? null
        switch (fn) {
          case 'platform_apply_entitlements':
            return call('select public.platform_apply_entitlements($1::uuid, $2::jsonb, $3::jsonb) as v', [
              args.p_control_plane_tenant_id,
              JSON.stringify(args.p_snapshot),
              JSON.stringify(args.p_meta),
            ])
          case 'platform_get_entitlements':
            return call('select public.platform_get_entitlements($1::uuid) as v', [args.p_control_plane_tenant_id])
          case 'platform_entitlements_use_jti':
            return call('select public.platform_entitlements_use_jti($1, $2, $3::timestamptz) as v', [
              args.p_issuer,
              args.p_jti,
              args.p_expires_at,
            ])
          default:
            throw new Error(`RPC no esperada: ${fn}`)
        }
      })
      return { data, error: null }
    } catch (error) {
      return { data: null, error: { message: (error as Error).message } }
    }
  },
}

function deps(config: EntitlementsConfig | null, overrides: Partial<EntitlementsDeps> = {}): EntitlementsDeps {
  return {
    config,
    publicKey: () => importMasterAdminPublicKey(publicKeyB64),
    repository: () => createEntitlementsRpcRepository(pgliteRpc),
    nowSeconds: () => NOW,
    log: (event) => logs.push(event),
    ...overrides,
  }
}

async function call(
  config: EntitlementsConfig | null,
  method: string,
  path: string,
  init: { token?: string | null; body?: unknown; raw?: string; headers?: Record<string, string> } = {},
): Promise<{ status: number; body: Row; text: string; headers: Headers }> {
  const headers: Record<string, string> = { ...(init.headers ?? {}) }
  if (init.token) headers.Authorization = `Bearer ${init.token}`
  const body = init.raw ?? (init.body === undefined ? undefined : JSON.stringify(init.body))
  if (body !== undefined && !('Content-Type' in headers)) headers['Content-Type'] = 'application/json'
  const response = await handleEntitlementsRequest(new Request(`${BASE}${path}`, { method, headers, body }), deps(config))
  const text = await response.text()
  let parsed: Row = {}
  try {
    parsed = JSON.parse(text) as Row
  } catch {
    parsed = {}
  }
  return { status: response.status, body: parsed, text, headers: response.headers }
}

const CONFIG = () => loadEntitlementsConfig(envFor()) as EntitlementsConfig

beforeAll(async () => {
  db = await createTestDatabase()
  keys = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair
  otherKeys = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair
  const spki = Buffer.from(await crypto.subtle.exportKey('spki', keys.publicKey)).toString('base64')
  const pem = `-----BEGIN PUBLIC KEY-----\n${spki}\n-----END PUBLIC KEY-----\n`
  publicKeyB64 = Buffer.from(pem).toString('base64')
  logs = []
}, 120_000)

afterAll(async () => {
  await db?.close()
})

// ───────────────────────────────────────────────────────────────────────────
describe('FIX-ENT-v1 — fixtures dorados contra el receptor real', () => {
  interface Fixture {
    id: string
    receiver: {
      environment: string
      productCode: string
      knownCapabilities: string[]
      provisionedTenants: string[]
      enforcementMode: string
      writeScope: string
      readScope: string
    }
    steps: { step: number; tenantPath: string; snapshot: Row }[]
  }
  const read = (rel: string) => JSON.parse(readFileSync(join(FIX, rel), 'utf8'))
  const ids = [
    '01-baseline-only', '02-plan-grants', '03-plan-plus-addon', '04-addon-removed', '05-limit-update',
    '06-app-inactive', '07-unknown-capability', '08-stale', '09-conflict', '10-bad-checksum',
    '11-wrong-environment', '12-forbidden-keys', '13-tenant-not-provisioned',
  ]
  const FIXTURES: Fixture[] = ids.map((id) => read(`fixtures/${id}.json`))
  const PUTS = read('expected/put-responses.json').responses as Record<string, { step: number; status: number; body: Row }[]>
  const GETS = read('expected/get-applied.json').responses as Record<string, { status: number; body: Row }>

  function matches(actual: { status: number; body: Row }, expected: { status: number; body: Row }) {
    expect(actual.status).toBe(expected.status)
    if (expected.status >= 400) {
      expect(actual.body.error).toBe(expected.body.error)
      expect(typeof actual.body.message).toBe('string')
      if ('appliedVersion' in expected.body) expect(actual.body.appliedVersion).toBe(expected.body.appliedVersion)
      return
    }
    for (const [k, v] of Object.entries(expected.body)) {
      if (v === '$iso8601') expect(actual.body[k]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/)
      else expect(actual.body[k], k).toEqual(v)
    }
    expect(Object.keys(actual.body).sort()).toEqual(Object.keys(expected.body).sort())
  }

  beforeAll(async () => {
    // El manifiesto del receptor de PRUEBA (producto sintético `fixture`): las
    // capacidades entran por el registro técnico y los medidores por el suyo,
    // igual que las de eCommerce. Nada de esto existe fuera del banco.
    const limits = new Set<string>()
    const allowances = new Map<string, string>()
    for (const f of FIXTURES) {
      for (const s of f.steps) {
        for (const l of (s.snapshot.limits as { code: string }[] | undefined) ?? []) limits.add(l.code)
        for (const a of (s.snapshot.allowances as { code: string; meterCode: string }[] | undefined) ?? [])
          allowances.set(a.code, a.meterCode)
      }
    }
    const known = FIXTURES[0]!.receiver.knownCapabilities
    for (const code of known) {
      if (limits.has(code)) {
        await db.query(`insert into platform_entitlements.metered_codes (code, kind) values ($1, 'LIMIT')`, [code])
      } else if (allowances.has(code)) {
        await db.query(`insert into platform_entitlements.metered_codes (code, kind, meter_code) values ($1, 'ALLOWANCE', $2)`, [
          code,
          allowances.get(code),
        ])
      } else {
        await db.query(
          `insert into public.app_capabilities (code, boundary, is_baseline, entitlement_code, state)
           values ($1, $2, false, $1, 'declared')`,
          [code, code.includes('.ai.') ? 'ai' : 'fixture'],
        )
      }
    }
    const tenants = new Set(FIXTURES.flatMap((f) => f.receiver.provisionedTenants))
    let n = 0
    for (const cpt of tenants) {
      n += 1
      const suffix = n.toString(16).padStart(2, '0')
      await provisionTenant(db, {
        cpt,
        org: `f1000000-0000-4000-8000-0000000000${suffix}`,
        company: `f1000000-0000-4000-8000-00000000c0${suffix}`,
        slug: `fixture-${suffix}`,
      })
    }
  })

  it('los fixtures fijados son los 13 publicados y todos en SHADOW/DEV/fixture', () => {
    expect(FIXTURES.map((f) => f.id)).toEqual(ids)
    for (const f of FIXTURES) {
      expect(f.receiver).toMatchObject({ environment: 'DEV', productCode: 'fixture', enforcementMode: 'SHADOW' })
    }
  })

  it.each(ids)('%s', async (id) => {
    const fixture = FIXTURES.find((f) => f.id === id)!
    const r = fixture.receiver
    const config = loadEntitlementsConfig(
      envFor({
        EBIM_ENTITLEMENTS_ENVIRONMENT: r.environment,
        EBIM_ENTITLEMENTS_PRODUCT_CODE: r.productCode,
        EBIM_MASTERADMIN_M2M_ENTITLEMENTS_WRITE_SCOPE: r.writeScope,
        EBIM_MASTERADMIN_M2M_ENTITLEMENTS_READ_SCOPE: r.readScope,
      }),
    )!
    const expectedPuts = PUTS[id]!
    for (const [i, step] of fixture.steps.entries()) {
      const put = await call(config, 'PUT', `/tenants/${step.tenantPath}/entitlements`, {
        token: await sign(tokenClaims(r.writeScope)),
        body: step.snapshot,
        headers: {
          'X-MasterAdmin-Contract': 'entitlements.v1',
          'X-Correlation-Id': '00000000-0000-4ccc-8000-0000000000ff',
        },
      })
      matches(put, expectedPuts[i]!)
      expect(put.text).not.toContain('"capabilities"')
    }
    const tenant = fixture.steps[fixture.steps.length - 1]!.tenantPath
    const get = await call(config, 'GET', `/tenants/${tenant}/entitlements`, {
      token: await sign(tokenClaims(r.readScope)),
    })
    matches(get, GETS[id]!)
  })
})

// ───────────────────────────────────────────────────────────────────────────
describe('transporte y autenticación', () => {
  const CPT = '7f000000-0000-4000-8000-000000000001'
  const ORG = '7f000000-0000-4000-8000-0000000000a0'
  const COMPANY = '7f000000-0000-4000-8000-0000000000c0'
  const WRITE = 'ecommerce:entitlements:write'
  const READ = 'ecommerce:entitlements:read'
  const path = `/tenants/${CPT}/entitlements`

  beforeAll(async () => {
    await provisionTenant(db, { cpt: CPT, org: ORG, company: COMPANY, slug: 'transport' })
  })

  const snapshot = (version = 1) =>
    ecommerceSnapshot({ tenant: CPT, version, organizationId: ORG, companyId: COMPANY, enabled: ['ecommerce.promotions'] })

  it('solo se enrutan aquí las rutas de entitlements (provisioning intacto)', () => {
    expect(isEntitlementsRoute(`${BASE}/tenants/${CPT}/entitlements`)).toBe(true)
    expect(isEntitlementsRoute(`${BASE}/entitlements/manifest`)).toBe(true)
    expect(isEntitlementsRoute(`${BASE}/tenants`)).toBe(false)
    expect(isEntitlementsRoute(`${BASE}/tenants/${CPT}`)).toBe(false)
    expect(isEntitlementsRoute(`${BASE}/health`)).toBe(false)
  })

  it('sin configuración (o sin los scopes nuevos) → 503 fail-closed', async () => {
    expect(loadEntitlementsConfig(envFor({ EBIM_MASTERADMIN_M2M_ENTITLEMENTS_WRITE_SCOPE: undefined }))).toBeNull()
    expect(loadEntitlementsConfig(envFor({ EBIM_ENTITLEMENTS_ENVIRONMENT: 'LOCAL' }))).toBeNull()
    expect(loadEntitlementsConfig(envFor({ EBIM_MASTERADMIN_M2M_ENABLED: 'false' }))).toBeNull()
    // Reutilizar un scope de provisioning sería conceder escritura comercial a
    // quien solo da de alta: configuración inválida.
    expect(
      loadEntitlementsConfig(envFor({ EBIM_MASTERADMIN_M2M_ENTITLEMENTS_WRITE_SCOPE: 'ecommerce:tenant:create' })),
    ).toBeNull()
    const r = await call(null, 'PUT', path, { token: await sign(tokenClaims(WRITE)), body: await snapshot() })
    expect(r).toMatchObject({ status: 503, body: { error: 'ENTITLEMENTS_NOT_CONFIGURED' } })
  })

  it('sin token, basura o firma de otra clave → 401 UNAUTHENTICATED', async () => {
    expect((await call(CONFIG(), 'GET', path, {})).body.error).toBe('UNAUTHENTICATED')
    expect((await call(CONFIG(), 'GET', path, { token: 'a.b.c' })).status).toBe(401)
    const foreign = await sign(tokenClaims(READ), otherKeys.privateKey)
    expect(await call(CONFIG(), 'GET', path, { token: foreign })).toMatchObject({
      status: 401,
      body: { error: 'UNAUTHENTICATED' },
    })
    expect((await call(CONFIG(), 'GET', path, { token: await sign(tokenClaims(READ, { aud: 'esupplier.ebim' })) })).status).toBe(401)
  })

  it('scope incorrecto → 403 INSUFFICIENT_SCOPE (lectura no escribe)', async () => {
    const r = await call(CONFIG(), 'PUT', path, { token: await sign(tokenClaims(READ)), body: await snapshot() })
    expect(r).toMatchObject({ status: 403, body: { error: 'INSUFFICIENT_SCOPE' } })
  })

  it('credencial SOLO de provisioning → 403 en PUT, GET y manifiesto', async () => {
    const prov = 'ecommerce:tenant:create ecommerce:tenant:read'
    expect((await call(CONFIG(), 'PUT', path, { token: await sign(tokenClaims(prov)), body: await snapshot() })).status).toBe(403)
    expect((await call(CONFIG(), 'GET', path, { token: await sign(tokenClaims(prov)) })).status).toBe(403)
    expect((await call(CONFIG(), 'GET', '/entitlements/manifest', { token: await sign(tokenClaims(prov)) })).status).toBe(403)
  })

  it('jti reutilizado → 401 JTI_REPLAYED (también en GET)', async () => {
    const token = await sign(tokenClaims(READ))
    expect((await call(CONFIG(), 'GET', path, { token })).status).toBe(200)
    expect(await call(CONFIG(), 'GET', path, { token })).toMatchObject({ status: 401, body: { error: 'JTI_REPLAYED' } })
  })

  it('Content-Type, contrato e Idempotency-Key', async () => {
    const snap = await snapshot()
    expect(
      (await call(CONFIG(), 'PUT', path, {
        token: await sign(tokenClaims(WRITE)),
        raw: JSON.stringify(snap),
        headers: { 'Content-Type': 'text/plain' },
      })).body.error,
    ).toBe('UNSUPPORTED_MEDIA_TYPE')
    expect(
      (await call(CONFIG(), 'PUT', path, {
        token: await sign(tokenClaims(WRITE)),
        body: snap,
        headers: { 'X-MasterAdmin-Contract': 'v1' },
      })).body.error,
    ).toBe('UNSUPPORTED_CONTRACT_VERSION')
    expect(
      (await call(CONFIG(), 'PUT', path, {
        token: await sign(tokenClaims(WRITE)),
        body: snap,
        headers: { 'Idempotency-Key': 'ma-ent-v1-otra' },
      })).body.error,
    ).toBe('SNAPSHOT_INVALID')
    expect(
      (await call(CONFIG(), 'PUT', path, { token: await sign(tokenClaims(WRITE)), raw: '{"no es json' })).body.error,
    ).toBe('SNAPSHOT_INVALID')
  })

  it('cuerpo enorme → 413 SNAPSHOT_TOO_LARGE sin llegar a la base', async () => {
    const r = await call(CONFIG(), 'PUT', path, { token: await sign(tokenClaims(WRITE)), raw: `{"x":"${'a'.repeat(300_000)}"}` })
    expect(r).toMatchObject({ status: 413, body: { error: 'SNAPSHOT_TOO_LARGE' } })
  })

  it('método y ruta desconocidos', async () => {
    expect((await call(CONFIG(), 'DELETE', path, { token: await sign(tokenClaims(WRITE)) })).status).toBe(405)
    expect((await call(CONFIG(), 'GET', '/tenants/no-es-uuid/entitlements', { token: await sign(tokenClaims(READ)) })).status).toBe(404)
  })

  it('PUT válido → 200 con correlation id; nunca devuelve el snapshot ni lo loguea', async () => {
    logs = []
    const snap = await snapshot()
    const r = await call(CONFIG(), 'PUT', path, {
      token: await sign(tokenClaims(WRITE)),
      body: snap,
      headers: {
        'Idempotency-Key': snap.idempotencyKey,
        'X-MasterAdmin-Contract': 'entitlements.v1',
        'X-Correlation-Id': '7f000000-0000-4000-8000-0000000000cc',
      },
    })
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ appliedVersion: 1, appliedChecksum: snap.checksum, status: 'APPLIED', replayed: false })
    expect(r.headers.get('X-Correlation-Id')).toBe('7f000000-0000-4000-8000-0000000000cc')
    expect(r.headers.get('Cache-Control')).toMatch(/no-store/)
    expect(r.text).not.toContain('ecommerce.promotions')
    expect(JSON.stringify(logs)).not.toContain('ecommerce.promotions')
    expect(JSON.stringify(logs)).not.toMatch(/eyJ/)
  })

  it('GET /entitlements/manifest = docs/platform-provisioning/ENTITLEMENTS_MANIFEST.json byte a byte', async () => {
    const file = readFileSync(join(HERE, '..', '..', 'docs', 'platform-provisioning', 'ENTITLEMENTS_MANIFEST.json'), 'utf8')
    const r = await call(CONFIG(), 'GET', '/entitlements/manifest', { token: await sign(tokenClaims(READ)) })
    expect(r.status).toBe(200)
    expect(r.text).toBe(file)
    expect(r.text).toBe(manifestJson())
    expect(r.text).not.toMatch(/price|amount|currency|cost/i)
  })

  it('el manifiesto declara exactamente lo que el receptor sabe hacer cumplir', async () => {
    const manifest = JSON.parse(manifestJson()) as { capabilities: { code: string; kind: string }[] }
    const rows = (await db.query<{ code: string; kind: string }>(
      `select code, kind from platform_entitlements.known_codes where code like 'ecommerce.%' order by code collate "C"`,
    )).rows
    expect(manifest.capabilities.map((c) => [c.code, c.kind])).toEqual(rows.map((r) => [r.code, r.kind]))
  })
})
