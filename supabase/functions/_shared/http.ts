/**
 * Envoltura HTTP común: preflight, parseo del body, forma de respuesta y
 * traducción de errores. Las cuatro funciones comparten esto para que un
 * cambio en el contrato de errores no haya que repetirlo cuatro veces.
 */
import { corsHeaders, type CorsOptions } from './cors.ts'
import { AppError, badRequest, methodNotAllowed, toAppError } from './errors.ts'
import {
  createLogger,
  consoleSink,
  errorCode,
  resolveTrace,
  traceHeaders,
  type LogSink,
  type Logger,
  type Trace,
} from './observability/index.ts'

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
  /**
   * El HILO de esta peticion (P13-SaaS). Se pasa a los clientes de Supabase
   * como cabecera, y de ahi lo recoge `ebim.correlation_id()` en la base: cada
   * fila escrita durante la peticion queda cosida al mismo incidente sin que
   * ninguna funcion de dominio acepte un parametro nuevo.
   */
  trace: Trace
  /** Log estructurado con el hilo dentro. Ver `_shared/observability`. */
  logger: Logger
}

/**
 * Handler estándar: responde el preflight, exige el método, parsea el cuerpo y
 * convierte cualquier excepción en una respuesta de error uniforme.
 */
export function serveJson(
  options: CorsOptions & {
    method?: 'POST' | 'GET'
    /** Nombre de la funcion, para el campo `service` del log. */
    service?: string
    /**
     * Sinks del log. Por defecto, la consola. Se inyectan para poder probar lo
     * que se escribe —«el correo no sale en el log»— sin capturar la salida
     * estandar del proceso, que es lo que hace que esa prueba no exista nunca.
     */
    sinks?: readonly LogSink[]
  },
  handler: (ctx: HandlerContext) => Promise<{ status: number; body: unknown }>,
): (request: Request) => Promise<Response> {
  const method = options.method ?? 'POST'
  const service = options.service ?? 'edge'

  return async (request: Request): Promise<Response> => {
    const trace = resolveTrace(request)
    // El hilo viaja en la RESPUESTA, incluida la de error y la del preflight.
    // Es lo que permite que quien abre una incidencia pegue un identificador en
    // vez de una hora aproximada: sin devolverlo, el rastro existe y nadie
    // sabe cual pedir.
    const headers = { ...corsHeaders(request.headers.get('origin'), options), ...traceHeaders(trace) }

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers })
    }

    const logger = createLogger({
      service,
      trace,
      sinks: options.sinks ?? [consoleSink()],
    })

    try {
      if (request.method !== method) throw methodNotAllowed(request.method)
      const body = method === 'POST' ? await readJsonBody(request) : {}
      const result = await logger.measure(service, () =>
        handler({ request, body, headers, trace, logger }),
      )
      return jsonResponse(result.body, result.status, headers)
    } catch (error) {
      const appError = toAppError(error)
      // `logger.measure` ya registro el fallo con su duracion y su hilo. Lo que
      // se anade aqui es la TRADUCCION: que codigo y que estado vio el cliente,
      // que es lo que hace falta para casar una queja con un registro. El
      // `console.error` crudo de antes se retira: escribia el error entero, sin
      // hilo y sin redactar.
      logger.error('request.failed', {
        code: appError.code,
        status: appError.status,
        original_code: errorCode(error),
      })
      return jsonResponse(errorPayload(appError), appError.status, headers)
    }
  }
}
