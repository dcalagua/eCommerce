/**
 * El HILO, del lado del borde.
 *
 * Una peticion que entra trae —o no— un `x-correlation-id`. Si lo trae, se
 * respeta: es el mismo incidente que empezo en otro sitio, y cambiarlo aqui
 * partiria el rastro justo en el salto que interesa (vitrina → checkout →
 * pasarela → webhook). Si no lo trae, se genera uno y se DEVUELVE en la
 * respuesta, para que el cliente pueda citarlo al abrir una incidencia.
 *
 * El `x-request-id` es distinto y por eso son dos: identifica ESTA llamada.
 * Dos reintentos del mismo checkout comparten hilo y no comparten request id,
 * que es lo unico que permite distinguir «lo intento dos veces» de «paso dos
 * veces por aqui».
 *
 * Formato: `^[A-Za-z0-9_.:-]{8,120}$`, el MISMO que valida
 * `ebim.correlation_id()` en la base. Lo que no encaje se descarta y se genera
 * uno nuevo — un hilo con saltos de linea dentro es como se falsifica una
 * entrada de bitacora, y aqui lo que llega es una cabecera de fuera.
 */

export const CORRELATION_HEADER = 'x-correlation-id'
export const REQUEST_HEADER = 'x-request-id'

/** Misma expresion que el CHECK de `analytics_events`, `audit_log` y `ops_events`. */
export const TRACE_ID_FORMAT = /^[A-Za-z0-9_.:-]{8,120}$/

export interface Trace {
  /** El incidente. Sobrevive a los saltos entre servicios. */
  readonly correlationId: string
  /** Esta llamada. No sobrevive a un reintento. */
  readonly requestId: string
}

/**
 * Identificador nuevo. `crypto.randomUUID` es estandar de la plataforma web y
 * existe igual en Deno, en Node moderno y en el navegador; no se importa nada.
 */
export function newTraceId(prefix = 'ec'): string {
  return `${prefix}-${crypto.randomUUID()}`
}

function sanitize(value: string | null | undefined): string | null {
  const trimmed = (value ?? '').trim()
  return TRACE_ID_FORMAT.test(trimmed) ? trimmed : null
}

/** Lee el hilo de la peticion, o lo abre. Nunca devuelve vacio. */
export function resolveTrace(request: { headers: { get(name: string): string | null } }): Trace {
  const correlationId = sanitize(request.headers.get(CORRELATION_HEADER)) ?? newTraceId()
  // El request id NO hereda del correlation id: si lo hiciera, dos reintentos
  // del mismo hilo compartirian request id y volveriamos a no poder separarlos.
  const requestId = sanitize(request.headers.get(REQUEST_HEADER)) ?? newTraceId('req')
  return { correlationId, requestId }
}

/**
 * Cabeceras que viajan hacia dentro (al llamar a PostgREST) y hacia fuera (en
 * la respuesta). Son las mismas dos a proposito: el cliente ve el mismo
 * identificador que la base guardo.
 */
export function traceHeaders(trace: Trace): Record<string, string> {
  return {
    [CORRELATION_HEADER]: trace.correlationId,
    [REQUEST_HEADER]: trace.requestId,
  }
}
