/**
 * Emisor del outbox de uso de eCommerce hacia EBIM MasterAdmin (CCP fase 17).
 *
 * Núcleo PURO con inyección de dependencias: sin `jsr:`/`npm:`, sin `Deno`,
 * sin base. Lo importan la Edge Function `usage-outbox-worker` (que resuelve los
 * puertos contra Supabase y `fetch`) y Node/tsx/Vitest.
 *
 *   reclamar → mapear fila → evento → lotes (≤ 500 / ≤ 256 KB)
 *     → JWT ES256 NUEVO por intento → POST → clasificar por posición → marcar
 *
 * **Apagado por defecto**: si `USAGE_OUTBOX_SENDER_ENABLED !== 'true'` no
 * reclama, no firma y no llama a nadie. Encendido sin configuración completa,
 * tampoco reclama (no deja filas con lease sin intentar).
 *
 * Variables (solo NOMBRES; los valores viven en los secretos del runtime):
 *   USAGE_OUTBOX_SENDER_ENABLED   'true' para encender
 *   MASTERADMIN_USAGE_INGEST_URL  https://…/functions/v1/usage-ingest
 *   ECOMMERCE_USAGE_PRIVATE_KEY   PKCS#8 PEM, EC P-256
 *   EBIM_USAGE_ENVIRONMENT        DEV | QAS | DEMO | PRD
 */
import {
  chunkUsageEvents,
  classifyBatchResponse,
  ECOMMERCE_USAGE_METERS,
  importSenderPrivateKey,
  INTERNAL_KEYS,
  signUsageToken,
  USAGE_ENVIRONMENTS,
  USAGE_ISSUER,
  USAGE_PRODUCT_CODE,
  UsageEventInvalid,
  validateUsageEvent,
  type EventDisposition,
  type UsageBatch,
  type UsageEnvironment,
  type UsageEvent,
  type UsageInternal,
} from './contract.ts'

export const USAGE_SENDER_ENV = {
  enabled: 'USAGE_OUTBOX_SENDER_ENABLED',
  url: 'MASTERADMIN_USAGE_INGEST_URL',
  privateKey: 'ECOMMERCE_USAGE_PRIVATE_KEY',
  environment: 'EBIM_USAGE_ENVIRONMENT',
} as const

/** Fila tal como la devuelve `public.platform_usage_outbox_claim`. */
export interface UsageOutboxRow {
  event_id: string
  occurred_at: string
  meter_code: string
  /** `numeric`: puede llegar como número o como texto. */
  quantity: number | string
  unit: string
  control_plane_tenant_id: string | null
  external_company_id: string | null
  capability_code: string | null
  internal: Record<string, unknown> | null
  attempts: number
}

export interface BuildUsageEventContext {
  /** Medidores permitidos (por defecto los de eCommerce en `meters.json`). */
  readonly meters?: ReadonlyArray<{ readonly code: string; readonly unit: string }>
}

/**
 * Fila del outbox → evento `ebim.usage/v1`. Determinista: la misma fila da el
 * mismo evento en cada reintento (MasterAdmin responde DUPLICATE, no CONFLICT).
 * Lanza `UsageEventInvalid` con el código del contrato si la fila no es
 * enviable.
 */
export function buildUsageEvent(row: UsageOutboxRow, ctx: BuildUsageEventContext = {}): UsageEvent {
  const meters = ctx.meters ?? ECOMMERCE_USAGE_METERS
  if (!row.control_plane_tenant_id) throw new UsageEventInvalid('TENANT_NOT_MAPPED')
  const meter = meters.find((m) => m.code === row.meter_code)
  if (!meter) throw new UsageEventInvalid('UNKNOWN_METER')
  if (row.unit !== meter.unit) throw new UsageEventInvalid('UNIT_MISMATCH')

  const quantity = typeof row.quantity === 'string' ? Number(row.quantity) : row.quantity
  const occurred = Date.parse(row.occurred_at)
  if (Number.isNaN(occurred)) throw new UsageEventInvalid('OCCURRED_AT_INVALID')

  const event: UsageEvent = {
    eventId: row.event_id,
    meterCode: row.meter_code,
    quantity,
    unit: row.unit,
    occurredAt: new Date(occurred).toISOString(),
    controlPlaneTenantId: row.control_plane_tenant_id,
  }
  if (row.external_company_id) event.externalCompanyId = row.external_company_id
  if (row.capability_code) event.capabilityCode = row.capability_code
  const internal = pickInternal(row.internal)
  if (internal) event.internal = internal

  validateUsageEvent(event)
  return event
}

/** Solo las claves COGS del contrato; cualquier otra cosa (texto, datos) se descarta. */
function pickInternal(raw: Record<string, unknown> | null): UsageInternal | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(raw)) {
    if (INTERNAL_KEYS.has(k) && v !== null && v !== undefined) out[k] = v
  }
  return Object.keys(out).length ? (out as UsageInternal) : undefined
}

// ---------------------------------------------------------------------------
// Emisor
// ---------------------------------------------------------------------------

export interface UsageOutboxSenderDeps {
  /** Lector de variables de entorno (Deno.env.get / process.env). */
  readonly env: (name: string) => string | undefined
  /** `public.platform_usage_outbox_claim(limit, lease)`. */
  readonly claim: (limit: number) => Promise<UsageOutboxRow[]>
  /** `public.platform_usage_outbox_mark(results)`. */
  readonly mark: (results: EventDisposition[]) => Promise<void>
  readonly fetchImpl: typeof fetch
  readonly nowMs?: () => number
  readonly randomUUID?: () => string
  /** Filas por pasada (por defecto 500, máximo 5000). */
  readonly claimLimit?: number
  readonly timeoutMs?: number
  /** TTL del JWT (≤ 300 s; por defecto 120 s). */
  readonly tokenTtlSeconds?: number
}

