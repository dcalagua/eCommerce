/**
 * Contrato `ebim.entitlements/v1` (FIX-ENT-v1 de EBIM MasterAdmin) — parte pura.
 *
 * Forma del snapshot, claves prohibidas, códigos de error y su status HTTP. Sin
 * `Deno.*` ni red: lo ejercitan los tests contra los fixtures dorados fijados en
 * `supabase/tests/fixtures/entitlements-v1`.
 *
 * El formato de error NO es el de provisioning (`errorBody` de
 * `platformProvisioning/errors.ts`): el contrato de entitlements exige
 * `{error: "<CODIGO>", message, appliedVersion?}` y MasterAdmin
 * (`classifyPutResponse`) lee `body.error` como cadena.
 */

export const ENTITLEMENTS_SCHEMA = 'ebim.entitlements/v1'
export const ENTITLEMENTS_CONTRACT = 'entitlements.v1'
/** Tamaño máximo del snapshot canónico, en bytes UTF-8. */
export const MAX_SNAPSHOT_BYTES = 65536

export type EntitlementEnvironment = 'DEV' | 'QAS' | 'DEMO' | 'PRD'
export type EnforcementMode = 'LEGACY' | 'SHADOW' | 'DUAL_READ' | 'PRIMARY'
export type AppliedStatus = 'NONE' | 'APPLIED' | 'APPLIED_WITH_WARNINGS'
export type GrantSource = 'BASELINE' | 'PLAN' | 'ADDON' | 'OVERRIDE'

export interface CapabilityScope {
  level: 'TENANT' | 'COMPANY'
  companyIds?: string[]
}

export interface EntitlementSnapshot {
  schema: typeof ENTITLEMENTS_SCHEMA
  environment: EntitlementEnvironment
  controlPlaneTenantId: string
  productCode: string
  external: { tenantId: string; organizationId: string | null; companyIds: string[] }
  snapshotVersion: number
  previousVersion: number | null
  effectiveAt: string
  issuedAt: string
  appActive: boolean
  planCode: string | null
  capabilities: { code: string; enabled: boolean; scope: CapabilityScope; sources: GrantSource[] }[]
  limits: {
    code: string
    value: number
    unit: string | null
    enforcement: 'HARD' | 'SOFT'
    scope: CapabilityScope
    sources: GrantSource[]
  }[]
  allowances: {
    code: string
    meterCode: string
    included: number
    unit: string | null
    period: { start: string; end: string }
    overageMode: 'BLOCK'
    sources: GrantSource[]
  }[]
  aiCredits: { weights: { capabilityCode: string; creditsPerUnit: number; unit: string }[]; weightsVersion: number }
  correlationId: string
  idempotencyKey: string
  checksum: string
}

export interface GetAppliedBody {
  controlPlaneTenantId: string
  productCode: string
  appliedVersion: number | null
  appliedChecksum: string | null
  appliedAt: string | null
  status: AppliedStatus
  unknownCapabilities: string[]
  enforcementMode: EnforcementMode
}

export const ENTITLEMENT_ERROR_STATUS = {
  UNAUTHENTICATED: 401,
  JTI_REPLAYED: 401,
  INSUFFICIENT_SCOPE: 403,
  NOT_FOUND: 404,
  TENANT_NOT_PROVISIONED: 404,
  METHOD_NOT_ALLOWED: 405,
  STALE_SNAPSHOT: 409,
  VERSION_CONFLICT: 409,
  SNAPSHOT_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA_TYPE: 415,
  SNAPSHOT_INVALID: 422,
  ENVIRONMENT_MISMATCH: 422,
  CHECKSUM_MISMATCH: 422,
  UNSUPPORTED_CONTRACT_VERSION: 422,
  ENTITLEMENTS_FAILED: 500,
  ENTITLEMENTS_NOT_CONFIGURED: 503,
} as const

export type EntitlementErrorCode = keyof typeof ENTITLEMENT_ERROR_STATUS

