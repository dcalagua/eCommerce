/**
 * `usage-outbox-worker` — entrega el outbox de uso a EBIM MasterAdmin
 * (contrato `ebim.usage/v1`, CCP fase 17).
 *
 * Mismo patrón que `integration-worker`: lo invoca un planificador o el
 * operador, NUNCA un navegador. La puerta es `EBIM_WORKER_KEY` en la cabecera
 * `x-ebim-worker-key`, comparada en tiempo constante. `verify_jwt = false` en
 * `config.toml` porque no hay usuario: la clave dedicada es la autenticación.
 *
 * **Apagado por defecto**: sin `USAGE_OUTBOX_SENDER_ENABLED=true` responde 200
 * `DISABLED` sin reclamar ni llamar a nadie. Ningún cron lo agenda desde las
 * migraciones.
 *
 * Aquí solo se resuelven los puertos; el mapeo, los lotes, la firma ES256 y la
 * clasificación son de `_shared/usageOutbox/sender.ts` (puro, probado sin red).
 */
import { serviceClient } from '../_runtime/clients.ts'
import { timingSafeEqual } from '../_shared/auth.ts'
import { resolveTrace, traceHeaders } from '../_shared/observability/index.ts'
import { edgeSecurityHeaders } from '../_shared/securityHeaders.ts'
import {
  runUsageOutboxSender,
  type UsageOutboxRow,
} from '../_shared/usageOutbox/sender.ts'

const WORKER_KEY_HEADER = 'x-ebim-worker-key'
/** Lease del reclamo: holgado frente a 15 s de timeout × lotes de una pasada. */
const CLAIM_LEASE_SECONDS = 300

function json(body: unknown, status: number, headers: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8' },
  })
}

Deno.serve(async (request: Request): Promise<Response> => {
  const trace = resolveTrace(request)
  const headers = { ...edgeSecurityHeaders(), ...traceHeaders(trace) }

  if (request.method !== 'POST') {
    return json({ error: { code: 'METODO_NO_PERMITIDO', message: 'Solo POST' } }, 405, headers)
  }

  const expected = Deno.env.get('EBIM_WORKER_KEY') ?? ''
  if (expected.length < 32) {
    return json(
      { error: { code: 'WORKER_NO_CONFIGURADO', message: 'Falta EBIM_WORKER_KEY' } },
      500,
      headers,
    )
  }
  if (!timingSafeEqual(request.headers.get(WORKER_KEY_HEADER) ?? '', expected)) {
    return json(
      { error: { code: 'NO_AUTENTICADO', message: 'Clave de trabajador inválida' } },
      401,
      headers,
    )
  }

  // Apagado: ni siquiera se crea el cliente de servicio.
  if (Deno.env.get('USAGE_OUTBOX_SENDER_ENABLED') !== 'true') {
    return json({ data: { status: 'DISABLED' } }, 200, headers)
  }

  const client = serviceClient(trace)

  try {
    const report = await runUsageOutboxSender({
      env: (name) => Deno.env.get(name),
      async claim(limit) {
        const { data, error } = await client.rpc('platform_usage_outbox_claim', {
          p_limit: limit,
          p_lease_seconds: CLAIM_LEASE_SECONDS,
        })
        if (error) throw new Error(error.code ?? 'CLAIM_FALLIDO')
        return (data ?? []) as UsageOutboxRow[]
      },
      async mark(results) {
        const { error } = await client.rpc('platform_usage_outbox_mark', { p_results: results })
        if (error) throw new Error(error.code ?? 'MARCA_FALLIDA')
      },
      fetchImpl: fetch,
    })
    return json({ data: report }, 200, headers)
  } catch (error) {
    // 503: falló la base o la red hacia ella; el lease devuelve las filas solas.
    console.error('[usage-outbox-worker] la pasada no se pudo completar', {
      correlation_id: trace.correlationId,
      name: error instanceof Error ? error.name : 'Error',
    })
    return json(
      { error: { code: 'SERVICIO_NO_DISPONIBLE', message: 'La pasada no se pudo completar' } },
      503,
      headers,
    )
  }
})