export interface UsageOutboxSenderReport {
  status: 'DISABLED' | 'MISCONFIGURED' | 'OK'
  /** Nombres (nunca valores) de las variables que faltan o no son válidas. */
  missing?: string[]
  claimed: number
  batches: number
  sent: number
  dead: number
  retry: number
}

interface SenderConfig {
  url: string
  privateKeyPem: string
  environment: UsageEnvironment
}

function isAllowedUrl(raw: string): boolean {
  try {
    const u = new URL(raw)
    if (u.username || u.password) return false
    if (u.protocol === 'https:') return true
    return u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]', 'host.docker.internal'].includes(u.hostname)
  } catch {
    return false
  }
}

function readConfig(env: (name: string) => string | undefined): SenderConfig | { missing: string[] } {
  const missing: string[] = []
  const url = (env(USAGE_SENDER_ENV.url) ?? '').trim()
  if (!url || !isAllowedUrl(url)) missing.push(USAGE_SENDER_ENV.url)
  const privateKeyPem = env(USAGE_SENDER_ENV.privateKey) ?? ''
  if (!privateKeyPem.trim()) missing.push(USAGE_SENDER_ENV.privateKey)
  const environment = (env(USAGE_SENDER_ENV.environment) ?? '').trim()
  if (!(USAGE_ENVIRONMENTS as readonly string[]).includes(environment)) missing.push(USAGE_SENDER_ENV.environment)
  if (missing.length) return { missing }
  return { url, privateKeyPem, environment: environment as UsageEnvironment }
}

const emptyReport = (status: UsageOutboxSenderReport['status']): UsageOutboxSenderReport => ({
  status,
  claimed: 0,
  batches: 0,
  sent: 0,
  dead: 0,
  retry: 0,
})

/**
 * Una pasada del emisor. Nunca lanza por la respuesta de MasterAdmin (todo se
 * clasifica); sí propaga un fallo de `claim`/`mark` (la base), para que el
 * llamador responda 503 y el planificador reintente — el lease devuelve las
 * filas solas.
 */
export async function runUsageOutboxSender(deps: UsageOutboxSenderDeps): Promise<UsageOutboxSenderReport> {
  if (deps.env(USAGE_SENDER_ENV.enabled) !== 'true') return emptyReport('DISABLED')

  const config = readConfig(deps.env)
  if ('missing' in config) return { ...emptyReport('MISCONFIGURED'), missing: config.missing }

  let privateKey: CryptoKey
  try {
    privateKey = await importSenderPrivateKey(config.privateKeyPem)
  } catch {
    return { ...emptyReport('MISCONFIGURED'), missing: [USAGE_SENDER_ENV.privateKey] }
  }

  const now = deps.nowMs ?? (() => Date.now())
  const uuid = deps.randomUUID ?? (() => crypto.randomUUID())
  const limit = Math.min(Math.max(Math.floor(deps.claimLimit ?? 500), 1), 5000)
  const report = emptyReport('OK')

  const rows = await deps.claim(limit)
  report.claimed = rows.length
  if (!rows.length) return report

  const tally = (dispositions: EventDisposition[]) => {
    for (const d of dispositions) {
      if (d.outcome === 'SENT') report.sent += 1
      else if (d.outcome === 'DEAD') report.dead += 1
      else report.retry += 1
    }
  }

  // Mapeo: una fila no enviable no frena al resto.
  const events: UsageEvent[] = []
  const local: EventDisposition[] = []
  for (const row of rows) {
    try {
      events.push(buildUsageEvent(row))
    } catch (error) {
      const code = error instanceof UsageEventInvalid ? error.code : 'INVALID_EVENT'
      // Sin tenant no se envía NI se descarta: queda esperando su mapping.
      local.push(
        code === 'TENANT_NOT_MAPPED'
          ? { eventId: row.event_id, outcome: 'RETRY', code }
          : { eventId: row.event_id, outcome: 'DEAD', code },
      )
    }
  }
  if (local.length) {
    await deps.mark(local)
    tally(local)
  }

  const batches = chunkUsageEvents(
    events,
    { environment: config.environment, productCode: USAGE_PRODUCT_CODE },
    uuid,
  )
  for (const batch of batches) {
    report.batches += 1
    // JWT nuevo por intento: jti de un solo uso en MasterAdmin.
    const token = await signUsageToken({
      issuer: USAGE_ISSUER,
      privateKey,
      nowSeconds: Math.floor(now() / 1000),
      jti: uuid(),
      ttlSeconds: deps.tokenTtlSeconds ?? 120,
    })
    const dispositions = await postBatch(deps, config.url, batch, token)
    await deps.mark(dispositions)
    tally(dispositions)
  }
  return report
}

async function postBatch(
  deps: UsageOutboxSenderDeps,
  url: string,
  batch: UsageBatch,
  token: string,
): Promise<EventDisposition[]> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? 15_000)
  try {
    const res = await deps.fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(batch),
      signal: controller.signal,
      // Un cuerpo firmado no se reenvía a otra URL.
      redirect: 'manual',
    })
    let body: unknown = null
    try {
      body = await res.json()
    } catch {
      body = null
    }
    return classifyBatchResponse(batch, res.status, body)
  } catch {
    return classifyBatchResponse(batch, null, null)
  } finally {
    clearTimeout(timer)
  }
}
