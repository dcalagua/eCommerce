/**
 * Emisor de referencia de ebim.usage/v1 (FIX-USG-v1).
 *
 * Runtime-neutral (WebCrypto + fetch inyectable): lo usan Node, Deno y los
 * tests. Cada SaaS lo copia (vendor) junto con el resto del directorio y lo
 * fija por checksum; los SaaS no-TS (EWM, Java) reproducen su comportamiento
 * con las mismas tablas de fixtures.
 *
 * Reglas del contrato que este archivo implementa:
 *   · event_id se genera EN ORIGEN y es estable ante reintentos;
 *   · quantity finita, no negativa (salvo medidor con allowsNegative), unidad
 *     con forma canónica, tenant y producto atribuidos;
 *   · internal: solo proveedor/modelo/tokens/latencia/costo; los tokens van
 *     SOLO si el proveedor los devolvió (se omite la clave, nunca 0 inventado);
 *   · JWT ES256 nuevo por intento (jti de un solo uso), TTL ≤ 300 s;
 *   · lotes ≤ 500 eventos y ≤ 256 KB;
 *   · el outbox marca `sent` SOLO ante ACCEPTED/DUPLICATE; REJECTED es terminal
 *     (dead-letter con su código); transporte/5xx/429/JTI_REPLAYED → reintento
 *     con backoff exponencial.
 */

export const USAGE_SCHEMA = 'ebim.usage/v1';
export const USAGE_AUDIENCE = 'masteradmin.ebim';
export const USAGE_SCOPE = 'usage:ingest';
export const MAX_EVENTS = 500;
export const MAX_BODY_BYTES = 256 * 1024;
export const MAX_TOKEN_TTL_SECONDS = 300;

export type UsageEnvironment = 'DEV' | 'QAS' | 'DEMO' | 'PRD';

export interface UsageInternal {
  provider?: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheTokens?: number;
  latencyMs?: number;
  costAmount?: number;
  costCurrency?: string;
}

export interface UsageEvent {
  eventId: string;
  meterCode: string;
  quantity: number;
  unit: string;
  occurredAt: string;
  controlPlaneTenantId: string;
  externalCompanyId?: string;
  subjectRef?: string;
  capabilityCode?: string;
  internal?: UsageInternal;
}

export interface UsageBatch {
  schema: typeof USAGE_SCHEMA;
  environment: UsageEnvironment;
  productCode: string;
  batchId: string;
  events: UsageEvent[];
}

export type Outcome = 'SENT' | 'DEAD' | 'RETRY';

export interface EventDisposition {
  eventId: string;
  outcome: Outcome;
  code?: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const METER_RE = /^[a-z0-9]+([._][a-z0-9]+)*$/;
const UNIT_RE = /^[a-z0-9]+(_[a-z0-9]+)*$/;
const CAP_RE = /^[a-z0-9]+(\.[a-z0-9_]+)+$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/;
const INTERNAL_KEYS = new Set(['provider', 'model', 'inputTokens', 'outputTokens', 'cacheTokens', 'latencyMs', 'costAmount', 'costCurrency']);
const TOKEN_KEYS = ['inputTokens', 'outputTokens', 'cacheTokens', 'latencyMs'] as const;

// ---------------------------------------------------------------------------
// Validación en origen (antes de escribir en el outbox)
// ---------------------------------------------------------------------------

export class UsageEventInvalid extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'UsageEventInvalid';
  }
}

export function validateUsageEvent(event: UsageEvent, opts: { allowsNegative?: boolean } = {}): void {
  if (!UUID_RE.test(event.eventId ?? '')) throw new UsageEventInvalid('EVENT_ID_INVALID');
  if (!UUID_RE.test(event.controlPlaneTenantId ?? '')) throw new UsageEventInvalid('TENANT_REQUIRED');
  if (!METER_RE.test(event.meterCode ?? '')) throw new UsageEventInvalid('METER_CODE_INVALID');
  if (!UNIT_RE.test(event.unit ?? '')) throw new UsageEventInvalid('UNIT_INVALID');
  if (typeof event.quantity !== 'number' || !Number.isFinite(event.quantity)) throw new UsageEventInvalid('QUANTITY_INVALID');
  if (event.quantity < 0 && !opts.allowsNegative) throw new UsageEventInvalid('NEGATIVE_QUANTITY');
  if (Math.abs(event.quantity) >= 1e14 || Math.round(event.quantity * 1e6) / 1e6 !== event.quantity) {
    throw new UsageEventInvalid('QUANTITY_INVALID');
  }
  if (!ISO_RE.test(event.occurredAt ?? '') || Number.isNaN(Date.parse(event.occurredAt))) {
    throw new UsageEventInvalid('OCCURRED_AT_INVALID');
  }
  for (const k of ['externalCompanyId', 'subjectRef'] as const) {
    const v = event[k];
    if (v !== undefined && (typeof v !== 'string' || v.length < 1 || v.length > 200)) throw new UsageEventInvalid('REFERENCE_INVALID');
  }
  if (event.capabilityCode !== undefined && !CAP_RE.test(event.capabilityCode)) throw new UsageEventInvalid('CAPABILITY_CODE_INVALID');
  if (event.internal !== undefined) validateInternal(event.internal);
}

