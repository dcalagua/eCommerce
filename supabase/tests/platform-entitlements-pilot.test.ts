// @vitest-environment node
/**
 * PILOTO CCP fase 09 — criterio de éxito, de punta a punta y sin red:
 *
 *   alta M2M (handler real de provisioning) → snapshot deseado de MasterAdmin
 *   → PUT (handler real de entitlements) → gate de SERVIDOR → GET misma
 *   versión/checksum → replay idempotente → stale y conflicto rechazados.
 *
 * Todo con MasterAdmin INALCANZABLE: `fetch` falla durante toda la prueba y
 * nadie lo llama. Después, reconciliación: MasterAdmin compara su deseado con
 * el GET (la única prueba válida), detecta la deriva y la cierra; y una caché
 * local tocada por fuera se repara desde el último snapshot.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { asRole, createTestDatabase, expectFailure } from './harness.ts'
import { ecommerceSnapshot } from './entitlements-helpers.ts'
import type { EntitlementSnapshot } from '../functions/_shared/platformEntitlements/contract.ts'
import { loadEntitlementsConfig, type EntitlementsConfig } from '../functions/_shared/platformEntitlements/config.ts'
import { handleEntitlementsRequest } from '../functions/_shared/platformEntitlements/handler.ts'
import { createEntitlementsRpcRepository } from '../functions/_shared/platformEntitlements/repository.ts'
import { handleProvisioningRequest } from '../functions/_shared/platformProvisioning/handler.ts'
import { importMasterAdminPublicKey, loadM2MConfig } from '../functions/_shared/platformProvisioning/m2m.ts'
import { createRpcRepository, type RpcClient } from '../functions/_shared/platformProvisioning/repository.ts'

type Row = Record<string, unknown>

const BASE = 'https://example.supabase.co/functions/v1/platform-provisioning'
const NOW = 1_790_000_000
const CPT = '9e000000-0000-4000-8000-000000000001'
const WRITE = 'ecommerce:entitlements:write'
const READ = 'ecommerce:entitlements:read'

let db: PGlite
let keys: CryptoKeyPair
let publicKeyB64: string
let fetchSpy: ReturnType<typeof vi.fn>
let org = ''
let company = ''

const b64url = (bytes: Uint8Array) =>
  Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const b64urlJson = (value: unknown) => b64url(new TextEncoder().encode(JSON.stringify(value)))

async function token(scope: string): Promise<string> {
  const claims = {
    iss: 'masteradmin.ebim',
    aud: 'ecommerce.ebim',
    sub: 'masteradmin-provisioning',
    iat: NOW - 5,
    exp: NOW + 115,
    jti: crypto.randomUUID(),
    scope,
    actor_id: '10000000-0000-4000-a000-000000000002',
    actor_role: 'EBIM_FINANCE',
  }
  const input = `${b64urlJson({ alg: 'ES256', typ: 'JWT' })}.${b64urlJson(claims)}`
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keys.privateKey, new TextEncoder().encode(input))
  return `${input}.${b64url(new Uint8Array(sig))}`
}

function env() {
  const values: Record<string, string> = {
    EBIM_MASTERADMIN_M2M_ENABLED: 'true',
    EBIM_MASTERADMIN_M2M_ISSUER: 'masteradmin.ebim',
    EBIM_MASTERADMIN_M2M_AUDIENCE: 'ecommerce.ebim',
    EBIM_MASTERADMIN_M2M_SUBJECT: 'masteradmin-provisioning',
    EBIM_MASTERADMIN_M2M_ALGORITHM: 'ES256',
    EBIM_MASTERADMIN_M2M_MAX_TOKEN_LIFETIME: '300',
    EBIM_MASTERADMIN_M2M_CREATE_SCOPE: 'ecommerce:tenant:create',
    EBIM_MASTERADMIN_M2M_READ_SCOPE: 'ecommerce:tenant:read',
    EBIM_MASTERADMIN_M2M_PUBLIC_KEY_B64: publicKeyB64,
    EBIM_MASTERADMIN_M2M_ENTITLEMENTS_WRITE_SCOPE: WRITE,
    EBIM_MASTERADMIN_M2M_ENTITLEMENTS_READ_SCOPE: READ,
    EBIM_ENTITLEMENTS_ENVIRONMENT: 'DEV',
  }
  return { get: (key: string) => values[key] }
}

/** supabase-js con service_role, sobre PGlite: cualquier RPC pública por nombre. */
const rpc: RpcClient = {
  async rpc(fn, args) {
    try {
      const names = Object.keys(args)
      const casts: Record<string, string> = {
        p_payload: '::jsonb',
        p_meta: '::jsonb',
        p_entry: '::jsonb',
        p_snapshot: '::jsonb',
        p_control_plane_tenant_id: '::uuid',
        p_expires_at: '::timestamptz',
      }
      const sql = `select public.${fn}(${names.map((n, i) => `${n} => $${i + 1}${casts[n] ?? ''}`).join(', ')}) as v`
      const params = names.map((n) => (typeof args[n] === 'object' && args[n] !== null ? JSON.stringify(args[n]) : args[n]))
      const data = await asRole(db, 'service_role', null, async () => (await db.query<{ v: unknown }>(sql, params)).rows[0]?.v ?? null)
      return { data, error: null }
    } catch (error) {
      return { data: null, error: { message: (error as Error).message } }
    }
  },
}

