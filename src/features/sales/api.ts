import type { SupabaseClient } from '@supabase/supabase-js'
import { tryGetSupabaseClient } from '@/shared/lib/supabase'
import { SalesError, salesErrorFromDb } from './errors'
import {
  COMMISSION_STATEMENTS_TABLE,
  SALES_GOALS_TABLE,
  SALES_REPS_TABLE,
  SALES_REP_CUSTOMERS_TABLE,
  SALES_ROUTES_TABLE,
  SALES_ROUTE_STOPS_TABLE,
  SALES_TERRITORIES_TABLE,
  SALES_VISITS_TABLE,
  commissionSchema,
  goalSchema,
  portfolioRowSchema,
  routeSchema,
  routeStopSchema,
  salesRepSchema,
  territorySchema,
  visitSchema,
  type Commission,
  type CommissionStatus,
  type Goal,
  type GoalFormValues,
  type PortfolioRow,
  type Route,
  type RouteFormValues,
  type RouteStop,
  type SalesRep,
  type SalesRepFormValues,
  type Territory,
  type TerritoryFormValues,
  type Visit,
  type VisitFormValues,
  type VisitOutcome,
} from './types'

/**
 * Acceso a la fuerza de ventas.
 *
 * Ni una consulta lleva `organization_id` en el `where`, y no es un descuido:
 * el tenant lo pone la RLS desde el JWT. Filtrar aquí además daría la falsa
 * impresión de que este archivo es quien aísla, y el día que alguien lo quitara
 * «porque es redundante» no pasaría nada — hasta que la policy tuviera un fallo.
 *
 * El tenant sí viaja en el INSERT, porque una fila nueva tiene que decir de
 * quién es; la policy `with check` comprueba que coincida con el del token.
 */

function client(): SupabaseClient {
  const supabase = tryGetSupabaseClient()
  if (!supabase) throw new SalesError('auth.notConfigured', 'CONFIG_INCOMPLETA')
  return supabase
}

