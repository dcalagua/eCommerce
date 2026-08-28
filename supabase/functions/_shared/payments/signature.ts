/**
 * Firma de webhooks: HMAC-SHA256 sobre el cuerpo CRUDO.
 *
 * Tres decisiones que no son de estilo:
 *
 *  1. **Sobre el cuerpo crudo, nunca sobre el JSON reserializado.** `JSON.parse`
 *     seguido de `JSON.stringify` reordena claves y normaliza números: el
 *     resumen sale distinto y la firma legítima no valida. La firma se verifica
 *     antes de parsear, sobre los bytes que llegaron.
 *  2. **Comparación en tiempo constante.** Un `===` sobre hexadecimal filtra,
 *     por cuánto tarda en fallar, cuántos caracteres iniciales acertó quien
 *     prueba. Con un webhook que mueve dinero eso es un oráculo.
 *  3. **`crypto.subtle` y no una librería.** Es estándar de la plataforma:
 *     existe igual en Deno y en Node, así que el borde y los tests calculan lo
 *     mismo. Es la misma decisión que `sha256Hex` en el checkout (P07).
 *
 * El SECRETO no vive aquí ni en la base: en la base está `secret_ref`, el
 * nombre de la variable del vault. Quien llama lo resuelve y lo pasa.
 */

function toHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

export async function hmacSha256Hex(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  return toHex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload)))
}

/**
 * Igualdad en tiempo constante sobre texto. Recorre SIEMPRE la longitud del
 * esperado y acumula diferencias en vez de salir al primer byte distinto.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  const expected = new TextEncoder().encode(a)
  const actual = new TextEncoder().encode(b)
  // La longitud no es secreta —es la del algoritmo, siempre la misma— pero
  // salir aquí evita comparar contra un buffer más corto.
  let diff = expected.length ^ actual.length
  for (let index = 0; index < expected.length; index += 1) {
    diff |= (expected[index] ?? 0) ^ (actual[index] ?? 0)
  }
  return diff === 0
}

/**
 * ¿La firma de este sobre es válida?
 *
 * Sin secreto o sin firma devuelve `false`, no lanza: «no se pudo verificar» y
 * «no valida» acaban en el mismo sitio —el aviso se descarta y no mueve
 * dinero—, y distinguirlos en la respuesta le diría a quien prueba si el tenant
 * tiene o no configurado el conector.
 */
export async function verifyHmacSignature(input: {
  rawBody: string
  signature: string | null
  secret: string | null
}): Promise<boolean> {
  if (!input.secret || !input.signature) return false
  const provided = input.signature.trim().toLowerCase().replace(/^sha256=/, '')
  if (!/^[a-f0-9]{64}$/.test(provided)) return false
  return timingSafeEqual(await hmacSha256Hex(input.secret, input.rawBody), provided)
}
