// @vitest-environment node
/**
 * Emisor del outbox de uso (CCP fase 17) — núcleo puro, sin red y sin base.
 *
 *   · mapeo fila → evento `ebim.usage/v1` (medidor, unidad, capacidad, internal);
 *   · apagado por defecto (`USAGE_OUTBOX_SENDER_ENABLED !== 'true'`): ni reclama
 *     ni llama a nadie;
 *   · clasificación con los vectores VENDORIZADOS de FIX-USG-v1 y paridad con el
 *     emisor de referencia del contrato;
 *   · JWT ES256 nuevo (jti nuevo) por intento, claims del contrato, TTL ≤ 300 s;
 *   · lotes ≤ 500 eventos y ≤ 256 KB.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import {
  buildUsageEvent,
  runUsageOutboxSender,
  type UsageOutboxRow,
  type UsageOutboxSenderDeps,
} from '../functions/_shared/usageOutbox/sender.ts'
import {
  chunkUsageEvents,
  classifyBatchResponse,
  MAX_BODY_BYTES,
  MAX_EVENTS,
  nextBackoffSeconds,
  type EventDisposition,
  type UsageEvent,
} from '../functions/_shared/usageOutbox/contract.ts'
import * as reference from './fixtures/usage-v1/reference-sender.ts'

const DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'usage-v1')
const vectors = JSON.parse(readFileSync(join(DIR, 'expected', 'classification-vectors.json'), 'utf8')) as {
  backoffSeconds: { samples: [number, number][] }
  vectors: {
    name: string
    batch: { eventId: string }[]
    response: { status: number | null; body: unknown }
    expect: EventDisposition[]
  }[]
}

const CPT = '17a00000-0000-4000-8000-00000000000a'
const COMPANY = '0a000000-0000-4000-8000-0000000000c1'

let seq = 0
function row(overrides: Partial<UsageOutboxRow> = {}): UsageOutboxRow {
  seq += 1
  return {
    event_id: `00000000-0000-4ccc-8000-${seq.toString(16).padStart(12, '0')}`,
    occurred_at: '2026-10-02T10:15:30.123456+00:00',
    meter_code: 'ecommerce.ai.calls',
    quantity: 1,
    unit: 'call',
    control_plane_tenant_id: CPT,
    external_company_id: COMPANY,
    capability_code: 'ecommerce.ai.content',
    internal: { provider: 'anthropic', model: 'claude-sonnet-5', inputTokens: 120, outputTokens: 45, latencyMs: 850 },
    attempts: 0,
    ...overrides,
  }
}

function b64urlToBytes(s: string): Uint8Array<ArrayBuffer> {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4)
  const raw = Buffer.from(b64, 'base64')
  const out = new Uint8Array(new ArrayBuffer(raw.length))
  out.set(raw)
  return out
}
const decodePart = (s: string) => JSON.parse(Buffer.from(b64urlToBytes(s)).toString('utf8')) as Record<string, unknown>

async function ephemeralKey(): Promise<{ pem: string; publicKey: CryptoKey }> {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair
  const der = Buffer.from(await crypto.subtle.exportKey('pkcs8', pair.privateKey)).toString('base64')
  const label = ['PRIVATE', 'KEY'].join(' ')
  const pem = `-----BEGIN ${label}-----\n${der.match(/.{1,64}/g)!.join('\n')}\n-----END ${label}-----\n`
  return { pem, publicKey: pair.publicKey }
}

type Call = { url: string; token: string; body: { batchId: string; events: UsageEvent[]; environment: string; productCode: string; schema: string } }

function harness(opts: {
  env?: Record<string, string | undefined>
  rows?: UsageOutboxRow[]
  respond?: (call: Call) => { status: number; body: unknown } | 'throw'
}) {
  const calls: Call[] = []
  const marks: EventDisposition[][] = []
  const claim = vi.fn(async () => opts.rows ?? [])
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const call: Call = {
      url: String(url),
      token: String((init?.headers as Record<string, string>).authorization).replace(/^Bearer /, ''),
      body: JSON.parse(String(init?.body)),
    }
    calls.push(call)
    const r = opts.respond
      ? opts.respond(call)
      : { status: 200, body: { results: call.body.events.map((e) => ({ eventId: e.eventId, status: 'ACCEPTED' })) } }
    if (r === 'throw') throw new TypeError('fetch failed')
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'content-type': 'application/json' } })
  })
  const deps: UsageOutboxSenderDeps = {
    env: (name) => opts.env?.[name],
    claim,
    mark: async (results) => {
      marks.push(results)
    },
    fetchImpl: fetchImpl as unknown as typeof fetch,
    nowMs: () => Date.parse('2026-10-02T10:20:00Z'),
  }
  return { deps, calls, marks, claim, fetchImpl }
}

async function enabledEnv(extra: Record<string, string> = {}) {
  const key = await ephemeralKey()
  return {
    key,
    env: {
      USAGE_OUTBOX_SENDER_ENABLED: 'true',
      MASTERADMIN_USAGE_INGEST_URL: 'https://masteradmin.example.test/functions/v1/usage-ingest',
      ECOMMERCE_USAGE_PRIVATE_KEY: key.pem,
      EBIM_USAGE_ENVIRONMENT: 'DEV',
      ...extra,
    },
  }
}

describe('buildUsageEvent: fila del outbox → evento ebim.usage/v1', () => {
  it('mapea medidor, unidad, tenant, sociedad, capacidad e internal', () => {
    const r = row()
    expect(buildUsageEvent(r)).toEqual({
      eventId: r.event_id,
      meterCode: 'ecommerce.ai.calls',
      quantity: 1,
      unit: 'call',
      occurredAt: '2026-10-02T10:15:30.123Z',
      controlPlaneTenantId: CPT,
      externalCompanyId: COMPANY,
      capabilityCode: 'ecommerce.ai.content',
      internal: { provider: 'anthropic', model: 'claude-sonnet-5', inputTokens: 120, outputTokens: 45, latencyMs: 850 },
    })
  })

  it('es estable ante reintentos (mismo contenido → DUPLICATE, no CONFLICT)', () => {
    const r = row()
    expect(JSON.stringify(buildUsageEvent(r))).toBe(JSON.stringify(buildUsageEvent({ ...r, attempts: 7 })))
  })

  it('numeric llega como texto: se convierte a número', () => {
    expect(buildUsageEvent(row({ quantity: '1' })).quantity).toBe(1)
  })

  it('omite lo que no hay: sin capacidad, sin sociedad, sin internal', () => {
    const e = buildUsageEvent(row({ capability_code: null, external_company_id: null, internal: {} }))
    expect(e).not.toHaveProperty('capabilityCode')
    expect(e).not.toHaveProperty('externalCompanyId')
    expect(e).not.toHaveProperty('internal')
  })

  it('internal: solo claves COGS; texto o claves ajenas no pasan', () => {
    const e = buildUsageEvent(row({ internal: { inputTokens: 3, prompt: 'hola', reply: 'x', costAmount: 0.01 } }))
    expect(e.internal).toEqual({ inputTokens: 3, costAmount: 0.01 })
  })

  it('medidor o unidad fuera del contrato → inválido', () => {
    expect(() => buildUsageEvent(row({ meter_code: 'ecommerce.ai.credits' }))).toThrow(/UNKNOWN_METER/)
    expect(() => buildUsageEvent(row({ unit: 'credit' }))).toThrow(/UNIT_MISMATCH/)
  })

  it('sin tenant no hay evento', () => {
    expect(() => buildUsageEvent(row({ control_plane_tenant_id: null }))).toThrow(/TENANT_NOT_MAPPED/)
  })

  it('cantidad negativa → inválido', () => {
    expect(() => buildUsageEvent(row({ quantity: -1 }))).toThrow(/NEGATIVE_QUANTITY/)
  })
})

describe('apagado por defecto', () => {
  it.each([undefined, '', 'false', 'TRUE', '1', 'yes'])('USAGE_OUTBOX_SENDER_ENABLED=%s → no reclama ni envía', async (flag) => {
    const { env } = await enabledEnv()
    const h = harness({ env: { ...env, USAGE_OUTBOX_SENDER_ENABLED: flag }, rows: [row()] })
    const report = await runUsageOutboxSender(h.deps)
    expect(report.status).toBe('DISABLED')
    expect(h.claim).not.toHaveBeenCalled()
    expect(h.fetchImpl).not.toHaveBeenCalled()
    expect(h.marks).toEqual([])
  })

  it('encendido sin configuración completa → MISCONFIGURED, sin reclamar', async () => {
    const h = harness({ env: { USAGE_OUTBOX_SENDER_ENABLED: 'true' }, rows: [row()] })
    const report = await runUsageOutboxSender(h.deps)
    expect(report.status).toBe('MISCONFIGURED')
    expect(report.missing).toEqual([
      'MASTERADMIN_USAGE_INGEST_URL',
      'ECOMMERCE_USAGE_PRIVATE_KEY',
      'EBIM_USAGE_ENVIRONMENT',
    ])
    expect(h.claim).not.toHaveBeenCalled()
    expect(h.fetchImpl).not.toHaveBeenCalled()
  })

  it('URL sin https (fuera de localhost) → MISCONFIGURED', async () => {
    const { env } = await enabledEnv({ MASTERADMIN_USAGE_INGEST_URL: 'http://masteradmin.example.test/x' })
    const h = harness({ env, rows: [row()] })
    const report = await runUsageOutboxSender(h.deps)
    expect(report.status).toBe('MISCONFIGURED')
    expect(report.missing).toEqual(['MASTERADMIN_USAGE_INGEST_URL'])
  })

  it('ambiente fuera de DEV/QAS/DEMO/PRD → MISCONFIGURED', async () => {
    const { env } = await enabledEnv({ EBIM_USAGE_ENVIRONMENT: 'prod' })
    const report = await runUsageOutboxSender(harness({ env }).deps)
    expect(report).toMatchObject({ status: 'MISCONFIGURED', missing: ['EBIM_USAGE_ENVIRONMENT'] })
  })

  it('el informe nunca incluye la clave', async () => {
    const { env, key } = await enabledEnv()
    const report = await runUsageOutboxSender(harness({ env, rows: [row()] }).deps)
    expect(JSON.stringify(report)).not.toContain(key.pem.slice(40, 80))
  })
})

describe('clasificación: vectores vendorizados de FIX-USG-v1', () => {
  it.each(vectors.vectors.map((v) => [v.name, v] as const))('%s (función pura)', (_name, v) => {
    expect(classifyBatchResponse({ events: v.batch as UsageEvent[] }, v.response.status, v.response.body)).toEqual(v.expect)
    // Paridad con el emisor de referencia del contrato.
    expect(classifyBatchResponse({ events: v.batch as UsageEvent[] }, v.response.status, v.response.body)).toEqual(
      reference.classifyBatchResponse({ events: v.batch as reference.UsageEvent[] }, v.response.status, v.response.body),
    )
  })

  it.each(vectors.vectors.map((v) => [v.name, v] as const))('%s (emisor completo → marcas)', async (_name, v) => {
    const { env } = await enabledEnv()
    const rows = v.batch.map((b) => row({ event_id: b.eventId }))
    const h = harness({
      env,
      rows,
      respond: () => (v.response.status === null ? 'throw' : { status: v.response.status, body: v.response.body }),
    })
    await runUsageOutboxSender(h.deps)
    expect(h.marks.flat()).toEqual(v.expect)
  })

  it('backoff del contrato', () => {
    for (const [attempt, seconds] of vectors.backoffSeconds.samples) {
      expect(nextBackoffSeconds(attempt)).toBe(seconds)
      expect(reference.nextBackoffSeconds(attempt)).toBe(seconds)
    }
  })
})

describe('envío', () => {
  it('lote del contrato, firmado ES256 con iss/aud/scope y TTL ≤ 300 s', async () => {
    const { env, key } = await enabledEnv()
    const h = harness({ env, rows: [row(), row()] })
    const report = await runUsageOutboxSender(h.deps)
    expect(report).toMatchObject({ status: 'OK', claimed: 2, batches: 1, sent: 2, dead: 0, retry: 0 })
    expect(h.calls).toHaveLength(1)
    const call = h.calls[0]!
    expect(call.url).toBe(env.MASTERADMIN_USAGE_INGEST_URL)
    expect(call.body).toMatchObject({ schema: 'ebim.usage/v1', environment: 'DEV', productCode: 'ecommerce' })
    expect(call.body.batchId).toMatch(/^[0-9a-f-]{36}$/)
    const [h64, p64, s64] = call.token.split('.') as [string, string, string]
    expect(decodePart(h64)).toEqual({ alg: 'ES256', typ: 'JWT' })
    const claims = decodePart(p64)
    expect(claims).toMatchObject({ iss: 'ecommerce.ebim', aud: 'masteradmin.ebim', scope: 'usage:ingest' })
    expect((claims.exp as number) - (claims.iat as number)).toBeLessThanOrEqual(300)
    expect(claims.iat).toBe(Math.floor(Date.parse('2026-10-02T10:20:00Z') / 1000))
    const ok = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      key.publicKey,
      b64urlToBytes(s64),
      new TextEncoder().encode(`${h64}.${p64}`),
    )
    expect(ok).toBe(true)
  })

  it('JWT y batchId nuevos por intento (por lote y por pasada)', async () => {
    const { env } = await enabledEnv()
    const rows = Array.from({ length: 501 }, () => row())
    const h = harness({ env, rows, respond: () => ({ status: 503, body: { error: 'USAGE_INGEST_DISABLED' } }) })
    await runUsageOutboxSender(h.deps)
    await runUsageOutboxSender(h.deps)
    expect(h.calls).toHaveLength(4)
    const jtis = h.calls.map((c) => decodePart(c.token.split('.')[1]!).jti)
    expect(new Set(jtis).size).toBe(4)
    expect(new Set(h.calls.map((c) => c.body.batchId)).size).toBe(4)
    // El eventId es el de origen: igual en los dos intentos.
    expect(h.calls[0]!.body.events[0]!.eventId).toBe(h.calls[2]!.body.events[0]!.eventId)
    expect(h.marks.flat().every((d) => d.outcome === 'RETRY' && d.code === 'USAGE_INGEST_DISABLED')).toBe(true)
  })

  it('una fila inválida muere sola (DEAD con su código) y no frena al resto', async () => {
    const { env } = await enabledEnv()
    const bad = row({ meter_code: 'ecommerce.ai.credits' })
    const good = row()
    const h = harness({ env, rows: [bad, good] })
    const report = await runUsageOutboxSender(h.deps)
    expect(h.marks.flat()).toEqual(
      expect.arrayContaining([
        { eventId: bad.event_id, outcome: 'DEAD', code: 'UNKNOWN_METER' },
        { eventId: good.event_id, outcome: 'SENT' },
      ]),
    )
    expect(h.calls[0]!.body.events.map((e) => e.eventId)).toEqual([good.event_id])
    expect(report).toMatchObject({ sent: 1, dead: 1 })
  })

  it('una fila sin tenant que se colara no se envía ni muere: RETRY TENANT_NOT_MAPPED', async () => {
    const { env } = await enabledEnv()
    const r = row({ control_plane_tenant_id: null })
    const h = harness({ env, rows: [r] })
    await runUsageOutboxSender(h.deps)
    expect(h.fetchImpl).not.toHaveBeenCalled()
    expect(h.marks.flat()).toEqual([{ eventId: r.event_id, outcome: 'RETRY', code: 'TENANT_NOT_MAPPED' }])
  })

  it('sin filas no llama a nadie', async () => {
    const { env } = await enabledEnv()
    const h = harness({ env, rows: [] })
    const report = await runUsageOutboxSender(h.deps)
    expect(report).toMatchObject({ status: 'OK', claimed: 0, batches: 0 })
    expect(h.fetchImpl).not.toHaveBeenCalled()
  })
})

describe('lotes ≤ 500 eventos y ≤ 256 KB', () => {
  const meta = { environment: 'DEV' as const, productCode: 'ecommerce' }
  let n = 0
  const ids = () => `00000000-0000-4000-8000-${(n += 1).toString(16).padStart(12, '0')}`

  it('1201 eventos → 500 + 500 + 201, orden estable, igual que la referencia', () => {
    const events = Array.from({ length: 1201 }, () => buildUsageEvent(row()))
    const batches = chunkUsageEvents(events, meta, ids)
    expect(batches.map((b) => b.events.length)).toEqual([500, 500, 201])
    expect(batches.flatMap((b) => b.events)).toEqual(events)
    const ref = reference.chunkUsageEvents(events as reference.UsageEvent[], meta, ids)
    expect(ref.map((b) => b.events.length)).toEqual([500, 500, 201])
    expect(MAX_EVENTS).toBe(reference.MAX_EVENTS)
    expect(MAX_BODY_BYTES).toBe(reference.MAX_BODY_BYTES)
  })

  it('eventos grandes cortan por bytes antes de 500', () => {
    const big = (i: number): UsageEvent => ({
      ...buildUsageEvent(row()),
      subjectRef: `s${i}`.padEnd(200, 'x'),
      internal: { provider: 'p'.repeat(100), model: 'm'.repeat(100), inputTokens: 1, outputTokens: 1, latencyMs: 1 },
    })
    const events = Array.from({ length: 500 }, (_v, i) => big(i))
    const batches = chunkUsageEvents(events, meta, ids)
    expect(batches.length).toBeGreaterThan(1)
    for (const b of batches) {
      expect(new TextEncoder().encode(JSON.stringify(b)).length).toBeLessThanOrEqual(MAX_BODY_BYTES)
      expect(b.events.length).toBeLessThanOrEqual(MAX_EVENTS)
    }
    expect(batches.map((b) => b.events.length)).toEqual(
      reference.chunkUsageEvents(events as reference.UsageEvent[], meta, ids).map((b) => b.events.length),
    )
  })
})
