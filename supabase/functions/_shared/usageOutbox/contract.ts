/**
 * Contrato `ebim.usage/v1` (FIX-USG-v1) del lado emisor de eCommerce.
 *
 * TypeScript PURO y neutral de runtime (WebCrypto + `fetch` inyectable): lo
 * importan la Edge Function (Deno), Vitest y cualquier script de Node/tsx. Sin
 * especificadores `jsr:`/`npm:`.
 *
 * Reproduce el comportamiento del emisor de referencia del contrato
 * (`supabase/tests/fixtures/usage-v1/reference-sender.ts`, fijado por checksum)
 * sin importarlo en tiempo de ejecución: el runtime no depende de `tests/`.
 * `supabase/tests/usage-outbox-sender.test.ts` prueba la paridad con los
 * vectores vendorizados y con la referencia.
 */

export const USAGE_SCHEMA = 'ebim.usage/v1'
export const USAGE_AUDIENCE = 'masteradmin.ebim'
export const USAGE_SCOPE = 'usage:ingest'
export const USAGE_PRODUCT_CODE = 'ecommerce'
export const USAGE_ISSUER = 'ecommerce.ebim'
export const MAX_EVENTS = 500
export const MAX_BODY_BYTES = 256 * 1024
export const MAX_TOKEN_TTL_SECONDS = 300

/** Medidores que eCommerce emite en v1 (`meters.json`, productCode `ecommerce`). */
export const ECOMMERCE_USAGE_METERS: ReadonlyArray<{ readonly code: string; readonly unit: string }> = [
  { code: 'ecommerce.ai.calls', unit: 'call' },
]

export type UsageEnvironment = 'DEV' | 'QAS' | 'DEMO' | 'PRD'
export const USAGE_ENVIRONMENTS: readonly UsageEnvironment[] = ['DEV', 'QAS', 'DEMO', 'PRD']

export interface UsageInternal {
  provider?: string
  model?: string
  inputTokens?: number
  outputTokens?: number
  cacheTokens?: number
  latencyMs?: number
  costAmount?: number
  costCurrency?: string
}

export interface UsageEvent {
  eventId: string
  meterCode: string
  quantity: number
  unit: string
  occurredAt: string
  controlPlaneTenantId: string
  externalCompanyId?: string
  subjectRef?: string
  capabilityCode?: string
  internal?: UsageInternal
}

export interface UsageBatch {
  schema: typeof USAGE_SCHEMA
  environment: UsageEnvironment
  productCode: string
  batchId: string
  events: UsageEvent[]
}

export type Outcome = 'SENT' | 'DEAD' | 'RETRY'