const MESSAGES: Record<EntitlementErrorCode, string> = {
  UNAUTHENTICATED: 'Missing or invalid M2M token',
  JTI_REPLAYED: 'Token jti already used',
  INSUFFICIENT_SCOPE: 'Token lacks the required entitlements scope',
  NOT_FOUND: 'Route not found',
  TENANT_NOT_PROVISIONED: 'Tenant has no local provisioning',
  METHOD_NOT_ALLOWED: 'Method not allowed',
  STALE_SNAPSHOT: 'Snapshot version is older than the applied one',
  VERSION_CONFLICT: 'Same snapshot version with different content',
  SNAPSHOT_TOO_LARGE: 'Snapshot exceeds 64 KB',
  UNSUPPORTED_MEDIA_TYPE: 'Content-Type must be application/json',
  SNAPSHOT_INVALID: 'Snapshot does not satisfy ebim.entitlements/v1',
  ENVIRONMENT_MISMATCH: 'Snapshot environment differs from this receiver',
  CHECKSUM_MISMATCH: 'Checksum does not match the snapshot content',
  UNSUPPORTED_CONTRACT_VERSION: 'Only X-MasterAdmin-Contract: entitlements.v1 is supported',
  ENTITLEMENTS_FAILED: 'Entitlements could not be applied; nothing changed',
  ENTITLEMENTS_NOT_CONFIGURED: 'Entitlements synchronization is not enabled',
}

export function isEntitlementErrorCode(value: unknown): value is EntitlementErrorCode {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(ENTITLEMENT_ERROR_STATUS, value)
}

/** Cuerpo de error del contrato. Nunca incluye el snapshot recibido. */
export function entitlementErrorBody(code: EntitlementErrorCode, extra: { appliedVersion?: number | null } = {}) {
  return { error: code, message: MESSAGES[code], ...extra }
}

// ── Forma del snapshot (schema.json, escrita a mano, sin dependencias) ──────

const TOP_LEVEL_KEYS = [
  'schema', 'environment', 'controlPlaneTenantId', 'productCode', 'external', 'snapshotVersion', 'previousVersion',
  'effectiveAt', 'issuedAt', 'appActive', 'planCode', 'capabilities', 'limits', 'allowances', 'aiCredits',
  'correlationId', 'idempotencyKey', 'checksum',
].sort()

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
export const CAPABILITY_CODE_RE = /^[a-z0-9]+(\.[a-z0-9_]+)+$/
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

function exactKeys(v: Record<string, unknown>, required: string[], optional: string[] = []): boolean {
  const keys = Object.keys(v)
  return required.every((k) => k in v) && keys.every((k) => required.includes(k) || optional.includes(k))
}

function validScope(v: unknown): boolean {
  if (!isObject(v) || !exactKeys(v, ['level'], ['companyIds'])) return false
  if (v.level === 'TENANT') return !('companyIds' in v)
  if (v.level !== 'COMPANY') return false
  return !('companyIds' in v) || (Array.isArray(v.companyIds) && v.companyIds.every((c) => typeof c === 'string'))
}

function validSources(v: unknown): boolean {
  return Array.isArray(v) && v.every((s) => ['BASELINE', 'PLAN', 'ADDON', 'OVERRIDE'].includes(s as string))
}

