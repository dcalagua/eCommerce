/**
 * Firma de los webhooks que SALEN.
 *
 * P09 resolvió la mitad de entrada (`_shared/payments/signature.ts`): verificar
 * la firma de lo que nos mandan. Esto es la mitad de salida, y se apoya en la
 * misma primitiva —`hmacSha256Hex` sobre el cuerpo crudo, `crypto.subtle`— en
 * vez de escribir un segundo HMAC. Que las dos mitades usen el mismo cálculo es
 * lo que permite que un test firme, entregue y verifique sin poder equivocarse
 * en un solo lado.
 *
 * ## Qué se firma, y por qué lleva un instante dentro
 *
 * El texto firmado es `<instante>.<cuerpo crudo>`, y el instante viaja en la
 * misma cabecera. Sin él, una firma válida lo es para siempre: quien capture
 * una entrega —en un proxy, en un log del receptor, en una red mal segmentada—
 * puede reproducirla contra el endpoint del cliente meses después y su sistema
 * la aceptará como legítima, porque la firma cuadra. Con el instante dentro del
 * texto firmado, el receptor rechaza lo que llega demasiado tarde y no puede
 * moverse el reloj sin invalidar la firma.
 *
 * ## Formato de la cabecera
 *
 *     x-ebim-signature: t=1756400000,v1=<64 hex>
 *
 * `v1` es la versión del ESQUEMA de firma, no la de la API. Existe para poder
 * cambiar el algoritmo algún día publicando las dos a la vez durante una
 * ventana, en vez de romper a todos los suscriptores el mismo martes.
 *
 * El SECRETO no vive en la base: allí está `webhook_endpoints.secret_ref`, el
 * nombre de la variable del vault. Quien lo resuelve es el despliegue.
 */
import { hmacSha256Hex, timingSafeEqual } from '../payments/signature.ts'

export const SIGNATURE_HEADER = 'x-ebim-signature'
export const EVENT_ID_HEADER = 'x-ebim-event-id'
export const EVENT_TYPE_HEADER = 'x-ebim-event-type'
export const DELIVERY_ID_HEADER = 'x-ebim-delivery-id'
export const SIGNATURE_SCHEME = 'v1'

/** Texto que se firma. Se exporta para que el receptor lo pueda reconstruir. */
export function signedPayload(timestampSeconds: number, rawBody: string): string {
  return `${timestampSeconds}.${rawBody}`
}

export async function signWebhook(input: {
  secret: string
  rawBody: string
  timestampSeconds?: number
}): Promise<{ header: string; timestamp: number; signature: string }> {
  const timestamp = input.timestampSeconds ?? Math.floor(Date.now() / 1000)
  const signature = await hmacSha256Hex(input.secret, signedPayload(timestamp, input.rawBody))
  return {
    header: `t=${timestamp},${SIGNATURE_SCHEME}=${signature}`,
    timestamp,
    signature,
  }
}

/**
 * Verificación, del lado del receptor. Vive aquí y no en la documentación
 * porque una firma que solo se sabe generar no se puede probar: el test
 * ejercita las dos mitades y así la promesa que le hacemos al suscriptor está
 * comprobada, no escrita.
 *
 * `toleranceSeconds` acota la ventana de reproducción. Cinco minutos es
 * suficiente margen para un reloj mal sincronizado y suficientemente corto para
 * que reproducir una captura vieja no sirva.
 */
export async function verifyWebhookSignature(input: {
  secret: string | null
  header: string | null
  rawBody: string
  nowSeconds?: number
  toleranceSeconds?: number
}): Promise<boolean> {
  if (!input.secret || !input.header) return false

  const parts = new Map<string, string>()
  for (const chunk of input.header.split(',')) {
    const [key, value] = chunk.split('=')
    if (key && value) parts.set(key.trim(), value.trim())
  }

  const timestamp = Number.parseInt(parts.get('t') ?? '', 10)
  const provided = (parts.get(SIGNATURE_SCHEME) ?? '').toLowerCase()
  if (!Number.isFinite(timestamp) || !/^[a-f0-9]{64}$/.test(provided)) return false

  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000)
  const tolerance = input.toleranceSeconds ?? 300
  if (Math.abs(now - timestamp) > tolerance) return false

  const expected = await hmacSha256Hex(input.secret, signedPayload(timestamp, input.rawBody))
  return timingSafeEqual(expected, provided)
}