function validateInternal(internal: UsageInternal): void {
  if (internal === null || typeof internal !== 'object' || Array.isArray(internal)) throw new UsageEventInvalid('INTERNAL_METADATA_INVALID');
  for (const [k, v] of Object.entries(internal)) {
    if (!INTERNAL_KEYS.has(k)) throw new UsageEventInvalid('INTERNAL_METADATA_INVALID');
    if (v === undefined) continue;
    if ((k === 'provider' || k === 'model') && !(typeof v === 'string' && v.length >= 1 && v.length <= 100)) {
      throw new UsageEventInvalid('INTERNAL_METADATA_INVALID');
    }
    if ((TOKEN_KEYS as readonly string[]).includes(k) && !(Number.isSafeInteger(v) && (v as number) >= 0)) {
      throw new UsageEventInvalid('INTERNAL_METADATA_INVALID');
    }
    if (k === 'costAmount' && !(typeof v === 'number' && Number.isFinite(v) && v >= 0)) throw new UsageEventInvalid('INTERNAL_METADATA_INVALID');
    if (k === 'costCurrency' && !(typeof v === 'string' && /^[A-Z]{3}$/.test(v))) throw new UsageEventInvalid('INTERNAL_METADATA_INVALID');
  }
}

/**
 * Construye `internal` desde lo que devolvió el proveedor. Un campo ausente o
 * no numérico se OMITE: nunca se rellena con 0 ni se estima.
 */
export function internalFromProvider(input: {
  provider?: string | null;
  model?: string | null;
  inputTokens?: unknown;
  outputTokens?: unknown;
  cacheTokens?: unknown;
  latencyMs?: unknown;
}): UsageInternal | undefined {
  const out: UsageInternal = {};
  if (typeof input.provider === 'string' && input.provider) out.provider = input.provider.slice(0, 100);
  if (typeof input.model === 'string' && input.model) out.model = input.model.slice(0, 100);
  for (const k of TOKEN_KEYS) {
    const v = input[k];
    if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) out[k] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

// ---------------------------------------------------------------------------
// Lotes
// ---------------------------------------------------------------------------

const byteLength = (s: string) => new TextEncoder().encode(s).length;

/** Parte los eventos en lotes que respetan 500 eventos y 256 KB. Orden estable. */
export function chunkUsageEvents(
  events: UsageEvent[],
  meta: { environment: UsageEnvironment; productCode: string },
  newBatchId: () => string,
): UsageBatch[] {
  const batches: UsageBatch[] = [];
  let current: UsageEvent[] = [];
  const envelope = (evs: UsageEvent[]): UsageBatch => ({
    schema: USAGE_SCHEMA, environment: meta.environment, productCode: meta.productCode, batchId: newBatchId(), events: evs,
  });
  const fits = (evs: UsageEvent[]) =>
    evs.length <= MAX_EVENTS &&
    byteLength(JSON.stringify({ ...envelope([]), batchId: '00000000-0000-4000-8000-000000000000', events: evs })) <= MAX_BODY_BYTES;
  for (const e of events) {
    if (!fits([e])) throw new UsageEventInvalid('EVENT_TOO_LARGE');
    if (fits([...current, e])) {
      current.push(e);
    } else {
      batches.push(envelope(current));
      current = [e];
    }
  }
  if (current.length) batches.push(envelope(current));
  return batches;
}

// ---------------------------------------------------------------------------
// Firma ES256 (clave privada PKCS#8 PEM del SaaS; nunca sale del SaaS)
// ---------------------------------------------------------------------------

function b64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function importSenderPrivateKey(pkcs8Pem: string): Promise<CryptoKey> {
  const body = pkcs8Pem.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, '').replace(/\s+/g, '');
  const bin = atob(body);
  const der = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i += 1) der[i] = bin.charCodeAt(i);
  return crypto.subtle.importKey('pkcs8', der, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
}

