/**
 * payments-webhook — la puerta por la que una pasarela dice qué pasó (P09-SaaS).
 *
 * No se parece a las otras cinco funciones y es a propósito:
 *
 *  · **No usa `serveJson`.** Esa envoltura parsea el cuerpo, y aquí el cuerpo
 *    CRUDO es el dato: la firma se calcula sobre los bytes que llegaron, no
 *    sobre un JSON reserializado. Reserializar rompe firmas legítimas.
 *  · **No hay CORS abierto ni `Authorization`.** Quien llama es un servidor,
 *    no un navegador. La autenticación es la FIRMA del cuerpo, nada más:
 *    ninguna sesión, ninguna clave publicable, ningún origen que consultar.
 *  · **Responde 200 casi siempre.** Un webhook al que se contesta con error se
 *    reintenta, y a veces para siempre. Solo devuelve error lo que de verdad
 *    conviene que la pasarela reintente.
 *
 * ## El secreto: de dónde sale y qué falta para que salga de otro sitio
 *
 * De `EBIM_PAYMENT_WEBHOOK_SECRET_<CONECTOR>` en el entorno de la función.
 * Es un secreto POR CONECTOR y por despliegue.
 *
 * `tenant_integrations.secret_ref` permite un secreto POR SOCIEDAD, que es lo
 * deseable, pero exige que la URL de callback identifique al tenant —la
 * pasarela no puede decirlo, y si lo dijera sería un tenant declarado por un
 * tercero— y esa forma de URL depende de qué pasarela se contrate. Esa decisión
 * está abierta (`docs/SAAS_ROADMAP.md` §5.2.3) y no se inventa aquí. Cuando se
 * cierre, lo único que cambia es de dónde sale `secret` en este archivo.
 *
 * ## Qué NO decide esta función
 *
 * Nada. Verifica la firma, resuelve el conector y llama al comando. La
 * autorización, la idempotencia y la aritmética están en la base, donde no se
 * pueden rodear desplegando mal esta función.
 */
import { corsHeaders } from '../_shared/cors.ts'
import { resolveTrace, traceHeaders } from '../_shared/observability/index.ts'
import { ingestPaymentWebhook, type WebhookPorts } from '../_shared/payments/webhook.ts'
import { serviceClient } from '../_runtime/clients.ts'

const PROVIDER_CODE_RE = /^[a-z0-9][a-z0-9_-]{0,40}$/

/** Cabecera de firma. Se aceptan las dos formas que usan las pasarelas al uso. */
function signatureOf(request: Request): string | null {
  return (
    request.headers.get('x-ebim-signature') ??
    request.headers.get('x-signature') ??
    null
  )
}

function json(body: unknown, status: number, headers: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8' },
  })
}

Deno.serve(async (request: Request): Promise<Response> => {
  // El HILO tambien aqui, y es el salto que mas importa de todos: el aviso de
  // la pasarela o del transportista llega MINUTOS despues de la compra, desde
  // otra maquina y sin sesion. Un proveedor que reenvie la cabecera cose su
  // aviso al hilo del checkout; uno que no la reenvie abre hilo propio, que
  // sigue siendo mejor que no tener ninguno — y en los dos casos la fila que
  // escriba `shipment_track_ingest` o `payment_apply_outcome` lo lleva dentro.
  const trace = resolveTrace(request)
  const headers = {
    ...corsHeaders(request.headers.get('origin'), { methods: ['POST', 'OPTIONS'] }),
    ...traceHeaders(trace),
  }

  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers })
  if (request.method !== 'POST') {
    return json({ error: { code: 'METODO_NO_PERMITIDO', message: 'Solo POST' } }, 405, headers)
  }

  const providerCode = (new URL(request.url).searchParams.get('provider') ?? '')
    .trim()
    .toLowerCase()
  if (!PROVIDER_CODE_RE.test(providerCode)) {
    return json(
      { error: { code: 'CONECTOR_NO_INDICADO', message: 'Falta el conector en la URL' } },
      400,
      headers,
    )
  }

  const rawBody = await request.text()
  // Un cuerpo enorme no llega a `crypto.subtle`: verificar la firma de un megabyte
  // que nadie mandó es trabajo regalado a quien lo mande.
  if (rawBody.length > 256_000) {
    return json(
      { error: { code: 'CUERPO_EXCESIVO', message: 'El aviso es demasiado grande' } },
      413,
      headers,
    )
  }

  const client = serviceClient(trace)
  const ports: WebhookPorts = {
    async findIntentByReference(code, reference) {
      // Lectura directa con `service_role` y no un RPC: es una consulta por un
      // índice único (`payment_intents_provider_ref`), sin ninguna decisión
      // dentro. El tenant sale de la fila que devuelve, nunca del aviso.
      const { data, error } = await client
        .from('payment_intents')
        .select('id')
        .eq('provider_code', code)
        .eq('provider_reference', reference)
        .maybeSingle()
      if (error) throw new Error(error.message)
      return data ? { intentId: String(data.id) } : null
    },

    async findRefundByReference(code, reference) {
      const { data, error } = await client
        .from('refunds')
        .select('id')
        .eq('provider_code', code)
        .eq('provider_reference', reference)
        .in('status', ['requested', 'processing'])
        .limit(1)
        .maybeSingle()
      if (error) throw new Error(error.message)
      return data ? { refundId: String(data.id) } : null
    },

    async applyOutcome(args) {
      const { data, error } = await client.rpc('payment_apply_outcome', args)
      if (error) throw new Error(error.message)
      return (data ?? {}) as Record<string, unknown>
    },

    async settleRefund(args) {
      const { data, error } = await client.rpc('payment_refund_settle', args)
      if (error) throw new Error(error.message)
      return (data ?? {}) as Record<string, unknown>
    },
  }

  try {
    const result = await ingestPaymentWebhook({
      providerCode,
      rawBody,
      signature: signatureOf(request),
      secret:
        Deno.env.get(`EBIM_PAYMENT_WEBHOOK_SECRET_${providerCode.toUpperCase()}`) ?? null,
      ports,
    })

    if (!result.accepted) {
      // 401 para lo que no se arregla reintentando, 404 para una referencia que
      // no es de aquí. Mensaje escueto en los dos casos: distinguirlos con
      // detalle le enseñaría a quien prueba a separar referencias reales de
      // inventadas.
      const status = result.code === 'REFERENCIA_DESCONOCIDA' ? 404 : 401
      return json({ error: { code: result.code, message: 'Aviso no aceptado' } }, status, headers)
    }

    return json(
      {
        data: {
          accepted: true,
          replay: result.replay,
          kind: result.kind,
          status: result.status,
        },
      },
      200,
      headers,
    )
  } catch (error) {
    // 503 y no 500: si esto falló, fue la base o la red, y ahí sí conviene que
    // la pasarela reintente. El detalle interno no sale en la respuesta.
    console.error('[payments-webhook] fallo al procesar el aviso', error)
    return json(
      { error: { code: 'SERVICIO_NO_DISPONIBLE', message: 'No se pudo procesar el aviso' } },
      503,
      headers,
    )
  }
})
