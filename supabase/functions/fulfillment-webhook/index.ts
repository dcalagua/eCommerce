/**
 * fulfillment-webhook — la puerta por la que un operador dice dónde va el
 * paquete (P12-SaaS).
 *
 * Es hermana de `payments-webhook` y se comporta igual porque el problema es el
 * mismo: un tercero que escribe en nuestra base sin sesión.
 *
 *  · **No usa `serveJson`.** Esa envoltura parsea el cuerpo, y aquí el cuerpo
 *    CRUDO es el dato: la firma se calcula sobre los bytes que llegaron, no
 *    sobre un JSON reserializado. Reserializar rompe firmas legítimas.
 *  · **No hay CORS abierto ni `Authorization`.** Quien llama es un servidor,
 *    no un navegador. La autenticación es la FIRMA del cuerpo, nada más.
 *  · **Responde 200 casi siempre.** Un webhook al que se contesta con error se
 *    reintenta, a veces para siempre. Solo devuelve error lo que de verdad
 *    conviene que el operador reintente.
 *
 * ## El secreto: de dónde sale y qué falta para que salga de otro sitio
 *
 * De `EBIM_SHIPPING_WEBHOOK_SECRET_<CONECTOR>` en el entorno de la función. Es
 * un secreto POR CONECTOR y por despliegue.
 *
 * `tenant_integrations.secret_ref` permite un secreto POR SOCIEDAD, que es lo
 * deseable, pero exige que la URL de callback identifique al tenant —el
 * operador no puede decirlo, y si lo dijera sería un tenant declarado por un
 * tercero— y esa forma de URL depende de qué operador se contrate. Es la misma
 * decisión abierta que dejó P09 para las pasarelas; cuando se cierre, lo único
 * que cambia es de dónde sale `secret` en este archivo.
 *
 * ## Qué NO decide esta función
 *
 * Nada. Verifica la firma, resuelve el conector y llama al comando. La
 * autorización, la idempotencia y la máquina de estados están en la base, donde
 * no se pueden rodear desplegando mal esta función.
 */
import { corsHeaders } from '../_shared/cors.ts'
import {
  ingestTrackingWebhook,
  type TrackingWebhookPorts,
} from '../_shared/fulfillment/webhook.ts'
import { serviceClient } from '../_runtime/clients.ts'

const PROVIDER_CODE_RE = /^[a-z0-9][a-z0-9_-]{0,40}$/

/** Cabecera de firma. Se aceptan las dos formas que usan los operadores al uso. */
function signatureOf(request: Request): string | null {
  return request.headers.get('x-ebim-signature') ?? request.headers.get('x-signature') ?? null
}

function json(body: unknown, status: number, headers: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8' },
  })
}

Deno.serve(async (request: Request): Promise<Response> => {
  const headers = corsHeaders(request.headers.get('origin'), { methods: ['POST', 'OPTIONS'] })

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
  // Un cuerpo enorme no llega a `crypto.subtle`: verificar la firma de un
  // megabyte que nadie mandó es trabajo regalado a quien lo mande.
  if (rawBody.length > 256_000) {
    return json(
      { error: { code: 'CUERPO_EXCESIVO', message: 'El aviso es demasiado grande' } },
      413,
      headers,
    )
  }

  const client = serviceClient()
  const ports: TrackingWebhookPorts = {
    async findShipmentByTracking(code, tracking) {
      // Lectura directa con `service_role` y no un RPC: es una consulta por un
      // índice único (`shipments_provider_tracking`), sin ninguna decisión
      // dentro. El tenant sale de la fila que devuelve, nunca del aviso.
      const { data, error } = await client
        .from('shipments')
        .select('id')
        .eq('provider_code', code)
        .eq('tracking_number', tracking)
        .maybeSingle()
      if (error) throw new Error(error.message)
      return data ? { shipmentId: String(data.id) } : null
    },

    async ingest(args) {
      const { data, error } = await client.rpc('shipment_track_ingest', args)
      if (error) throw new Error(error.message)
      return (data ?? {}) as Record<string, unknown>
    },
  }

  try {
    const result = await ingestTrackingWebhook({
      providerCode,
      rawBody,
      signature: signatureOf(request),
      secret: Deno.env.get(`EBIM_SHIPPING_WEBHOOK_SECRET_${providerCode.toUpperCase()}`) ?? null,
      ports,
    })

    if (!result.accepted) {
      // 404 para una guía que no es de aquí, 401 para lo que no se arregla
      // reintentando. Mensaje escueto en los dos casos: distinguirlos con
      // detalle le enseñaría a quien prueba a separar guías reales de
      // inventadas.
      const status = result.code === 'GUIA_DESCONOCIDA' ? 404 : 401
      return json({ error: { code: result.code, message: 'Aviso no aceptado' } }, status, headers)
    }

    return json(
      {
        data: {
          accepted: true,
          replay: result.replay,
          events: result.events,
          duplicated: result.duplicated,
          status: result.status,
        },
      },
      200,
      headers,
    )
  } catch (error) {
    // 503 y no 500: si esto falló, fue la base o la red, y ahí sí conviene que
    // el operador reintente. El detalle interno no sale en la respuesta.
    console.error('[fulfillment-webhook] fallo al procesar el aviso', error)
    return json(
      { error: { code: 'SERVICIO_NO_DISPONIBLE', message: 'No se pudo procesar el aviso' } },
      503,
      headers,
    )
  }
})