async function send(path: string, method: string, scope: string, body?: unknown, headers: Record<string, string> = {}) {
  const init: RequestInit = {
    method,
    headers: {
      Authorization: `Bearer ${await token(scope)}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }
  const req = new Request(`${BASE}${path}`, init)
  const response = path.includes('entitlements')
    ? await handleEntitlementsRequest(req, {
        config: loadEntitlementsConfig(env()) as EntitlementsConfig,
        publicKey: () => importMasterAdminPublicKey(publicKeyB64),
        repository: () => createEntitlementsRpcRepository(rpc),
        nowSeconds: () => NOW,
      })
    : await handleProvisioningRequest(req, {
        config: loadM2MConfig(env()),
        publicKey: () => importMasterAdminPublicKey(publicKeyB64),
        repository: () => createRpcRepository(rpc),
        nowSeconds: () => NOW,
      })
  return { status: response.status, body: (await response.json()) as Row }
}

const put = (snapshot: EntitlementSnapshot) =>
  send(`/tenants/${CPT}/entitlements`, 'PUT', WRITE, snapshot, {
    'Idempotency-Key': snapshot.idempotencyKey,
    'X-MasterAdmin-Contract': 'entitlements.v1',
  })
const get = () => send(`/tenants/${CPT}/entitlements`, 'GET', READ)

/** Lo que MasterAdmin emite para el tenant: versión n con su contenido. */
const desired = (version: number, enabled: string[], aiCredits: number | null = 2) =>
  ecommerceSnapshot({ tenant: CPT, version, enabled, aiCredits, organizationId: org, companyId: company })

async function gate(capability: string): Promise<boolean> {
  const [row] = await asRole(db, 'service_role', null, async () =>
    (await db.query<{ ok: boolean }>('select ebim.company_is_entitled($1, $2, $3) as ok', [org, company, capability])).rows,
  )
  return row!.ok
}

async function aiConsume(): Promise<Row> {
  const [row] = await asRole(db, 'service_role', null, async () =>
    (await db.query<{ r: Row }>(`select ebim.ai_consume_for($1, $2, 'assistant', 1) as r`, [org, company])).rows,
  )
  return row!.r
}

async function setMode(mode: string) {
  await asRole(db, 'service_role', null, () =>
    db.query('select public.platform_set_entitlement_enforcement_mode($1, $2, $3)', [CPT, mode, 'piloto fase 09']),
  )
}

beforeAll(async () => {
  db = await createTestDatabase()
  keys = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair
  const spki = Buffer.from(await crypto.subtle.exportKey('spki', keys.publicKey)).toString('base64')
  publicKeyB64 = Buffer.from(`-----BEGIN PUBLIC KEY-----\n${spki}\n-----END PUBLIC KEY-----\n`).toString('base64')
  // MasterAdmin (y cualquier otra red) inalcanzable durante TODO el piloto.
  fetchSpy = vi.fn(() => Promise.reject(new TypeError('network down: MasterAdmin inalcanzable')))
  vi.stubGlobal('fetch', fetchSpy)
}, 120_000)

afterAll(async () => {
  vi.unstubAllGlobals()
  await db?.close()
})

describe('piloto eCommerce — criterio de éxito', () => {
  it('0 · alta M2M real y tenant en SHADOW sin snapshot', async () => {
    const created = await send('/tenants', 'POST', 'ecommerce:tenant:create', {
      tenantCode: 'piloto-shop',
      tenantName: 'Piloto CCP · eCommerce',
      adminEmail: 'admin@piloto.ebim.test',
      tenantType: 'DEMO',
      environment: 'DEV',
      deploymentMode: 'SHARED',
      organization: { code: 'piloto-ccp', legalName: 'Piloto CCP S.A.C.', displayName: 'Piloto CCP', countryCode: 'PE' },
      company: { code: 'PIL-01', name: 'Piloto', countryCode: 'PE', currency: 'PEN' },
      plan: { code: 'ecommerce-shared-standard', name: 'Standard' },
      masterAdmin: { tenantId: CPT, productCode: 'ecommerce', requestId: '9e000000-0000-4000-8000-0000000000aa', contractVersion: 'v1' },
    }, { 'Idempotency-Key': 'piloto-ccp-fase-09', 'X-MasterAdmin-Contract': 'v1' })
    expect(created.status).toBe(201)
    org = created.body.externalOrganizationId as string
    company = created.body.externalCompanyId as string
    expect(org).toMatch(/^[0-9a-f-]{36}$/)

    expect((await get()).body).toMatchObject({ appliedVersion: null, status: 'NONE', enforcementMode: 'SHADOW' })
    // Antes del snapshot: comportamiento legado intacto (fallback de transición).
    expect(await gate('payments')).toBe(true)
    expect(await gate('promotions')).toBe(false)
  })

  it('1 · el operador lleva el tenant a PRIMARY un paso por vez', async () => {
    await setMode('DUAL_READ')
    await setMode('PRIMARY')
    expect((await get()).body).toMatchObject({ enforcementMode: 'PRIMARY', status: 'NONE' })
    // PRIMARY sin snapshot: solo baseline.
    expect(await gate('payments')).toBe(false)
    expect(await gate('catalog')).toBe(true)
  })

  let v1: EntitlementSnapshot
  it('2 · deseado de MasterAdmin → PUT → 200 APPLIED', async () => {
    v1 = await desired(1, ['ecommerce.ai.assist', 'ecommerce.promotions'])
    const r = await put(v1)
    expect(r).toMatchObject({
      status: 200,
      body: { appliedVersion: 1, appliedChecksum: v1.checksum, status: 'APPLIED', replayed: false, unknownCapabilities: [] },
    })
  })

  it('3 · gate de servidor decide con el snapshot local', async () => {
    expect(await gate('promotions')).toBe(true)
    expect(await gate('payments')).toBe(false)
    expect(await gate('catalog')).toBe(true)
    await expectFailure(() =>
      asRole(db, 'service_role', null, () => db.query(`select ebim.assert_capability($1, $2, 'payments')`, [org, company])),
    )
    // IA: capacidad + asignación (2 créditos); el hard gate corta el tercero.
    expect(await aiConsume()).toMatchObject({ allowed: true, quota: 2 })
    expect(await aiConsume()).toMatchObject({ allowed: true, quota: 2, remaining: 0 })
    expect(await aiConsume()).toMatchObject({ allowed: false, reason: 'QUOTA_EXCEEDED' })
  })

  it('4 · GET devuelve la MISMA versión y checksum', async () => {
    const r = await get()
    expect(r).toMatchObject({
      status: 200,
      body: {
        controlPlaneTenantId: CPT,
        productCode: 'ecommerce',
        appliedVersion: 1,
        appliedChecksum: v1.checksum,
        status: 'APPLIED',
        enforcementMode: 'PRIMARY',
      },
    })
  })

  it('5 · replay idempotente: 200 replayed:true y nada cambia', async () => {
    const before = await get()
    const r = await put(v1)
    expect(r).toMatchObject({ status: 200, body: { appliedVersion: 1, replayed: true } })
    expect(r.body.appliedAt).toBe(before.body.appliedAt)
    expect(await gate('promotions')).toBe(true)
  })

  it('6 · stale y conflicto rechazados; lo aplicado se conserva', async () => {
    const v2 = await desired(2, ['ecommerce.ai.assist'])
    expect((await put(v2)).body).toMatchObject({ appliedVersion: 2 })
    expect(await gate('promotions')).toBe(false)

    expect(await put(v1)).toMatchObject({ status: 409, body: { error: 'STALE_SNAPSHOT', appliedVersion: 2 } })
    const conflicting = await desired(2, ['ecommerce.ai.assist', 'ecommerce.payments'])
    expect(await put(conflicting)).toMatchObject({ status: 409, body: { error: 'VERSION_CONFLICT', appliedVersion: 2 } })

    expect((await get()).body).toMatchObject({ appliedVersion: 2, appliedChecksum: v2.checksum })
    expect(await gate('payments')).toBe(false)
  })

  it('7 · durante todo el piloto nadie llamó a la red', () => {
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

describe('reconciliación y deriva', () => {
  it('MasterAdmin detecta por GET que su deseado no está aplicado y lo cierra', async () => {
    const v3 = await desired(3, ['ecommerce.ai.assist', 'ecommerce.pricing.lists'], 5)
    // El push de v3 "no llegó" (MasterAdmin caído): el GET es la única verdad.
    const before = (await get()).body
    const inSync = (b: Row) => b.appliedVersion === v3.snapshotVersion && b.appliedChecksum === v3.checksum
    expect(inSync(before)).toBe(false)
    expect(before.appliedVersion).toBe(2)
    // Mientras tanto el SaaS sigue con su last-good (v2).
    expect(await gate('pricing.lists')).toBe(false)

    expect((await put(v3)).status).toBe(200)
    expect(inSync((await get()).body)).toBe(true)
    expect(await gate('pricing.lists')).toBe(true)
  })

  it('una caché local tocada por fuera se detecta y repara desde el último snapshot, sin MasterAdmin', async () => {
    await db.query(
      `insert into public.tenant_entitlements (organization_id, company_id, entitlement_code, is_active, source)
       values ($1, $2, 'ecommerce.payments', true, 'hub')
       on conflict (organization_id, company_id, entitlement_code) do update set is_active = true, source = 'hub'`,
      [org, company],
    )
    expect(await gate('payments')).toBe(true)
    const [row] = await asRole(db, 'service_role', null, async () =>
      (await db.query<{ r: Row }>('select public.platform_reconcile_entitlements($1::uuid) as r', [CPT])).rows,
    )
    expect(row!.r).toMatchObject({ drift: true, repaired: true, extra: ['ecommerce.payments'] })
    expect(await gate('payments')).toBe(false)
    expect((await get()).body).toMatchObject({ appliedVersion: 3 })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('rollback: PRIMARY → DUAL_READ → SHADOW devuelve el tenant a legado y conserva el snapshot', async () => {
    await setMode('DUAL_READ')
    await setMode('SHADOW')
    expect(await gate('payments')).toBe(true) // fallback legado de nuevo (nunca sincronizado por el hub)
    expect((await get()).body).toMatchObject({ appliedVersion: 3, enforcementMode: 'SHADOW' })
  })
})
