/**
 * Envoltura HTTP común: preflight, parseo del body, forma de respuesta y
 * traducción de errores. Las cuatro funciones comparten esto para que un
 * cambio en el contrato de errores no haya que repetirlo cuatro veces.
 */
import { corsHeaders, type CorsOptions } from './cors.ts'
import { AppError, badRequest, methodNotAllowed, toAppError } from './errors.ts'

export type JsonBody = Record<string, unknown>

export function jsonResponse(
  body: unknown,
  status: number,
  headers: Record<string, string>,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8' },
  })
}

export function errorPayload(error: AppError): { error: { code: string; message: string } } {
  return { error: { code: error.code, message: error.message } }
}

export async function readJsonBody(request: Request): Promise<JsonBody> {
  const contentType = request.headers.get('content-type') ?? ''
  if (!contentType.includes('application/json')) {
    throw badRequest('CONTENT_TYPE_INVALIDO', 'Se espera application/json')
  }
  let parsed: unknown
  try {
    parsed = await request.json()
  } catch {
    throw badRequest('JSON_INVALIDO', 'El cuerpo de la peticion no es JSON valido')
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw badRequest('JSON_INVALIDO', 'El cuerpo debe ser un objeto JSON')
  }
  return parsed as JsonBody
}

export type HandlerContext = {
  request: Request
  body: JsonBody
  headers: Record<string, string>
}

/**
 * Handler estándar: responde el preflight, exige el método, parsea el cuerpo y
 * convierte cualquier excepción en una respuesta de error uniforme.
 */
export function serveJson(
  options: CorsOptions & { method?: 'POST' | 'GET' },
  handler: (ctx: HandlerContext) => Promise<{ status: number; body: unknown }>,
): (request: Request) => Promise<Response> {
  const method = options.method ?? 'POST'

  return async (request: Request): Promise<Response> => {
    const headers = corsHeaders(request.headers.get('origin'), options)

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers })
    }

    try {
      if (request.method !== method) throw methodNotAllowed(request.method)
      const body = method === 'POST' ? await readJsonBody(request) : {}
      const result = await handler({ request, body, headers })
      return jsonResponse(result.body, result.status, headers)
    } catch (error) {
      const appError = toAppError(error)
      if (appError.status === 500) {
        console.error('[edge] error no controlado', error)
      }
      return jsonResponse(errorPayload(appError), appError.status, headers)
    }
  }
}
