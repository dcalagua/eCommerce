/**
 * Log estructurado y metricas del borde, sin un solo vendor dentro.
 *
 * ## La regla que hace esto sustituible
 *
 * Un logger no ESCRIBE: emite un registro a una lista de **sinks**. La consola
 * es un sink; la base es otro; el dia que se contrate un proveedor de
 * observabilidad, ese proveedor es un tercer sink de veinte lineas y ni una de
 * las Edge Functions cambia. Es el mismo patron —contrato canonico + registro
 * de adaptadores— que P09 uso para las pasarelas y P12 para los transportistas,
 * y funciona por la misma razon: el nombre propio vive en el registro, nunca en
 * el llamante.
 *
 * ## Que emite, siempre
 *
 * Un `LogRecord` con campos ESTABLES: momento, nivel, evento, hilo
 * (`correlation_id` y `request_id`), operacion, duracion y contexto. El contexto
 * pasa SIEMPRE por `redact` antes de salir. No hay forma de emitir un log sin
 * redactar, porque `emit` no acepta el registro ya construido: lo construye el.
 *
 * ## Metricas
 *
 * Las de este borde son dos y las dos salen del mismo sitio que los logs:
 * cuanto tardo cada operacion y cuantas fallaron. No hay un sistema de metricas
 * aparte porque no haria falta uno: `duration_ms` en cada registro terminal es
 * la serie, y `ops_events` la conserva cuando pasa del umbral. Inventar
 * contadores en memoria en un runtime que se apaga entre peticiones habria dado
 * numeros que se pierden.
 */
import { redact, redactText } from './redact.ts'
import type { Trace } from './correlation.ts'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface LogRecord {
  readonly at: string
  readonly level: LogLevel
  /** Nombre canonico del hecho: `request.started`, `checkout.failed`. */
  readonly event: string
  readonly service: string
  readonly correlation_id: string
  readonly request_id: string
  readonly operation?: string
  readonly duration_ms?: number
  readonly status?: number
  readonly code?: string
  readonly message?: string
  readonly context?: Record<string, unknown>
}

/** El punto de integracion. Un proveedor nuevo es una implementacion de esto. */
export interface LogSink {
  readonly name: string
  write(record: LogRecord): void
}

/**
 * Cuanto es «lento». 1500 ms no es un numero magico: es el orden en el que un
 * comprador deja de creer que el boton funciono. Se puede subir por entorno,
 * pero NO se puede apagar — un umbral infinito es no tener umbral.
 */
export const DEFAULT_SLOW_MS = 1500

export interface LoggerOptions {
  readonly service: string
  readonly trace: Trace
  readonly sinks: readonly LogSink[]
  readonly slowMs?: number
}

export interface Logger {
  readonly trace: Trace
  debug(event: string, context?: Record<string, unknown>): void
  info(event: string, context?: Record<string, unknown>): void
  warn(event: string, context?: Record<string, unknown>): void
  error(event: string, context?: Record<string, unknown>): void
  /**
   * Mide una operacion y emite su registro terminal. Devuelve lo que devuelva
   * la operacion; un fallo se registra y se vuelve a lanzar — un logger que se
   * traga excepciones convierte un error en un silencio.
   */
  measure<T>(operation: string, run: () => Promise<T>): Promise<T>
}

function nowMs(): number {
  // `performance.now` existe en Deno, Node y el navegador. `Date.now` es el
  // respaldo para cualquier runtime que no lo traiga.
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now()
}

export function createLogger(options: LoggerOptions): Logger {
  const slowMs = options.slowMs ?? DEFAULT_SLOW_MS

  function emit(level: LogLevel, event: string, extra: Partial<LogRecord> = {}): LogRecord {
    const record: LogRecord = {
      at: new Date().toISOString(),
      level,
      event,
      service: options.service,
      correlation_id: options.trace.correlationId,
      request_id: options.trace.requestId,
      ...extra,
      // El contexto se redacta SIEMPRE y al final: si se hiciera antes del
      // spread, un `extra.context` posterior lo pisaria sin pasar por la guarda.
      ...(extra.context ? { context: redact(extra.context) } : {}),
      ...(extra.message ? { message: redactText(extra.message, 500) ?? undefined } : {}),
    }
    for (const sink of options.sinks) {
      try {
        sink.write(record)
      } catch {
        // Un sink roto no puede tumbar la peticion que estaba registrando. Es
        // la misma regla que `ebim.audit`: el registro no manda sobre el hecho.
      }
    }
    return record
  }

  return {
    trace: options.trace,
    debug: (event, context) => void emit('debug', event, context ? { context } : {}),
    info: (event, context) => void emit('info', event, context ? { context } : {}),
    warn: (event, context) => void emit('warn', event, context ? { context } : {}),
    error: (event, context) => void emit('error', event, context ? { context } : {}),

    async measure<T>(operation: string, run: () => Promise<T>): Promise<T> {
      const started = nowMs()
      try {
        const result = await run()
        const duration = Math.round(nowMs() - started)
        emit('info', 'operation.completed', { operation, duration_ms: duration })
        // La lentitud es un HECHO APARTE y no una propiedad del registro
        // anterior. Tiene que serlo: los sinks deciden que escriben mirando
        // `event`, y un `operation.completed` que a veces significa «tardo
        // demasiado» obligaria a cada sink a repetir el umbral — y a que dos
        // sinks lo tuvieran distinto.
        if (duration >= slowMs) {
          emit('warn', 'operation.slow', {
            operation,
            duration_ms: duration,
            code: 'OPERACION_LENTA',
            context: { threshold_ms: slowMs },
          })
        }
        return result
      } catch (error) {
        const duration = Math.round(nowMs() - started)
        emit('error', 'operation.failed', {
          operation,
          duration_ms: duration,
          code: errorCode(error),
          message: error instanceof Error ? error.message : String(error),
        })
        throw error
      }
    },
  }
}

/**
 * Codigo del error, si lo tiene. No se inventa uno: un `ERROR_INTERNO` puesto
 * por defecto sobre un error que si traia codigo haria que todos los fallos se
 * agruparan en el mismo cubo.
 */
export function errorCode(error: unknown): string | undefined {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as { code?: unknown }).code
    if (typeof code === 'string' && code.length > 0) return code
  }
  return undefined
}