export async function signUsageToken(opts: {
  issuer: string;
  privateKey: CryptoKey;
  nowSeconds: number;
  ttlSeconds?: number;
  jti?: string;
  kid?: string;
}): Promise<string> {
  const ttl = opts.ttlSeconds ?? 120;
  if (ttl < 1 || ttl > MAX_TOKEN_TTL_SECONDS) throw new Error('TTL_INVALID');
  const header: Record<string, string> = { alg: 'ES256', typ: 'JWT' };
  if (opts.kid) header.kid = opts.kid;
  const claims = {
    iss: opts.issuer,
    aud: USAGE_AUDIENCE,
    scope: USAGE_SCOPE,
    iat: opts.nowSeconds,
    exp: opts.nowSeconds + ttl,
    jti: opts.jti ?? crypto.randomUUID(),
  };
  const enc = (v: unknown) => b64url(new TextEncoder().encode(JSON.stringify(v)));
  const input = `${enc(header)}.${enc(claims)}`;
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, opts.privateKey, new TextEncoder().encode(input));
  return `${input}.${b64url(new Uint8Array(sig))}`;
}

// ---------------------------------------------------------------------------
// Interpretación de la respuesta → qué hace el outbox con cada evento
// ---------------------------------------------------------------------------

export function classifyBatchResponse(
  batch: Pick<UsageBatch, 'events'>,
  status: number | null,
  body: unknown,
): EventDisposition[] {
  const ids = batch.events.map((e) => e.eventId);
  const all = (outcome: Outcome, code?: string) => ids.map((eventId) => (code ? { eventId, outcome, code } : { eventId, outcome }));

  if (status === null) return all('RETRY', 'TRANSPORT_ERROR');
  const b = (body ?? {}) as { error?: unknown; results?: unknown };
  if (status !== 200) {
    // Un error de LOTE nunca descarta eventos: 5xx/429/token → transitorio;
    // 4xx de configuración (firma, scope, ambiente, esquema) → se reintenta con
    // backoff hasta que el operador lo corrija.
    const code = typeof b.error === 'string' ? b.error : `HTTP_${status}`;
    return all('RETRY', code);
  }
  // Los resultados vienen en el ORDEN del lote: se emparejan por posición y se
  // exige el mismo eventId (un lote puede repetir un id; un mapa lo perdería).
  const results = Array.isArray(b.results) ? (b.results as Array<{ eventId?: unknown; status?: unknown; code?: unknown }>) : [];
  return ids.map((eventId, i) => {
    const r = results[i];
    if (!r || typeof r.eventId !== 'string' || r.eventId.toLowerCase() !== eventId.toLowerCase()) {
      return { eventId, outcome: 'RETRY' as const, code: 'MISSING_RESULT' };
    }
    if (r.status === 'ACCEPTED' || r.status === 'DUPLICATE') return { eventId, outcome: 'SENT' as const };
    if (r.status === 'REJECTED') return { eventId, outcome: 'DEAD' as const, code: typeof r.code === 'string' ? r.code : 'REJECTED' };
    return { eventId, outcome: 'RETRY' as const, code: 'UNKNOWN_STATUS' };
  });
}

/** Backoff exponencial: 30 s · 2^(n−1), tope 6 h. `attempt` empieza en 1. */
export function nextBackoffSeconds(attempt: number): number {
  const n = Math.max(1, Math.floor(attempt));
  return Math.min(30 * 2 ** (n - 1), 6 * 3600);
}

// ---------------------------------------------------------------------------
// Envío
// ---------------------------------------------------------------------------

export async function sendUsageBatch(opts: {
  endpoint: string;
  batch: UsageBatch;
  token: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<EventDisposition[]> {
  const f = opts.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 15_000);
  try {
    const res = await f(opts.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${opts.token}` },
      body: JSON.stringify(opts.batch),
      signal: controller.signal,
    });
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    return classifyBatchResponse(opts.batch, res.status, body);
  } catch {
    return classifyBatchResponse(opts.batch, null, null);
  } finally {
    clearTimeout(timer);
  }
}
