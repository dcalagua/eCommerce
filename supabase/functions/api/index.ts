/**
 * `api` — la puerta versionada de la API de socio (P14-SaaS).
 *
 * Este archivo es cableado y nada más: resuelve el hilo, monta los puertos
 * contra Supabase y convierte el resultado en `Response`. Todo lo que DECIDE
 * está en `_shared/api/gateway.ts`, que es TypeScript puro y se prueba sin
 * levantar nada. La separación es la misma que P07 hizo con el orquestador de
 * checkout y P09 con el contrato de pasarela, y por el mismo motivo: la parte
 * difícil no es hablar HTTP.
 *
 * ## Por qué usa `service_role` y por qué eso no abre nada
 *
 * Quien llama es un SISTEMA: no hay sesión de Supabase Auth, no hay JWT del hub
 * y por tanto no hay RLS que pueda decidir. La autorización es el token de
 * socio, y vive en la base: `api_authenticate` verifica el token y el scope, y
 * cada función de recurso vuelve a comprobar el scope y **deriva el tenant de
 * la fila de la credencial**. Este archivo no sabe —ni puede saber— a qué
 * sociedad pertenece quien llama: no hay una sola línea aquí que lea
 * `organization_id`. Un fallo en este archivo no puede cruzar tenants porque no
 * existe el parámetro con el que pedírselo.
 *
 * ## CORS
 *
 * Cerrado. Esto no lo llama un navegador: lo llama el servidor de un socio, que
 * no está sujeto a la política de mismo origen. Abrir `*` con `Authorization`
 * aquí solo serviría para que una página cualquiera pudiera usar un token que
 * se le hubiera filtrado al usuario.
 */
import { serviceClient } from '../_runtime/clients.ts'
import { resolveTrace, traceHeaders } from '../_shared/observability/index.ts'
import { handleApiRequest, type GatewayPorts } from '../_shared/api/gateway.ts'
import { sha256Hex } from '../_shared/checkout/request.ts'

Deno.serve(async (request: Request): Promise<Response> => {
  const trace = resolveTrace(request)
  const headers: Record<string, string> = {
    ...traceHeaders(trace),
    'Content-Type': 'application/json; charset=utf-8',
    // Un socio no debería cachear respuestas de negocio por accidente, y un
    // proxy intermedio menos todavía: un pedido cacheado es un pedido que ya
    // no existe contado como si existiera.
    'Cache-Control': 'no-store',
  }

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers })
  }

  const client = serviceClient(trace)

  const call = async (rpc: string, args: Record<string, unknown>): Promise<unknown> => {
    const { data, error } = await client.rpc(rpc, args)
    if (error) throw error
    return data
  }

  const ports: GatewayPorts = {
    hash: (value) => sha256Hex(value),

    issueToken: async ({ clientId, secret, scopes }) =>
      (await call('api_token_issue', {
        p_client_id: clientId,
        p_secret: secret,
        p_scopes: scopes,
      })) as Record<string, unknown>,

    authenticate: async (tokenHash, scope) =>
      (await call('api_authenticate', {
        p_token_hash: tokenHash,
        p_scope: scope,
      })) as Awaited<ReturnType<GatewayPorts['authenticate']>>,

    rateLimit: async ({ apiClientId, method, route }) =>
      (await call('api_rate_limit_hit', {
        p_api_client_id: apiClientId,
        p_method: method,
        p_route: route,
      })) as Awaited<ReturnType<GatewayPorts['rateLimit']>>,

    completeRequest: async (requestId, status) => {
      await call('api_request_complete', { p_request_id: requestId, p_status: status })
    },

    idempotencyBegin: async ({ apiClientId, key, requestHash }) =>
      (await call('api_idempotency_begin', {
        p_api_client_id: apiClientId,
        p_key: key,
        p_request_hash: requestHash,
      })) as Awaited<ReturnType<GatewayPorts['idempotencyBegin']>>,

    idempotencyFinish: async ({ apiClientId, key, status, response }) => {
      await call('api_idempotency_finish', {
        p_api_client_id: apiClientId,
        p_key: key,
        p_status: status,
        p_response: response,
      })
    },

    callResource: (rpc, args) => call(rpc, args),
  }

  const result = await handleApiRequest(request, ports, trace)

  return new Response(JSON.stringify(result.body), {
    status: result.status,
    headers: { ...headers, ...result.headers },
  })
})
