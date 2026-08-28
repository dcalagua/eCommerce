import { z } from 'zod'

/**
 * Tipos de la pantalla de operación (P13-SaaS).
 *
 * Regla propia: **aquí no se calcula ninguna edad ni ningún umbral.** La vista
 * `ops_incident_overview` trae `age_seconds` e `is_open` ya resueltos, y
 * `ops_health` trae `oldest_pending_seconds` por cola. Restar `now()` en el
 * navegador haría que el diagnóstico dependiera del reloj del portátil de quien
 * mira: con la hora mal puesta, un incidente de hace diez minutos aparece como
 * de hace dos horas — y la respuesta a un incidente se decide justamente por
 * eso. Es la misma decisión que `fulfillment_overview.is_late` en P12.
 */

export {
  AUDIT_LOG_TABLE,
  OPS_HEALTH_RPC,
  OPS_INCIDENT_OVERVIEW_VIEW,
  OPS_RESOLVE_EVENT_RPC,
  TRACE_BY_CORRELATION_RPC,
} from '@/shared/lib/db-schema'

/** Copia del enum `public.ops_event_kind`. Un test compara las dos listas. */
export const OPS_EVENT_KINDS = [
  'checkout_failed',
  'payment_failed',
  'integration_failed',
  'event_undelivered',
  'webhook_rejected',
  'slow_operation',
] as const
export type OpsEventKind = (typeof OPS_EVENT_KINDS)[number]

/** Copia del enum `public.ops_severity`. */
export const OPS_SEVERITIES = ['info', 'warning', 'error', 'critical'] as const
export type OpsSeverity = (typeof OPS_SEVERITIES)[number]

/** Copia del enum `public.audit_actor_kind`. */
export const AUDIT_ACTOR_KINDS = ['user', 'service', 'support', 'system'] as const
export type AuditActorKind = (typeof AUDIT_ACTOR_KINDS)[number]

const queueSchema = z.object({
  pending: z.number().optional(),
  in_flight: z.number().optional(),
  failed: z.number().optional(),
  dead: z.number().optional(),
  unprocessed: z.number().optional(),
  oldest_pending_seconds: z.number().nullable().optional(),
})
export type QueueDepth = z.infer<typeof queueSchema>

export const opsHealthSchema = z.object({
  organization_id: z.string(),
  company_id: z.string(),
  generated_at: z.string(),
  queues: z.object({
    domain_events: queueSchema,
    integration_outbox: queueSchema,
    integration_inbox: queueSchema,
  }),
  last_24h: z.object({
    checkouts_failed: z.number(),
    checkouts_total: z.number(),
    payments_failed: z.number(),
    integrations_failed: z.number(),
  }),
  stuck_checkouts: z.number(),
  open_incidents: z.record(z.string(), z.number()),
  slow_operations: z.object({ count: z.number(), max_ms: z.number().nullable() }),
  platform_context: z
    .object({
      source: z.string(),
      app_active: z.boolean(),
      synced_at: z.string().nullable(),
    })
    .nullable(),
})
export type OpsHealth = z.infer<typeof opsHealthSchema>

export const incidentSchema = z.object({
  id: z.string(),
  kind: z.string(),
  severity: z.string(),
  code: z.string(),
  message: z.string().nullable(),
  source: z.string(),
  operation: z.string().nullable(),
  duration_ms: z.number().nullable(),
  entity_type: z.string().nullable(),
  entity_id: z.string().nullable(),
  correlation_id: z.string().nullable(),
  occurred_at: z.string(),
  resolved_at: z.string().nullable(),
  resolution_note: z.string().nullable(),
  is_open: z.boolean(),
  age_seconds: z.number(),
  repeats: z.number(),
})
export type Incident = z.infer<typeof incidentSchema>

export const auditEntrySchema = z.object({
  id: z.string(),
  occurred_at: z.string(),
  actor_email: z.string().nullable(),
  actor_kind: z.string(),
  actor_role: z.string().nullable(),
  action: z.string(),
  entity_type: z.string(),
  entity_id: z.string().nullable(),
  entity_label: z.string().nullable(),
  correlation_id: z.string().nullable(),
  cross_tenant: z.boolean(),
})
export type AuditEntry = z.infer<typeof auditEntrySchema>

export const traceStepSchema = z.object({
  occurred_at: z.string(),
  domain: z.string(),
  entity_type: z.string().nullable(),
  entity_id: z.string().nullable(),
  summary: z.string().nullable(),
  status: z.string().nullable(),
  severity: z.string().nullable(),
})
export type TraceStep = z.infer<typeof traceStepSchema>
