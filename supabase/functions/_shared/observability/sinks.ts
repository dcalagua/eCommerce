/**
 * Los sinks que trae el producto. Ninguno nombra a un proveedor.
 *
 *   consoleSink  siempre. Una linea de JSON por registro, que es el formato que
 *                cualquier recolector sabe leer sin configurar nada.
 *   memorySink   para los tests. Es lo que permite probar «el correo no sale en
 *                el log» sin capturar la salida estandar del proceso.
 *   incidentSink el puente con `ops_events`: solo lo que merece un incidente.
 *
 * Anadir uno nuevo —de pago o propio— es implementar `LogSink` y pasarlo en la
 * lista. No hay registro global mutable a proposito: en un runtime que crea y
 * destruye aislados por peticion, un registro global es estado que a veces esta
 * y a veces no, y eso produce el bug que solo pasa en produccion.
 */
import type { LogRecord, LogSink } from './logger.ts'

/** JSON por linea a la salida estandar. Nivel `error` va a `console.error`. */
export function consoleSink(): LogSink {
  return {
    name: 'console',
    write(record: LogRecord): void {
      const line = JSON.stringify(record)
      if (record.level === 'error') console.error(line)
      else if (record.level === 'warn') console.warn(line)
      else console.log(line)
    },
  }
}

export interface MemorySink extends LogSink {
  readonly records: readonly LogRecord[]
  clear(): void
}

export function memorySink(): MemorySink {
  const records: LogRecord[] = []
  return {
    name: 'memory',
    records,
    write: (record) => void records.push(record),
    clear: () => void (records.length = 0),
  }
}

/** Lo que `incidentSink` manda a `public.ops_record_event`. */
export interface IncidentReport {
  readonly kind: 'checkout_failed' | 'payment_failed' | 'integration_failed'
    | 'event_undelivered' | 'webhook_rejected' | 'slow_operation'
  readonly code: string
  readonly dedupeKey: string
  readonly severity: 'info' | 'warning' | 'error' | 'critical'
  readonly message?: string
  readonly source: string
  readonly operation?: string
  readonly durationMs?: number
  readonly correlationId: string
  readonly context?: Record<string, unknown>
}

export type IncidentReporter = (report: IncidentReport) => void | Promise<void>

/**
 * Sink que convierte SOLO lo que merece atencion en un incidente persistido.
 *
 * Deliberadamente selectivo: si cada log de nivel `info` acabara en
 * `ops_events`, la tabla seria una copia del log y la pantalla de salud
 * dejaria de servir para lo unico que sirve, que es ver lo que esta roto. Pasan
 * dos cosas y solo dos:
 *
 *   · `operation.failed` — algo no se pudo hacer;
 *   · `operation.slow`   — algo se hizo, pero tarde.
 *
 * La escritura es «dispara y olvida»: un fallo al registrar el incidente no
 * puede propagarse a la peticion, por la misma razon que `ebim.record_ops_event`
 * nunca levanta.
 */
export function incidentSink(
  report: IncidentReporter,
  options: { readonly source: string; readonly kind?: IncidentReport['kind'] },
): LogSink {
  return {
    name: 'incident',
    write(record: LogRecord): void {
      const isFailure = record.event === 'operation.failed'
      const isSlow = record.event === 'operation.slow'
      if (!isFailure && !isSlow) return

      void Promise.resolve(
        report({
          kind: isSlow ? 'slow_operation' : (options.kind ?? 'integration_failed'),
          code: record.code ?? (isSlow ? 'OPERACION_LENTA' : 'ERROR_INTERNO'),
          // La clave de deduplicacion incluye el HILO: dos incidentes del mismo
          // codigo en dos compras distintas son dos incidentes. Sin el hilo, el
          // segundo comprador solo subiria un contador y nadie sabria que le
          // paso a el.
          dedupeKey: `${options.source}:${record.operation ?? record.event}:${record.correlation_id}`,
          severity: isSlow ? 'warning' : 'error',
          ...(record.message ? { message: record.message } : {}),
          source: options.source,
          ...(record.operation ? { operation: record.operation } : {}),
          ...(record.duration_ms !== undefined ? { durationMs: record.duration_ms } : {}),
          correlationId: record.correlation_id,
          ...(record.context ? { context: record.context } : {}),
        }),
      ).catch(() => {
        // Ver arriba: el registro no manda sobre el hecho.
      })
    },
  }
}
