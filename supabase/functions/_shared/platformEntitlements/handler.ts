/**
 * Rutas de entitlements de `platform-provisioning` (EBIM MasterAdmin → eCommerce,
 * contrato `ebim.entitlements/v1`). ADITIVAS: las de provisioning no cambian y
 * ni siquiera pasan por aquí (`isEntitlementsRoute`).
 *
 *   PUT /platform-provisioning/tenants/{controlPlaneTenantId}/entitlements   <product>:entitlements:write
 *   GET /platform-provisioning/tenants/{controlPlaneTenantId}/entitlements   <product>:entitlements:read
 *   GET /platform-provisioning/entitlements/manifest                         <product>:entitlements:read
 *
 * Orden de cada petición (FIX-ENT-v1 §3):
 *   1. Ruta y método. 2. Configuración (sin ella, 503).
 *   3. JWT M2M (misma verificación que provisioning) + scope NUEVO → 401/403.
 *   4. Recién entonces el repositorio (service-role). `jti` de un solo uso → 401.
 *   5. Headers, cuerpo, forma, claves prohibidas, tamaño canónico, tenant y
 *      producto, entorno, checksum RECALCULADO. 6. RPC en una transacción.
 *
 * Nunca se loguea Authorization, el JWT ni el snapshot: solo códigos, correlation
 * id y versiones. La respuesta nunca devuelve el snapshot recibido.
 *
 * Portable (sin Deno.*): `platform-provisioning/index.ts` inyecta entorno y cliente.
 */
import { edgeSecurityHeaders } from '../securityHeaders.ts'
import { verifyMasterAdminM2M, type M2MClaims } from '../platformProvisioning/m2m.ts'
import type { EntitlementsConfig } from './config.ts'
import {
  ENTITLEMENTS_CONTRACT,
  ENTITLEMENT_ERROR_STATUS,
  entitlementErrorBody,
  type EntitlementErrorCode,
  type EntitlementSnapshot,
  isEntitlementErrorCode,
  isSnapshotSafe,
  isValidSnapshotShape,
  MAX_SNAPSHOT_BYTES,
  UUID_RE,
} from './contract.ts'
import { canonicalize, entitlementChecksum } from './jcs.ts'
import { manifestJson } from './manifest.ts'
import type { EntitlementsRepository } from './repository.ts'

/** Tope del cuerpo CRUDO: antes de parsear. El límite del contrato (64 KB) es sobre el canónico. */
export const MAX_RAW_BODY_BYTES = 256 * 1024

export interface EntitlementsDeps {
  config: EntitlementsConfig | null
  publicKey: () => Promise<CryptoKey>
  /** Se invoca SOLO tras validar el M2M. */
  repository: () => EntitlementsRepository
  nowSeconds?: () => number
  randomUuid?: () => string
  log?: (event: Record<string, unknown>) => void
}

type Route =
  | { kind: 'put' | 'get'; controlPlaneTenantId: string }
  | { kind: 'manifest' }
  | { kind: 'not_found' }
  | { kind: 'method_not_allowed'; allow: string }

function pathOf(url: string): string {
  return new URL(url).pathname.replace(/^.*?\/platform-provisioning/, '').replace(/\/+$/, '')
}

/** ¿Es una ruta de entitlements? Las demás siguen yendo al handler de provisioning. */
export function isEntitlementsRoute(url: string): boolean {
  const path = pathOf(url)
  return path === '/entitlements/manifest' || /^\/tenants\/[^/]+\/entitlements$/.test(path)
}

function resolveRoute(method: string, url: string): Route {
  const path = pathOf(url)
  if (path === '/entitlements/manifest') {
    return method === 'GET' ? { kind: 'manifest' } : { kind: 'method_not_allowed', allow: 'GET' }
  }
  const m = path.match(/^\/tenants\/([^/]+)\/entitlements$/)
  if (!m || !m[1]) return { kind: 'not_found' }
  let id: string
  try {
    id = decodeURIComponent(m[1]).toLowerCase()
  } catch {
    return { kind: 'not_found' }
  }
  if (!UUID_RE.test(id)) return { kind: 'not_found' }
  if (method === 'PUT') return { kind: 'put', controlPlaneTenantId: id }
  if (method === 'GET') return { kind: 'get', controlPlaneTenantId: id }
  return { kind: 'method_not_allowed', allow: 'GET, PUT' }
}

function respond(status: number, body: string, correlationId: string, extra: Record<string, string> = {}): Response {
  return new Response(body, {
    status,
    headers: {
      ...edgeSecurityHeaders(),
      'Content-Type': 'application/json',
      'X-Correlation-Id': correlationId,
      ...extra,
    },
  })
}

