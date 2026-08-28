import { z } from 'zod'

/**
 * Tipos del Monitor de Integraciones (P14-SaaS).
 *
 * Dos reglas propias, las dos heredadas de P13 y por las mismas razones:
 *
 *  1. **Aquí no se calcula ninguna edad ni ningún umbral.** `integration_monitor`
 *     trae `age_seconds`, `is_open`, `is_dead` e `is_retrying` ya resueltos, e
 *     `integration_health` trae `oldest_pending_seconds` por proveedor. Restar
 *     `now()` en el navegador haría que el diagnóstico dependiera del reloj del
 *     portátil de quien mira.
 *  2. **Aquí no se decide qué se puede enseñar.** El contenido de un mensaje
 *     llega ya redactado por `integration_message_detail` —dos pasadas, tarjeta
 *     y datos personales— y la URL del destino, ya sin cadena de consulta. Un
 *     filtro en el navegador es un filtro que se puede saltar abriendo la
 *     pestaña de red.
 */

export {
  API_CLIENTS_TABLE,
  API_CLIENT_CREATE_RPC,
  API_CLIENT_ROTATE_SECRET_RPC,
  INTEGRATION_CIRCUIT_RESET_RPC,
  INTEGRATION_HEALTH_RPC,
  INTEGRATION_MESSAGE_DETAIL_RPC,
  INTEGRATION_MONITOR_VIEW,
  INTEGRATION_RETRY_RPC,
  WEBHOOK_ENDPOINTS_TABLE,
  WEBHOOK_MONITOR_VIEW,
  WEBHOOK_REPLAY_RPC,
  WEBHOOK_SUBSCRIPTIONS_TABLE,
} from '@/shared/lib/db-schema'

/** Copia del enum `public.outbox_status`. Un test compara las dos listas. */
export const OUTBOX_STATUSES = ['pending', 'in_flight', 'succeeded', 'failed', 'dead'] as const
export type OutboxStatus = (typeof OUTBOX_STATUSES)[number]

/** Copia del enum `public.circuit_state`. */
export const CIRCUIT_STATES = ['closed', 'open', 'half_open'] as const
export type CircuitState = (typeof CIRCUIT_STATES)[number]

const providerHealthSchema = z.object({
  provider_code: z.string(),
  provider_name: z.string(),
  provider_kind: z.string(),
  is_active: z.boolean(),
  direction: z.string(),
  pending: z.number(),
  in_flight: z.number(),
  dead: z.number(),
  succeeded_24h: z.number(),
  failed_24h: z.number(),
  last_success_at: z.string().nullable(),
  last_failure_at: z.string().nullable(),
  oldest_pending_seconds: z.number().nullable(),
  open_circuits: z.number(),
})
export type ProviderHealth = z.infer<typeof providerHealthSchema>

const circuitSchema = z.object({
  id: z.string(),
  provider_code: z.string(),
  operation: z.string(),
  target: z.string(),
  target_label: z.string(),
  state: z.string(),
  consecutive_fail: z.number(),
  threshold: z.number(),
  opened_at: z.string().nullable(),
})
export type OpenCircuit = z.infer<typeof circuitSchema>

export const integrationHealthSchema = z.object({
  organization_id: z.string(),
  company_id: z.string(),
  generated_at: z.string(),
  providers: z.array(providerHealthSchema),
  circuits: z.array(circuitSchema),
  webhooks: z.object({
    endpoints: z.number(),
    endpoints_active: z.number(),
    subscriptions: z.number(),
    deliveries_24h: z.number(),
  }),
  api: z.object({
    clients: z.number(),
    clients_active: z.number(),
    requests_24h: z.number(),
    errors_24h: z.number(),
  }),
})
export type IntegrationHealth = z.infer<typeof integrationHealthSchema>

export const queueMessageSchema = z.object({
  id: z.string(),
  provider_code: z.string(),
  provider_name: z.string(),
  provider_kind: z.string(),
  operation: z.string(),
  target: z.string(),
  target_label: z.string(),
  status: z.string(),
  attempts: z.number(),
  max_attempts: z.number(),
  next_retry_at: z.string().nullable(),
  completed_at: z.string().nullable(),
  correlation_id: z.string().nullable(),
  created_at: z.string(),
  last_error: z.string().nullable(),
  circuit_state: z.string(),
  age_seconds: z.number(),
  is_open: z.boolean(),
  is_dead: z.boolean(),
  is_retrying: z.boolean(),
})
export type QueueMessage = z.infer<typeof queueMessageSchema>

export const messageDetailSchema = z.object({
  id: z.string(),
  provider_code: z.string(),
  operation: z.string(),
  target: z.string(),
  target_label: z.string().nullable(),
  target_url: z.string().nullable(),
  status: z.string(),
  attempts: z.number(),
  max_attempts: z.number(),
  next_retry_at: z.string().nullable(),
  correlation_id: z.string().nullable(),
  created_at: z.string(),
  last_error: z.string().nullable(),
  payload: z.unknown(),
  attempts_log: z.array(
    z.object({
      attempt: z.number(),
      succeeded: z.boolean(),
      status_code: z.number().nullable(),
      latency_ms: z.number().nullable(),
      error: z.string().nullable(),
      at: z.string(),
    }),
  ),
})
export type MessageDetail = z.infer<typeof messageDetailSchema>

export const webhookEndpointSchema = z.object({
  id: z.string(),
  name: z.string(),
  url: z.string(),
  secret_ref: z.string(),
  api_version: z.string(),
  description: z.string().nullable(),
  is_active: z.boolean(),
  max_attempts: z.number(),
  created_at: z.string(),
})
export type WebhookEndpoint = z.infer<typeof webhookEndpointSchema>

export const webhookSubscriptionSchema = z.object({
  id: z.string(),
  endpoint_id: z.string(),
  event_type: z.string(),
  is_active: z.boolean(),
})
export type WebhookSubscription = z.infer<typeof webhookSubscriptionSchema>

export const webhookDeliverySchema = z.object({
  id: z.string(),
  endpoint_id: z.string(),
  endpoint_name: z.string(),
  event_id: z.string(),
  event_type: z.string(),
  outbox_id: z.string().nullable(),
  is_replay: z.boolean(),
  replay_reason: z.string().nullable(),
  correlation_id: z.string().nullable(),
  created_at: z.string(),
  status: z.string(),
  attempts: z.number().nullable(),
  last_status_code: z.number().nullable(),
  last_error: z.string().nullable(),
  age_seconds: z.number(),
})
export type WebhookDelivery = z.infer<typeof webhookDeliverySchema>

export const apiClientSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  client_id: z.string(),
  secret_hint: z.string(),
  scopes: z.array(z.string()),
  is_active: z.boolean(),
  rate_limit_per_minute: z.number(),
  expires_at: z.string().nullable(),
  last_used_at: z.string().nullable(),
  created_at: z.string(),
})
export type ApiClientRow = z.infer<typeof apiClientSchema>

/**
 * Lo que devuelve `api_client_create` / `api_client_rotate_secret`: el secreto
 * en claro, UNA vez. No se guarda en el estado más allá del diálogo que lo
 * enseña, y no se vuelve a pedir nunca — la base guarda su sha256 y no lo
 * puede devolver aunque alguien lo pida.
 */
export const newCredentialSchema = z.object({
  id: z.string(),
  client_id: z.string(),
  client_secret: z.string(),
})
export type NewCredential = z.infer<typeof newCredentialSchema>
