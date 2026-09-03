import type { SupabaseClient } from '@supabase/supabase-js'
import { tryGetSupabaseClient } from '@/shared/lib/supabase'
import { FulfillmentError, fulfillmentErrorFromDb } from './errors'
import {
  DELIVERY_PLANS_TABLE,
  DELIVERY_PLAN_STOPS_TABLE,
  DELIVERY_VEHICLES_TABLE,
  PROOF_OF_DELIVERY_TABLE,
  planSchema,
  planStopSchema,
  podSchema,
  vehicleSchema,
  type Plan,
  type PlanFormValues,
  type PlanStatus,
  type PlanStop,
  type Pod,
  type PodFormValues,
  type Vehicle,
} from './routing-types'

/**
 * Reparto propio: hojas de ruta, paradas y evidencia de entrega.
 *
 * Ninguna consulta filtra por tenant: lo hace la RLS desde el JWT. El tenant sí
 * viaja en el INSERT, porque una fila nueva tiene que decir de quién es.
 */

function client(): SupabaseClient {
  const supabase = tryGetSupabaseClient()
  if (!supabase) throw new FulfillmentError('auth.notConfigured', 'CONFIG_INCOMPLETA')
  return supabase
}

function nullable(value: string): string | null {
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

export interface RoutingScope {
  organizationId: string
  companyId: string
  storeId: string
}

function primero<T>(value: T[] | T | null | undefined): T | null {
  if (Array.isArray(value)) return value[0] ?? null
  return value ?? null
}

// ---------------------------------------------------------------------------
// Vehículos
// ---------------------------------------------------------------------------

export async function fetchVehicles(): Promise<Vehicle[]> {
  const { data, error } = await client()
    .from(DELIVERY_VEHICLES_TABLE)
    .select('id, code, plate, description, capacity_kg::text, is_active')
    .order('code')

  if (error) throw fulfillmentErrorFromDb(error)
  return vehicleSchema.array().parse(data ?? [])
}

// ---------------------------------------------------------------------------
// Hojas de ruta
// ---------------------------------------------------------------------------

const PLAN_SELECT =
  'id, store_id, vehicle_id, code, plan_date, status, driver_name, dispatched_at, ' +
  'closed_at, delivery_vehicles(code)'

export async function fetchPlans(): Promise<Plan[]> {
  const { data, error } = await client()
    .from(DELIVERY_PLANS_TABLE)
    .select(PLAN_SELECT)
    .order('plan_date', { ascending: false })

  if (error) throw fulfillmentErrorFromDb(error)

  const filas = (data ?? []).map((row) => {
    const { delivery_vehicles, ...resto } = row as unknown as Record<string, unknown> & {
      delivery_vehicles?: { code?: string }[] | { code?: string } | null
    }
    return { ...resto, vehicle_code: primero(delivery_vehicles)?.code ?? null }
  })

  return planSchema.array().parse(filas)
}

export async function savePlan(input: {
  scope: RoutingScope
  id: string | null
  values: PlanFormValues
}): Promise<void> {
  const fila = {
    code: input.values.code.trim(),
    plan_date: input.values.plan_date,
    vehicle_id: nullable(input.values.vehicle_id),
    driver_name: nullable(input.values.driver_name),
  }

  const supabase = client()
  const { error } = input.id
    ? await supabase.from(DELIVERY_PLANS_TABLE).update(fila).eq('id', input.id)
    : await supabase.from(DELIVERY_PLANS_TABLE).insert({
        organization_id: input.scope.organizationId,
        company_id: input.scope.companyId,
        store_id: input.scope.storeId,
        ...fila,
      })

  if (error) throw fulfillmentErrorFromDb(error)
}

/**
 * Avanza el estado de la hoja y sella la hora del paso.
 *
 * `dispatched_at` y `closed_at` se escriben aquí porque la base no tiene
 * trigger de estado en `delivery_plans`: una hoja «despachada» sin hora de
 * salida no permite responder a qué hora salió el camión, que es media
 * pregunta de cualquier reclamo de entrega.
 */
export async function setPlanStatus(input: { id: string; status: PlanStatus }): Promise<void> {
  const ahora = new Date().toISOString()
  const fila: Record<string, unknown> = { status: input.status }
  if (input.status === 'dispatched') fila.dispatched_at = ahora
  if (input.status === 'closed') fila.closed_at = ahora

  const { error } = await client().from(DELIVERY_PLANS_TABLE).update(fila).eq('id', input.id)
  if (error) throw fulfillmentErrorFromDb(error)
}

export async function fetchPlanStops(planId: string | null): Promise<PlanStop[]> {
  if (!planId) return []

  const { data, error } = await client()
    .from(DELIVERY_PLAN_STOPS_TABLE)
    .select('id, plan_id, fulfillment_id, sequence, eta')
    .eq('plan_id', planId)
    .order('sequence')

  if (error) throw fulfillmentErrorFromDb(error)
  return planStopSchema.array().parse(data ?? [])
}

/**
 * Cuelga un despacho EXISTENTE de la hoja de ruta.
 *
 * No crea el despacho: `delivery_plan_stops_fulfillment_unique` además impide
 * que el mismo vaya en dos hojas, porque entonces el camión saldría dos veces
 * con la misma mercadería y una de las dos entregas no existiría.
 */
export async function addPlanStop(input: {
  scope: RoutingScope
  planId: string
  fulfillmentId: string
  sequence: number
}): Promise<void> {
  const { error } = await client().from(DELIVERY_PLAN_STOPS_TABLE).insert({
    organization_id: input.scope.organizationId,
    company_id: input.scope.companyId,
    plan_id: input.planId,
    fulfillment_id: input.fulfillmentId,
    sequence: input.sequence,
  })
  if (error) throw fulfillmentErrorFromDb(error)
}

export async function removePlanStop(id: string): Promise<void> {
  const { error } = await client().from(DELIVERY_PLAN_STOPS_TABLE).delete().eq('id', id)
  if (error) throw fulfillmentErrorFromDb(error)
}

// ---------------------------------------------------------------------------
// Evidencia de entrega
// ---------------------------------------------------------------------------

export async function fetchPods(): Promise<Pod[]> {
  const { data, error } = await client()
    .from(PROOF_OF_DELIVERY_TABLE)
    .select('id, fulfillment_id, stop_id, outcome, received_by, document_id, reason, created_at')
    .order('created_at', { ascending: false })

  if (error) throw fulfillmentErrorFromDb(error)
  return podSchema.array().parse(data ?? [])
}

/**
 * Firma una entrega. **Solo INSERT**: la tabla es append-only y el trigger
 * `pod_is_immutable` rechaza cualquier update o delete. Una prueba de entrega
 * que se puede editar no prueba nada; se corrige con una entrega nueva.
 */
export async function recordPod(input: {
  scope: RoutingScope
  fulfillmentId: string
  stopId: string | null
  values: PodFormValues
}): Promise<void> {
  const { error } = await client().from(PROOF_OF_DELIVERY_TABLE).insert({
    organization_id: input.scope.organizationId,
    company_id: input.scope.companyId,
    fulfillment_id: input.fulfillmentId,
    stop_id: input.stopId,
    outcome: input.values.outcome,
    received_by: nullable(input.values.received_by),
    document_id: nullable(input.values.document_id),
    reason: nullable(input.values.reason),
  })
  if (error) throw fulfillmentErrorFromDb(error)
}
