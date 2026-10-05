/**
 * JSON Canonicalization Scheme (RFC 8785) y checksum de `ebim.entitlements/v1`.
 *
 * El checksum de un snapshot es `sha256:` + hex del SHA-256 de los bytes UTF-8
 * del JSON canónico SIN el campo `checksum` (contrato FIX-ENT-v1 §1). MasterAdmin
 * lo calcula al emitir; este receptor lo RECALCULA antes de aplicar y rechaza el
 * snapshot si no coincide (422 CHECKSUM_MISMATCH).
 *
 * Misma implementación que MasterAdmin (`_shared/entitlements/jcs.ts`), sin sus
 * imports: aquí el SHA-256 sale de la Web Crypto API, que es la misma en Deno y
 * Node. La prueban los `jcs-vectors.json` fijados en
 * `supabase/tests/entitlements-fixtures-pin.test.ts`.
 *
 * RFC 8785 está definida sobre la serialización de ECMAScript: números con
 * `Number#toString` (vía JSON.stringify), cadenas con los escapes de
 * JSON.stringify, claves ordenadas por unidades UTF-16 (el `sort()` por
 * defecto). Lo que se añade es RECHAZAR lo que no es JSON en vez de dejar que
 * JSON.stringify lo omita en silencio.
 */

export class JcsError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'JcsError'
  }
}

// Surrogate alto sin bajo detrás, o bajo sin alto delante.
const LONE_SURROGATE_RE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/

function serializeString(value: string): string {
  if (LONE_SURROGATE_RE.test(value)) {
    throw new JcsError('Cadena con surrogate UTF-16 solitario: no es Unicode válido')
  }
  return JSON.stringify(value)
}

function serializeNumber(value: number): string {
  if (!Number.isFinite(value)) throw new JcsError(`Número no representable en JSON: ${String(value)}`)
  // JSON.stringify(-0) === '0', como exige la RFC.
  return JSON.stringify(value)
}

export function canonicalize(value: unknown): string {
  if (value === null) return 'null'
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false'
    case 'number':
      return serializeNumber(value)
    case 'string':
      return serializeString(value)
    case 'object':
      break
    default:
      throw new JcsError(`Tipo no admitido en JSON: ${typeof value}`)
  }

  if (Array.isArray(value)) return `[${value.map((item) => canonicalize(item)).join(',')}]`

  const proto = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null) {
    throw new JcsError('Solo se canonicalizan objetos planos')
  }
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort()
  return `{${keys.map((key) => `${serializeString(key)}:${canonicalize(record[key])}`).join(',')}}`
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}

/** `sha256:<hex>` del canónico del documento sin su campo `checksum`. */
export async function entitlementChecksum(document: Record<string, unknown>): Promise<string> {
  const rest = { ...document }
  delete rest.checksum
  return `sha256:${await sha256Hex(canonicalize(rest))}`
}
