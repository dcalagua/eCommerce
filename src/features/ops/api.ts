import type { SupabaseClient } from '@supabase/supabase-js'
import { tryGetSupabaseClient } from '@/shared/lib/supabase'
import { OpsError, opsErrorFromDb } from './errors'
import {
  AUDIT_LOG_TABLE,
  OPS_HEALTH_RPC,
  OPS_INCIDENT_OVERVIEW_VIEW,
  OPS_RESOLVE_EVENT_RPC,
  TRACE_BY_CORRELATION_RPC,
  auditEntrySchema,
  incidentSchema,
  opsHealthSchema,
  traceStepSchema,
  type AuditEntry,
  type Incident,
  type OpsHealth,
  type TraceStep,
} from './types'

/**
 * Acceso a datos de la pantalla de operación.
 *
 * Tres reglas, y las tres son consecuencia de cómo está construido el dominio:
 *
 *  1. **Ninguna consulta declara el tenant.** `ops_health` ni siquiera lo
 *     ACEPTA: lo deriva del JWT, así que no hay nada que un cliente pueda
 *     declarar para ver la cola de otro. El listado de incidentes y la
 *     auditoría van por RLS.
 *  2. **Ningún `update`.** `ops_events` no tiene GRANT de UPDATE y `audit_log`
 *     rechaza UPDATE y DELETE con un trigger, incluso para `service_role`.
 *     Atender un incidente es un `rpc` (`ops_resolve_event`) porque son tres
 *     cosas que pasan juntas: autorización, fecha y firma de quien lo hizo.
 *  3. **El hilo se pide entero.** `trace_by_correlation` devuelve la línea de
 *     tiempo de once tablas; encadenar once consultas desde el navegador daría
 *     un orden que depende de cuál conteste antes.
 */

function client(): SupabaseClient {
  const supabase = tryGetSupabaseClient()
  if (!supabase) throw new OpsError('auth.notConfigured', 'CONFIG_INCOMPLETA')
  return supabase
}

export async function fetchOpsHealth(storeId: string | null): Promise<OpsHealth> {
  const { data, error } = await client().rpc(OPS_HEALTH_RPC, { p_store_id: storeId })
  if (error) throw opsErrorFromDb(error)
  return opsHealthSchema.parse(data)
}

const INCIDENT_SELECT =
  'id, kind, severity, code, message, source, operation, duration_ms, entity_type, ' +
  'entity_id, correlation_id, occurred_at, resolved_at, resolution_note, is_open, ' +
  'age_seconds, repeats'

export interface IncidentFilter {
  /** `''` = todos. Es la pestaña de estado, no un panel de filtros. */
  status: 'open' | 'resolved' | ''
  term: string
}

export async function fetchIncidents(filter: IncidentFilter): Promise<Incident[]> {
  let query = client()
    .from(OPS_INCIDENT_OVERVIEW_VIEW)
    .select(INCIDENT_SELECT)
    .order('occurred_at', { ascending: false })
    .limit(200)

  if (filter.status === 'open') query = query.is('resolved_at', null)
  if (filter.status === 'resolved') query = query.not('resolved_at', 'is', null)

  const term = filter.term.trim()
  if (term !== '') {
    // Un solo buscador general (regla de suite §8): código, operación o hilo.
    // `%` y `,` se escapan porque `or` los interpreta.
    const safe = term.replace(/[%,()]/g, ' ')
    query = query.or(
      `code.ilike.%${safe}%,operation.ilike.%${safe}%,correlation_id.ilike.%${safe}%`,
    )
  }

  const { data, error } = await query
  if (error) throw opsErrorFromDb(error)
  return (data ?? []).map((row) => incidentSchema.parse(row))
}

export async function resolveIncident(id: string, note: string): Promise<void> {
  const { error } = await client().rpc(OPS_RESOLVE_EVENT_RPC, { p_event_id: id, p_note: note })
  if (error) throw opsErrorFromDb(error)
}

const AUDIT_SELECT =
  'id, occurred_at, actor_email, actor_kind, actor_role, action, entity_type, ' +
  'entity_id, entity_label, correlation_id, cross_tenant'

export async function fetchAuditLog(term: string): Promise<AuditEntry[]> {
  let query = client()
    .from(AUDIT_LOG_TABLE)
    .select(AUDIT_SELECT)
    .order('occurred_at', { ascending: false })
    .limit(200)

  const clean = term.trim()
  if (clean !== '') {
    const safe = clean.replace(/[%,()]/g, ' ')
    query = query.or(
      `action.ilike.%${safe}%,actor_email.ilike.%${safe}%,entity_label.ilike.%${safe}%,correlation_id.ilike.%${safe}%`,
    )
  }

  const { data, error } = await query
  if (error) throw opsErrorFromDb(error)
  return (data ?? []).map((row) => auditEntrySchema.parse(row))
}

export async function fetchTrace(correlationId: string): Promise<TraceStep[]> {
  const { data, error } = await client().rpc(TRACE_BY_CORRELATION_RPC, {
    p_correlation_id: correlationId,
  })
  if (error) throw opsErrorFromDb(error)
  return (data ?? []).map((row: unknown) => traceStepSchema.parse(row))
}
