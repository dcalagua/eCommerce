/**
 * Redaccion del lado del borde.
 *
 * La autoridad sigue siendo la BASE: `ebim.jsonb_is_pii_free` es un CHECK y un
 * CHECK no se puede desplegar mal. Esto es la primera capa, y existe porque hay
 * un destino al que el CHECK no llega: **la salida estandar**. Un
 * `console.error(body)` en una Edge Function acaba en el recolector de logs del
 * proveedor de hosting, fuera de esta base y fuera de sus policies. Ahi es donde
 * de verdad se filtran los correos y los tokens.
 *
 * Las dos listas —claves sensibles y claves de PII— son COPIA de
 * `ebim.sensitive_json_keys()` (P09) y `ebim.pii_json_keys()` (P13). Estan
 * duplicadas a proposito, igual que `CHECKOUT_STAGES` duplica el enum de
 * Postgres, y por la misma razon: el borde no puede consultar la base para
 * decidir si algo se puede escribir en un log. Un test compara las dos copias
 * contra el SQL y falla si se separan.
 */

/** Copia de `ebim.sensitive_json_keys()` — migracion 20260828120000. */
export const SENSITIVE_KEYS: readonly string[] = [
  'pan', 'card_number', 'cardnumber', 'card_no', 'account_number',
  'cvv', 'cvc', 'cvn', 'cvv2', 'csc', 'security_code', 'card_security_code',
  'expiry', 'expiration', 'exp_month', 'exp_year', 'card_expiry',
  'track1', 'track2', 'track_data', 'magstripe', 'pin', 'pin_block',
  'cardholder_name',
  'password', 'secret', 'api_key', 'apikey', 'token', 'access_token',
  'refresh_token', 'client_secret', 'private_key', 'signature_key',
]

/** Copia de `ebim.pii_json_keys()` — migracion 20260828160000. */
export const PII_KEYS: readonly string[] = [
  'email', 'e_mail', 'mail', 'correo', 'customer_email', 'contact_email',
  'phone', 'telephone', 'telefono', 'celular', 'mobile', 'msisdn',
  'customer_phone', 'contact_phone', 'whatsapp',
  'full_name', 'first_name', 'last_name', 'given_name', 'family_name',
  'customer_name', 'contact_name', 'nombre', 'apellido', 'apellidos',
  'dni', 'ruc', 'nif', 'cif', 'document_number', 'documento', 'tax_id',
  'national_id', 'passport',
  'address', 'address_line1', 'address_line2', 'direccion', 'street',
  'postal_code', 'zip', 'zipcode',
  'ip', 'ip_address', 'remote_addr', 'user_agent', 'device_id', 'session_id',
  'birthdate', 'birth_date', 'fecha_nacimiento',
]

export const REDACTED = '[redactado]'

const FORBIDDEN = new Set([...SENSITIVE_KEYS, ...PII_KEYS])

/** Misma forma conservadora que `ebim.looks_like_email`. */
const EMAIL = /[A-Z0-9._+-]+@[A-Z0-9-]+(\.[A-Z0-9-]+)*\.[A-Z]{2,}/i

/**
 * Misma cascada que `ebim.looks_like_pan`: forma, longitud y Luhn. El tercer
 * filtro no es rigor academico — sin el, una marca de tiempo en milisegundos
 * (13 digitos) se redactaria y alguien acabaria quitando la guarda entera.
 */
export function looksLikePan(value: string): boolean {
  if (!/^[0-9][0-9 -]{11,24}$/.test(value)) return false
  const digits = value.replace(/[^0-9]/g, '')
  if (digits.length < 13 || digits.length > 19) return false

  let sum = 0
  let alt = false
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let d = Number(digits[i])
    if (alt) {
      d *= 2
      if (d > 9) d -= 9
    }
    sum += d
    alt = !alt
  }
  return sum % 10 === 0
}

export function looksLikeEmail(value: string): boolean {
  return EMAIL.test(value)
}

function redactValue(value: unknown, depth: number): unknown {
  if (depth > 8) return REDACTED
  if (typeof value === 'string') {
    return looksLikeEmail(value) || looksLikePan(value) ? REDACTED : value
  }
  if (Array.isArray(value)) return value.map((item) => redactValue(item, depth + 1))
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = FORBIDDEN.has(key.toLowerCase()) ? REDACTED : redactValue(item, depth + 1)
    }
    return out
  }
  return value
}

/** Deja el objeto limpio en vez de descartarlo: perder el log es peor. */
export function redact<T>(value: T): T {
  return redactValue(value, 0) as T
}

/** Texto suelto que va a un log: sin correo, sin tarjeta y acotado. */
export function redactText(value: string | null | undefined, max = 500): string | null {
  const trimmed = (value ?? '').trim()
  if (!trimmed) return null
  if (looksLikeEmail(trimmed) || looksLikePan(trimmed)) return REDACTED
  return trimmed.slice(0, max)
}