export async function handleEntitlementsRequest(req: Request, deps: EntitlementsDeps): Promise<Response> {
  const now = deps.nowSeconds ?? (() => Math.floor(Date.now() / 1000))
  const newUuid = deps.randomUuid ?? (() => crypto.randomUUID())
  const log = deps.log ?? (() => {})

  const incoming = req.headers.get('X-Correlation-Id')
  const correlationId = incoming && UUID_RE.test(incoming.toLowerCase()) ? incoming.toLowerCase() : newUuid()

  const fail = (code: EntitlementErrorCode, extra: { appliedVersion?: number | null } = {}, headers: Record<string, string> = {}) => {
    log({ event: 'platform_entitlements.rejected', code, correlationId })
    return respond(ENTITLEMENT_ERROR_STATUS[code], JSON.stringify(entitlementErrorBody(code, extra)), correlationId, headers)
  }

  const route = resolveRoute(req.method, req.url)
  if (route.kind === 'not_found') return fail('NOT_FOUND')
  if (route.kind === 'method_not_allowed') return fail('METHOD_NOT_ALLOWED', {}, { Allow: route.allow })

  const config = deps.config
  if (!config) return fail('ENTITLEMENTS_NOT_CONFIGURED')

  let publicKey: CryptoKey
  try {
    publicKey = await deps.publicKey()
  } catch {
    return fail('ENTITLEMENTS_NOT_CONFIGURED')
  }

  const scope = route.kind === 'put' ? config.writeScope : config.readScope
  const auth = await verifyMasterAdminM2M(req.headers.get('Authorization'), config.m2m, publicKey, scope, now())
  if (!auth.ok) {
    if (auth.code === 'MISSING_SCOPE') return fail('INSUFFICIENT_SCOPE')
    if (auth.code === 'M2M_NOT_CONFIGURED') return fail('ENTITLEMENTS_NOT_CONFIGURED')
    return fail('UNAUTHENTICATED')
  }
  const claims: M2MClaims = auth.claims

  let repository: EntitlementsRepository
  try {
    repository = deps.repository()
  } catch {
    return fail('ENTITLEMENTS_FAILED')
  }

  try {
    const firstUse = await repository.useJti(config.m2m.issuer, claims.jti, new Date(claims.exp * 1000).toISOString())
    if (!firstUse) return fail('JTI_REPLAYED')
  } catch {
    return fail('ENTITLEMENTS_FAILED')
  }

  if (route.kind === 'manifest') {
    log({ event: 'platform_entitlements.manifest', correlationId })
    return respond(200, manifestJson(), correlationId)
  }

  if (route.kind === 'get') {
    try {
      const state = await repository.getApplied(route.controlPlaneTenantId)
      if (!state) return fail('TENANT_NOT_PROVISIONED')
      log({ event: 'platform_entitlements.read', correlationId, appliedVersion: state.appliedVersion })
      return respond(
        200,
        JSON.stringify({
          controlPlaneTenantId: route.controlPlaneTenantId,
          productCode: config.productCode,
          appliedVersion: state.appliedVersion,
          appliedChecksum: state.appliedChecksum,
          appliedAt: state.appliedAt,
          status: state.status,
          unknownCapabilities: state.unknownCapabilities,
          enforcementMode: state.enforcementMode,
        }),
        correlationId,
      )
    } catch {
      return fail('ENTITLEMENTS_FAILED')
    }
  }

  // ── PUT ──────────────────────────────────────────────────────────────────
  const contentType = (req.headers.get('Content-Type') || '').toLowerCase()
  if (!contentType.startsWith('application/json')) return fail('UNSUPPORTED_MEDIA_TYPE')

  const contract = req.headers.get('X-MasterAdmin-Contract')
  if (contract !== null && contract.trim().toLowerCase() !== ENTITLEMENTS_CONTRACT) {
    return fail('UNSUPPORTED_CONTRACT_VERSION')
  }

  const raw = await req.text()
  if (new TextEncoder().encode(raw).length > MAX_RAW_BODY_BYTES) return fail('SNAPSHOT_TOO_LARGE')

  let body: unknown
  try {
    body = JSON.parse(raw)
  } catch {
    return fail('SNAPSHOT_INVALID')
  }

  if (!isValidSnapshotShape(body) || !isSnapshotSafe(body)) return fail('SNAPSHOT_INVALID')
  const snapshot: EntitlementSnapshot = body
  if (new TextEncoder().encode(canonicalize(snapshot)).length > MAX_SNAPSHOT_BYTES) return fail('SNAPSHOT_TOO_LARGE')
  if (snapshot.controlPlaneTenantId !== route.controlPlaneTenantId || snapshot.productCode !== config.productCode) {
    return fail('SNAPSHOT_INVALID')
  }
  if (snapshot.environment !== config.environment) return fail('ENVIRONMENT_MISMATCH')

  const idempotencyKey = req.headers.get('Idempotency-Key')
  if (idempotencyKey !== null && idempotencyKey !== snapshot.idempotencyKey) return fail('SNAPSHOT_INVALID')

  if ((await entitlementChecksum(snapshot as unknown as Record<string, unknown>)) !== snapshot.checksum) {
    return fail('CHECKSUM_MISMATCH')
  }

  try {
    const result = await repository.apply(route.controlPlaneTenantId, snapshot, {
      correlationId,
      m2mSubject: claims.sub,
      m2mJti: claims.jti,
      actorId: claims.actorId,
      actorRole: claims.actorRole,
    })
    const code = result.body.error
    if (result.httpStatus >= 400) {
      if (!isEntitlementErrorCode(code)) return fail('ENTITLEMENTS_FAILED')
      const applied = result.body.appliedVersion
      return fail(code, typeof applied === 'number' ? { appliedVersion: applied } : {})
    }
    log({
      event: result.body.replayed === true ? 'platform_entitlements.replayed' : 'platform_entitlements.applied',
      correlationId,
      appliedVersion: result.body.appliedVersion,
      status: result.body.status,
    })
    return respond(200, JSON.stringify(result.body), correlationId)
  } catch {
    // La transacción se deshizo entera. El detalle de Postgres no sale.
    return fail('ENTITLEMENTS_FAILED')
  }
}