function nullable(value: string): string | null {
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

export interface SalesScope {
  organizationId: string
  companyId: string
}

const REP_SELECT =
  'id, organization_id, company_id, user_id, employee_code, full_name, email, phone, ' +
  'manager_id, status, hired_at, notes'

export async function fetchSalesReps(): Promise<SalesRep[]> {
  const { data, error } = await client()
    .from(SALES_REPS_TABLE)
    .select(REP_SELECT)
    .order('employee_code')

  if (error) throw salesErrorFromDb(error)
  return salesRepSchema.array().parse(data ?? [])
}

export async function saveSalesRep(input: {
  scope: SalesScope
  id: string | null
  values: SalesRepFormValues
}): Promise<void> {
  const fila = {
    employee_code: input.values.employee_code.trim(),
    full_name: input.values.full_name.trim(),
    email: nullable(input.values.email),
    phone: nullable(input.values.phone),
    manager_id: nullable(input.values.manager_id),
    status: input.values.status,
    hired_at: nullable(input.values.hired_at),
    notes: nullable(input.values.notes),
  }

  const supabase = client()
  const { error } = input.id
    ? await supabase.from(SALES_REPS_TABLE).update(fila).eq('id', input.id)
    : await supabase.from(SALES_REPS_TABLE).insert({
        organization_id: input.scope.organizationId,
        company_id: input.scope.companyId,
        ...fila,
      })

  if (error) throw salesErrorFromDb(error)
}

/**
 * Baja de un vendedor: se DESACTIVA, no se borra.
 *
 * Sus visitas, sus comisiones y su cartera cuelgan de él, y `commission_statements`
 * lo referencia con `on delete restrict` justo para que un borrado no se lleve
 * por delante una liquidación pagada. Desactivar conserva la historia y le quita
 * el acceso, que es lo que de verdad se quiere al dar de baja a alguien.
 */
export async function deactivateSalesRep(id: string): Promise<void> {
  const { error } = await client()
    .from(SALES_REPS_TABLE)
    .update({ status: 'disabled' })
    .eq('id', id)
  if (error) throw salesErrorFromDb(error)
}

// ---------------------------------------------------------------------------
// La cartera
// ---------------------------------------------------------------------------

/**
 * La cartera de un vendedor, con el nombre del cliente ya resuelto.
 *
 * Se pide con un `select` anidado en vez de dos consultas y un cruce en el
 * navegador: PostgREST resuelve la FK y devuelve el nombre en el mismo viaje, y
 * el cruce en cliente sería un sitio más donde una cartera de 300 filas se
 * convierte en 300 lecturas.
 */
export async function fetchPortfolio(repId: string | null): Promise<PortfolioRow[]> {
  if (!repId) return []

  const { data, error } = await client()
    .from(SALES_REP_CUSTOMERS_TABLE)
    .select('id, sales_rep_id, customer_id, is_primary, assigned_at, customers(code, name)')
    .eq('sales_rep_id', repId)
    .order('assigned_at', { ascending: false })

  if (error) throw salesErrorFromDb(error)

  // PostgREST tipa la relacion anidada como ARRAY aunque la FK sea a uno: el
  // tipo generado no distingue «uno» de «muchos». Se toma el primero en vez de
  // forzar el tipo con un `as`, que seria mentirle al compilador sobre la forma
  // que de verdad llega.
  const filas = (data ?? []).map((row) => {
    const { customers, ...resto } = row as unknown as Record<string, unknown> & {
      customers: { code: string; name: string }[] | { code: string; name: string } | null
    }
    const cliente = Array.isArray(customers) ? customers[0] : customers
    return {
      ...resto,
      customer_code: cliente?.code ?? null,
      customer_name: cliente?.name ?? null,
    }
  })

  return portfolioRowSchema.array().parse(filas)
}

export async function assignCustomer(input: {
  scope: SalesScope
  repId: string
  customerId: string
  isPrimary: boolean
}): Promise<void> {
  const { error } = await client().from(SALES_REP_CUSTOMERS_TABLE).insert({
    organization_id: input.scope.organizationId,
    company_id: input.scope.companyId,
    sales_rep_id: input.repId,
    customer_id: input.customerId,
    is_primary: input.isPrimary,
  })
  if (error) throw salesErrorFromDb(error)
}

export async function removeFromPortfolio(id: string): Promise<void> {
  const { error } = await client().from(SALES_REP_CUSTOMERS_TABLE).delete().eq('id', id)
  if (error) throw salesErrorFromDb(error)
}

// ---------------------------------------------------------------------------
// Territorios y rutas
// ---------------------------------------------------------------------------

/** Aplana la relación anidada que PostgREST devuelve como array. */
function primero<T>(value: T[] | T | null | undefined): T | null {
  if (Array.isArray(value)) return value[0] ?? null
  return value ?? null
}

export async function fetchTerritories(): Promise<Territory[]> {
  const { data, error } = await client()
    .from(SALES_TERRITORIES_TABLE)
    .select('id, parent_id, code, name, is_active')
    .order('code')

  if (error) throw salesErrorFromDb(error)
  return territorySchema.array().parse(data ?? [])
}

export async function saveTerritory(input: {
  scope: SalesScope
  id: string | null
  values: TerritoryFormValues
}): Promise<void> {
  const fila = {
    code: input.values.code.trim(),
    name: input.values.name.trim(),
    parent_id: nullable(input.values.parent_id),
    is_active: input.values.is_active,
  }

  const supabase = client()
  const { error } = input.id
    ? await supabase.from(SALES_TERRITORIES_TABLE).update(fila).eq('id', input.id)
    : await supabase.from(SALES_TERRITORIES_TABLE).insert({
        organization_id: input.scope.organizationId,
        company_id: input.scope.companyId,
        ...fila,
      })

  if (error) throw salesErrorFromDb(error)
}

const ROUTE_SELECT =
  'id, sales_rep_id, territory_id, code, name, weekday, frequency_weeks, is_active, ' +
  'sales_reps(full_name)'

export async function fetchRoutes(): Promise<Route[]> {
  const { data, error } = await client().from(SALES_ROUTES_TABLE).select(ROUTE_SELECT).order('code')
  if (error) throw salesErrorFromDb(error)

  const filas = (data ?? []).map((row) => {
    const { sales_reps, ...resto } = row as unknown as Record<string, unknown> & {
      sales_reps?: { full_name?: string }[] | { full_name?: string } | null
    }
    return { ...resto, rep_name: primero(sales_reps)?.full_name ?? null }
  })

  return routeSchema.array().parse(filas)
}

export async function saveRoute(input: {
  scope: SalesScope
  id: string | null
  values: RouteFormValues
}): Promise<void> {
  const fila = {
    code: input.values.code.trim(),
    name: input.values.name.trim(),
    sales_rep_id: input.values.sales_rep_id,
    territory_id: nullable(input.values.territory_id),
    weekday: Number(input.values.weekday),
    frequency_weeks: Number(input.values.frequency_weeks),
    is_active: input.values.is_active,
  }

  const supabase = client()
  const { error } = input.id
    ? await supabase.from(SALES_ROUTES_TABLE).update(fila).eq('id', input.id)
    : await supabase.from(SALES_ROUTES_TABLE).insert({
        organization_id: input.scope.organizationId,
        company_id: input.scope.companyId,
        ...fila,
      })

  if (error) throw salesErrorFromDb(error)
}

export async function fetchRouteStops(routeId: string | null): Promise<RouteStop[]> {
  if (!routeId) return []

  const { data, error } = await client()
    .from(SALES_ROUTE_STOPS_TABLE)
    .select('id, route_id, customer_id, sequence, customers(code, name)')
    .eq('route_id', routeId)
    .order('sequence')

  if (error) throw salesErrorFromDb(error)

  const filas = (data ?? []).map((row) => {
    const { customers, ...resto } = row as unknown as Record<string, unknown> & {
      customers?: { code?: string; name?: string }[] | { code?: string; name?: string } | null
    }
    const cliente = primero(customers)
    return { ...resto, customer_code: cliente?.code ?? null, customer_name: cliente?.name ?? null }
  })

  return routeStopSchema.array().parse(filas)
}

export async function addRouteStop(input: {
  scope: SalesScope
  routeId: string
  customerId: string
  sequence: number
}): Promise<void> {
  const { error } = await client().from(SALES_ROUTE_STOPS_TABLE).insert({
    organization_id: input.scope.organizationId,
    company_id: input.scope.companyId,
    route_id: input.routeId,
    customer_id: input.customerId,
    sequence: input.sequence,
  })
  if (error) throw salesErrorFromDb(error)
}

export async function removeRouteStop(id: string): Promise<void> {
  const { error } = await client().from(SALES_ROUTE_STOPS_TABLE).delete().eq('id', id)
  if (error) throw salesErrorFromDb(error)
}

// ---------------------------------------------------------------------------
// Visitas
// ---------------------------------------------------------------------------

const VISIT_SELECT =
  'id, sales_rep_id, customer_id, route_id, planned_at, checked_in_at, checked_out_at, ' +
  'outcome, order_id, notes, customers(name), sales_reps(full_name)'

export async function fetchVisits(): Promise<Visit[]> {
  const { data, error } = await client()
    .from(SALES_VISITS_TABLE)
    .select(VISIT_SELECT)
    .order('planned_at', { ascending: false })

  if (error) throw salesErrorFromDb(error)

  const filas = (data ?? []).map((row) => {
    const { customers, sales_reps, ...resto } = row as unknown as Record<string, unknown> & {
      customers?: { name?: string }[] | { name?: string } | null
      sales_reps?: { full_name?: string }[] | { full_name?: string } | null
    }
    return {
      ...resto,
      customer_name: primero(customers)?.name ?? null,
      rep_name: primero(sales_reps)?.full_name ?? null,
    }
  })

  return visitSchema.array().parse(filas)
}

export async function saveVisit(input: {
  scope: SalesScope
  values: VisitFormValues
}): Promise<void> {
  const { error } = await client().from(SALES_VISITS_TABLE).insert({
    organization_id: input.scope.organizationId,
    company_id: input.scope.companyId,
    sales_rep_id: input.values.sales_rep_id,
    customer_id: input.values.customer_id,
    route_id: nullable(input.values.route_id),
    planned_at: input.values.planned_at,
    notes: nullable(input.values.notes),
  })
  if (error) throw salesErrorFromDb(error)
}

/**
 * Marcar la ENTRADA a una visita.
 *
 * `checked_in_at` no machaca `planned_at`: la agenda y el hecho son dos cosas.
 * Borrar la primera con la segunda destruiría la única prueba de que la visita
 * no se hizo cuando tocaba, que es justo la pregunta que se le hace a una
 * fuerza de campo.
 */
export async function checkInVisit(id: string): Promise<void> {
  const { error } = await client()
    .from(SALES_VISITS_TABLE)
    .update({ checked_in_at: new Date().toISOString() })
    .eq('id', id)
  if (error) throw salesErrorFromDb(error)
}

export async function closeVisit(input: { id: string; outcome: VisitOutcome }): Promise<void> {
  const { error } = await client()
    .from(SALES_VISITS_TABLE)
    .update({ outcome: input.outcome, checked_out_at: new Date().toISOString() })
    .eq('id', input.id)
  if (error) throw salesErrorFromDb(error)
}

// ---------------------------------------------------------------------------
// Metas y comisiones
// ---------------------------------------------------------------------------

const GOAL_SELECT =
  'id, sales_rep_id, territory_id, metric, currency, period_start, period_end, ' +
  'target_value::text, sales_reps(full_name)'

export async function fetchGoals(): Promise<Goal[]> {
  const { data, error } = await client()
    .from(SALES_GOALS_TABLE)
    .select(GOAL_SELECT)
    .order('period_start', { ascending: false })

  if (error) throw salesErrorFromDb(error)

  const filas = (data ?? []).map((row) => {
    const { sales_reps, ...resto } = row as unknown as Record<string, unknown> & {
      sales_reps?: { full_name?: string }[] | { full_name?: string } | null
    }
    return { ...resto, rep_name: primero(sales_reps)?.full_name ?? null }
  })

  return goalSchema.array().parse(filas)
}

export async function saveGoal(input: {
  scope: SalesScope
  id: string | null
  values: GoalFormValues
}): Promise<void> {
  const fila = {
    sales_rep_id: nullable(input.values.sales_rep_id),
    territory_id: nullable(input.values.territory_id),
    metric: input.values.metric,
    // La moneda solo viaja cuando la métrica es importe: en las demás es ruido,
    // y `sales_goals_currency_when_amount` la rechazaría.
    currency: input.values.metric === 'amount' ? input.values.currency.toUpperCase() : null,
    period_start: input.values.period_start,
    period_end: input.values.period_end,
    target_value: input.values.target_value,
  }

  const supabase = client()
  const { error } = input.id
    ? await supabase.from(SALES_GOALS_TABLE).update(fila).eq('id', input.id)
    : await supabase.from(SALES_GOALS_TABLE).insert({
        organization_id: input.scope.organizationId,
        company_id: input.scope.companyId,
        ...fila,
      })

  if (error) throw salesErrorFromDb(error)
}

const COMMISSION_SELECT =
  'id, sales_rep_id, rule_id, period_start, period_end, currency, base_amount::text, ' +
  'rate::text, amount::text, status, approved_at, paid_at, sales_reps(full_name)'

export async function fetchCommissions(): Promise<Commission[]> {
  const { data, error } = await client()
    .from(COMMISSION_STATEMENTS_TABLE)
    .select(COMMISSION_SELECT)
    .order('period_start', { ascending: false })

  if (error) throw salesErrorFromDb(error)

  const filas = (data ?? []).map((row) => {
    const { sales_reps, ...resto } = row as unknown as Record<string, unknown> & {
      sales_reps?: { full_name?: string }[] | { full_name?: string } | null
    }
    return { ...resto, rep_name: primero(sales_reps)?.full_name ?? null }
  })

  return commissionSchema.array().parse(filas)
}

/**
 * Avanza una liquidación. La transición la valida
 * `ebim.commission_statement_guard`; aquí solo se manda la que la pantalla ya
 * decidió ofrecer, y se sella la fecha del paso — sin ella, «aprobada» no dice
 * cuándo ni permite reconstruir un cierre de mes.
 */
export async function advanceCommission(input: {
  id: string
  status: CommissionStatus
}): Promise<void> {
  const ahora = new Date().toISOString()
  const fila =
    input.status === 'approved'
      ? { status: input.status, approved_at: ahora }
      : { status: input.status, paid_at: ahora }

  const { error } = await client()
    .from(COMMISSION_STATEMENTS_TABLE)
    .update(fila)
    .eq('id', input.id)
  if (error) throw salesErrorFromDb(error)
}