export interface EventDisposition {
  eventId: string
  outcome: Outcome
  code?: string
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const METER_RE = /^[a-z0-9]+([._][a-z0-9]+)*$/
const UNIT_RE = /^[a-z0-9]+(_[a-z0-9]+)*$/
const CAP_RE = /^[a-z0-9]+(\.[a-z0-9_]+)+$/
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/
export const INTERNAL_KEYS: ReadonlySet<string> = new Set([
  'provider',
  'model',
  'inputTokens',
  'outputTokens',
  'cacheTokens',
  'latencyMs',
  'costAmount',
  'costCurrency',
])
const COUNTER_KEYS = ['inputTokens', 'outputTokens', 'cacheTokens', 'latencyMs'] as const

// Sin «parameter properties»: el archivo carga también con el strip-types de
// Node (`node file.ts`), sin tsx.
export class UsageEventInvalid extends Error {
  readonly code: string
  constructor(code: string) {
    super(code)
    this.code = code
    this.name = 'UsageEventInvalid'
  }
}

/** Validación en origen, idéntica a la del contrato. */
export function validateUsageEvent(event: UsageEvent, opts: { allowsNegative?: boolean } = {}): void {
  if (!UUID_RE.test(event.eventId ?? '')) throw new UsageEventInvalid('EVENT_ID_INVALID')
  if (!UUID_RE.test(event.controlPlaneTenantId ?? '')) throw new UsageEventInvalid('TENANT_REQUIRED')
  if (!METER_RE.test(event.meterCode ?? '')) throw new UsageEventInvalid('METER_CODE_INVALID')
  if (!UNIT_RE.test(event.unit ?? '')) throw new UsageEventInvalid('UNIT_INVALID')
  if (typeof event.quantity !== 'number' || !Number.isFinite(event.quantity)) {
    throw new UsageEventInvalid('QUANTITY_INVALID')
  }
  if (event.quantity < 0 && !opts.allowsNegative) throw new UsageEventInvalid('NEGATIVE_QUANTITY')
  if (Math.abs(event.quantity) >= 1e14 || Math.round(event.quantity * 1e6) / 1e6 !== event.quantity) {
    throw new UsageEventInvalid('QUANTITY_INVALID')
  }
  if (!ISO_RE.test(event.occurredAt ?? '') || Number.isNaN(Date.parse(event.occurredAt))) {
    throw new UsageEventInvalid('OCCURRED_AT_INVALID')
  }
  for (const k of ['externalCompanyId', 'subjectRef'] as const) {
    const v = event[k]
    if (v !== undefined && (typeof v !== 'string' || v.length < 1 || v.length > 200)) {
      throw new UsageEventInvalid('REFERENCE_INVALID')
    }
  }
  if (event.capabilityCode !== undefined && !CAP_RE.test(event.capabilityCode)) {
    throw new UsageEventInvalid('CAPABILITY_CODE_INVALID')
  }
  if (event.internal !== undefined) validateInternal(event.internal)
}

function validateInternal(internal: UsageInternal): void {
  if (internal === null || typeof internal !== 'object' || Array.isArray(internal)) {
    throw new UsageEventInvalid('INTERNAL_METADATA_INVALID')
  }
  for (const [k, v] of Object.entries(internal)) {
    if (!INTERNAL_KEYS.has(k)) throw new UsageEventInvalid('INTERNAL_METADATA_INVALID')
    if (v === undefined) continue
    if ((k === 'provider' || k === 'model') && !(typeof v === 'string' && v.length >= 1 && v.length <= 100)) {
      throw new UsageEventInvalid('INTERNAL_METADATA_INVALID')
    }
    if ((COUNTER_KEYS as readonly string[]).includes(k) && !(Number.isSafeInteger(v) && (v as number) >= 0)) {
      throw new UsageEventInvalid('INTERNAL_METADATA_INVALID')
    }
    if (k === 'costAmount' && !(typeof v === 'number' && Number.isFinite(v) && v >= 0)) {
      throw new UsageEventInvalid('INTERNAL_METADATA_INVALID')
    }
    if (k === 'costCurrency' && !(typeof v === 'string' && /^[A-Z]{3}$/.test(v))) {
      throw new UsageEventInvalid('INTERNAL_METADATA_INVALID')
    }
  }
}

// ---------------------------------------------------------------------------
// Lotes
// ---------------------------------------------------------------------------

const byteLength = (s: string) => new TextEncoder().encode(s).length

/** Parte los eventos en lotes que respetan 500 eventos y 256 KB. Orden estable. */
export function chunkUsageEvents(
  events: UsageEvent[],
  meta: { environment: UsageEnvironment; productCode: string },
  newBatchId: () => string,
): UsageBatch[] {
  const batches: UsageBatch[] = []
  const envelope = (evs: UsageEvent[], batchId: string): UsageBatch => ({
    schema: USAGE_SCHEMA,
    environment: meta.environment,
    productCode: meta.productCode,
    batchId,
    events: evs,
  })
  const PROBE_ID = '00000000-0000-4000-8000-000000000000'
  // Tamaño incremental: sobre vacío + cada evento + separadores. Mismo
  // resultado que serializar el lote entero, sin el coste cuadrático.
  const emptyBytes = byteLength(JSON.stringify(envelope([], PROBE_ID)))
  let current: UsageEvent[] = []
  let currentBytes = emptyBytes
  for (const e of events) {
    const eventBytes = byteLength(JSON.stringify(e))
    if (emptyBytes + eventBytes > MAX_BODY_BYTES) throw new UsageEventInvalid('EVENT_TOO_LARGE')
    const nextBytes = currentBytes + eventBytes + (current.length ? 1 : 0)
    if (current.length < MAX_EVENTS && nextBytes <= MAX_BODY_BYTES) {
      current.push(e)
      currentBytes = nextBytes
    } else {
      batches.push(envelope(current, newBatchId()))
      current = [e]
      currentBytes = emptyBytes + eventBytes
    }
  }
  if (current.length) batches.push(envelope(current, newBatchId()))
  return batches
}

// ---------------------------------------------------------------------------
// Firma ES256 (clave privada PKCS#8 PEM de eCommerce; nunca sale de eCommerce)
// ---------------------------------------------------------------------------

function b64url(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export async function importSenderPrivateKey(pkcs8Pem: string): Promise<CryptoKey> {
  // Los secretos de runtime suelen llegar con `\n` literales.
  const body = pkcs8Pem
    .replace(/\\n/g, '\n')
    .replace(/-----(BEGIN|END) PRIVATE KEY-----/g, '')
    .replace(/\s+/g, '')
  const bin = atob(body)
  const der = new Uint8Array(new ArrayBuffer(bin.length))
  for (let i = 0; i < bin.length; i += 1) der[i] = bin.charCodeAt(i)
  return crypto.subtle.importKey('pkcs8', der, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'])
}

export async function signUsageToken(opts: {
  issuer: string
  privateKey: CryptoKey
  nowSeconds: number
  jti: string
  ttlSeconds?: number
}): Promise<string> {
  const ttl = opts.ttlSeconds ?? 120
  if (ttl < 1 || ttl > MAX_TOKEN_TTL_SECONDS) throw new Error('TTL_INVALID')
  const header = { alg: 'ES256', typ: 'JWT' }
  const claims = {
    iss: opts.issuer,
    aud: USAGE_AUDIENCE,
    scope: USAGE_SCOPE,
    iat: opts.nowSeconds,
    exp: opts.nowSeconds + ttl,
    jti: opts.jti,
  }
  const enc = (v: unknown) => b64url(new TextEncoder().encode(JSON.stringify(v)))
  const input = `${enc(header)}.${enc(claims)}`
  const sig = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    opts.privateKey,
    new TextEncoder().encode(input),
  )
  return `${input}.${b64url(new Uint8Array(sig))}`
}

// ---------------------------------------------------------------------------
// Respuesta → qué hace el outbox con cada evento (por POSICIÓN)
// ---------------------------------------------------------------------------

export function classifyBatchResponse(
  batch: Pick<UsageBatch, 'events'>,
  status: number | null,
  body: unknown,
): EventDisposition[] {
  const ids = batch.events.map((e) => e.eventId)
  const all = (outcome: Outcome, code?: string): EventDisposition[] =>
    ids.map((eventId) => (code ? { eventId, outcome, code } : { eventId, outcome }))

  if (status === null) return all('RETRY', 'TRANSPORT_ERROR')
  const b = (body ?? {}) as { error?: unknown; results?: unknown }
  if (status !== 200) {
    // Un error de LOTE nunca descarta eventos.
    const code = typeof b.error === 'string' ? b.error : `HTTP_${status}`
    return all('RETRY', code)
  }
  const results = Array.isArray(b.results)
    ? (b.results as Array<{ eventId?: unknown; status?: unknown; code?: unknown } | null | undefined>)
    : []
  return ids.map((eventId, i): EventDisposition => {
    const r = results[i]
    if (!r || typeof r.eventId !== 'string' || r.eventId.toLowerCase() !== eventId.toLowerCase()) {
      return { eventId, outcome: 'RETRY', code: 'MISSING_RESULT' }
    }
    if (r.status === 'ACCEPTED' || r.status === 'DUPLICATE') return { eventId, outcome: 'SENT' }
    if (r.status === 'REJECTED') {
      return { eventId, outcome: 'DEAD', code: typeof r.code === 'string' ? r.code : 'REJECTED' }
    }
    return { eventId, outcome: 'RETRY', code: 'UNKNOWN_STATUS' }
  })
}

/** Backoff exponencial: 30 s · 2^(n−1), tope 6 h. `attempt` empieza en 1. */
export function nextBackoffSeconds(attempt: number): number {
  const n = Math.max(1, Math.floor(attempt))
  return Math.min(30 * 2 ** (n - 1), 6 * 3600)
}
