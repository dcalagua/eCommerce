/**
 * Categorías fiscales y sus tasas, bajo RLS.
 *
 * Sin Edge Function y sin filtro de tenant en las consultas: `tax_categories` y
 * `tax_rates` tienen policies de escritura para `owner`/`admin`, así que la
 * autorización ya la decide la base con el JWT.
 *
 * La tasa NO se actualiza con un UPDATE: se versiona. Cambiarla es cerrar la
 * vigente y abrir la siguiente, y eso tiene que ser atómico, así que pasa
 * siempre por el RPC `set_tax_rate`. Un UPDATE directo desde aquí rompería el
 * histórico que necesita cualquier recálculo de un pedido antiguo.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { z } from 'zod'
import { AppError } from '@/domain/errors'
import { codeFromDbError, type PostgrestLike } from '@/shared/lib/appError'
import { tryGetSupabaseClient } from '@/shared/lib/supabase'

import { SET_TAX_RATE_RPC, TAX_CATEGORIES_TABLE } from '@/shared/lib/db-schema'

export { SET_TAX_RATE_RPC, TAX_CATEGORIES_TABLE }

export const taxCategorySchema = z.object({
  id: z.string().uuid(),
  code: z.string(),
  name: z.string(),
  is_default: z.boolean(),
  /** Tasa vigente hoy. `null` = categoría creada pero todavía sin tasa. */
  rate: z.string().nullable(),
})

export type TaxCategory = z.infer<typeof taxCategorySchema>

export interface TaxCategoryInput {
  code: string
  name: string
  isDefault: boolean
  /** Porcentaje tal y como lo escribe el usuario: 13 significa 13 %. */
  ratePercent: number
}

function client() {
  const supabase = tryGetSupabaseClient()
  if (!supabase) throw new AppError({ boundary: 'configuration', code: 'CONFIG_INCOMPLETA' })
  return supabase
}

function fail(error: PostgrestLike): never {
  throw new AppError({ boundary: 'configuration', code: codeFromDbError(error) })
}

/**
 * Categorías con su tasa vigente. El `!inner` no sirve aquí: una categoría sin
 * tasa tiene que aparecer igualmente, porque es justo el estado que hay que
 * enseñarle al administrador para que la complete.
 */
export async function fetchTaxCategories(): Promise<TaxCategory[]> {
  const supabase = client()
  const { data, error } = await supabase
    .from(TAX_CATEGORIES_TABLE)
    .select('id, code, name, is_default, tax_rates(rate, valid_from, valid_to)')
    .order('name')

  if (error) fail(error)

  type RateRow = { rate: string; valid_from: string; valid_to: string | null }
  const rows = (data ?? []) as Array<Record<string, unknown>>

  return rows.map((row) => {
    const rates = (row.tax_rates ?? []) as RateRow[]
    const current = rates.find((r) => r.valid_to === null) ?? null
    return taxCategorySchema.parse({
      id: row.id,
      code: row.code,
      name: row.name,
      is_default: row.is_default,
      rate: current ? String(current.rate) : null,
    })
  })
}

/** El porcentaje que escribe el usuario se guarda como fracción: 13 → 0.1300. */
export function percentToRate(percent: number): number {
  return Number((percent / 100).toFixed(4))
}

export function rateToPercent(rate: string | null): number | null {
  if (rate === null) return null
  return Number((Number(rate) * 100).toFixed(2))
}

export async function createTaxCategory(
  organizationId: string,
  companyId: string,
  input: TaxCategoryInput,
): Promise<void> {
  const supabase = client()

  const { data, error } = await supabase
    .from(TAX_CATEGORIES_TABLE)
    .insert({
      organization_id: organizationId,
      company_id: companyId,
      code: input.code,
      name: input.name,
      is_default: input.isDefault,
    })
    .select('id')
    .single()

  if (error) fail(error)

  const { error: rateError } = await supabase.rpc(SET_TAX_RATE_RPC, {
    p_tax_category_id: (data as { id: string }).id,
    p_rate: percentToRate(input.ratePercent),
  })
  if (rateError) fail(rateError)
}

/** Cambiar la tasa de una categoría existente. Versiona, no sobrescribe. */
export async function updateTaxRate(categoryId: string, ratePercent: number): Promise<void> {
  const supabase = client()
  const { error } = await supabase.rpc(SET_TAX_RATE_RPC, {
    p_tax_category_id: categoryId,
    p_rate: percentToRate(ratePercent),
  })
  if (error) fail(error)
}

export const taxCategoriesKey = ['tax-categories'] as const

export function useTaxCategories(enabled: boolean) {
  return useQuery<TaxCategory[]>({
    queryKey: taxCategoriesKey,
    queryFn: fetchTaxCategories,
    enabled,
  })
}

export function useCreateTaxCategory(organizationId: string | null, companyId: string | null) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: TaxCategoryInput) => {
      if (!organizationId || !companyId) {
        throw new AppError({ boundary: 'configuration', code: 'TENANT_NO_DISPONIBLE' })
      }
      return createTaxCategory(organizationId, companyId, input)
    },
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: taxCategoriesKey }),
  })
}

export function useUpdateTaxRate() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ categoryId, ratePercent }: { categoryId: string; ratePercent: number }) =>
      updateTaxRate(categoryId, ratePercent),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: taxCategoriesKey }),
  })
}
