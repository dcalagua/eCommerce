import type { SupabaseClient } from '@supabase/supabase-js'
import { tryGetSupabaseClient } from '@/shared/lib/supabase'
import { SalesError, salesErrorFromDb } from './errors'
import {
  SALES_REPS_TABLE,
  SALES_REP_CUSTOMERS_TABLE,
  portfolioRowSchema,
  salesRepSchema,
  type PortfolioRow,
  type SalesRep,
  type SalesRepFormValues,
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