export function isValidSnapshotShape(doc: unknown): doc is EntitlementSnapshot {
  if (!isObject(doc)) return false
  if (JSON.stringify(Object.keys(doc).sort()) !== JSON.stringify(TOP_LEVEL_KEYS)) return false
  const d = doc
  const ext = d.external
  return (
    d.schema === ENTITLEMENTS_SCHEMA &&
    ['DEV', 'QAS', 'DEMO', 'PRD'].includes(d.environment as string) &&
    typeof d.controlPlaneTenantId === 'string' && UUID_RE.test(d.controlPlaneTenantId) &&
    typeof d.productCode === 'string' && /^[a-z0-9]+$/.test(d.productCode) &&
    isObject(ext) && exactKeys(ext, ['tenantId', 'organizationId', 'companyIds']) &&
    typeof ext.tenantId === 'string' && (ext.organizationId === null || typeof ext.organizationId === 'string') &&
    Array.isArray(ext.companyIds) && ext.companyIds.every((c) => typeof c === 'string') &&
    Number.isInteger(d.snapshotVersion) && (d.snapshotVersion as number) >= 1 &&
    (d.previousVersion === null ||
      (Number.isInteger(d.previousVersion) && (d.previousVersion as number) < (d.snapshotVersion as number))) &&
    typeof d.effectiveAt === 'string' && ISO_RE.test(d.effectiveAt) &&
    typeof d.issuedAt === 'string' && ISO_RE.test(d.issuedAt) &&
    typeof d.appActive === 'boolean' &&
    (d.planCode === null || typeof d.planCode === 'string') &&
    Array.isArray(d.capabilities) && d.capabilities.every((c) =>
      isObject(c) && exactKeys(c, ['code', 'enabled', 'scope', 'sources']) && typeof c.code === 'string' &&
      CAPABILITY_CODE_RE.test(c.code) && typeof c.enabled === 'boolean' && validScope(c.scope) && validSources(c.sources)) &&
    Array.isArray(d.limits) && d.limits.every((l) =>
      isObject(l) && exactKeys(l, ['code', 'value', 'unit', 'enforcement', 'scope', 'sources']) &&
      typeof l.code === 'string' && CAPABILITY_CODE_RE.test(l.code) && typeof l.value === 'number' && l.value >= 0 &&
      (l.unit === null || typeof l.unit === 'string') && ['HARD', 'SOFT'].includes(l.enforcement as string) &&
      validScope(l.scope) && validSources(l.sources)) &&
    Array.isArray(d.allowances) && d.allowances.every((a) =>
      isObject(a) && exactKeys(a, ['code', 'meterCode', 'included', 'unit', 'period', 'overageMode', 'sources']) &&
      typeof a.code === 'string' && CAPABILITY_CODE_RE.test(a.code) && typeof a.meterCode === 'string' &&
      typeof a.included === 'number' && a.included >= 0 && (a.unit === null || typeof a.unit === 'string') &&
      isObject(a.period) && exactKeys(a.period, ['start', 'end']) && a.overageMode === 'BLOCK' &&
      validSources(a.sources)) &&
    isObject(d.aiCredits) && exactKeys(d.aiCredits, ['weights', 'weightsVersion']) &&
    Array.isArray(d.aiCredits.weights) && Number.isInteger(d.aiCredits.weightsVersion) &&
    typeof d.correlationId === 'string' && UUID_RE.test(d.correlationId) &&
    typeof d.idempotencyKey === 'string' && /^ma-ent-v1-[0-9a-f]{64}$/.test(d.idempotencyKey) &&
    typeof d.checksum === 'string' && /^sha256:[0-9a-f]{64}$/.test(d.checksum)
  )
}

// ── Claves y valores prohibidos (FIX-ENT-v1 §2): precios y secretos nunca ───

const FORBIDDEN_KEY_FRAGMENTS = ['price', 'amount', 'currency', 'cost', 'secret', 'token', 'email', 'key', 'password']
const ALLOWED_KEYS = new Set(['idempotencyKey'])
const FORBIDDEN_VALUE_PATTERNS = [
  /[^\s@]+@[^\s@]+\.[^\s@]+/,
  /-----BEGIN [A-Z ]+-----/,
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\./,
]

/** `true` si el documento no contiene claves ni valores prohibidos. */
export function isSnapshotSafe(document: unknown): boolean {
  if (Array.isArray(document)) return document.every((item) => isSnapshotSafe(item))
  if (document !== null && typeof document === 'object') {
    return Object.entries(document as Record<string, unknown>).every(([key, value]) => {
      const lower = key.toLowerCase()
      if (!ALLOWED_KEYS.has(key) && FORBIDDEN_KEY_FRAGMENTS.some((f) => lower.includes(f))) return false
      return isSnapshotSafe(value)
    })
  }
  if (typeof document === 'string') return !FORBIDDEN_VALUE_PATTERNS.some((re) => re.test(document))
  return true
}
