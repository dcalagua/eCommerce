import {
  CATEGORIES_TABLE,
  categorySchema,
  categoryUsageSchema,
  type Category,
  type CategoryFormValues,
  type CategoryUsage,
} from '../types'
import { catalogClient } from './client'
import { catalogErrorFromDb } from './errors'

import { CATEGORY_USAGE_RPC } from '@/shared/lib/db-schema'

export { CATEGORY_USAGE_RPC }

const CATEGORY_SELECT = 'id, store_id, parent_id, slug, name, position, is_active'

/**
 * Categorías de la tienda activa. Sin filtro de tenant en la consulta: lo pone
 * la RLS (`categories_select_member`) con los claims del JWT.
 */
export async function fetchCategories(storeId: string | null): Promise<Category[]> {
  if (!storeId) return []
  const supabase = catalogClient()

  const { data, error } = await supabase
    .from(CATEGORIES_TABLE)
    .select(CATEGORY_SELECT)
    .eq('store_id', storeId)
    .order('position')
    .order('name')

  if (error) throw catalogErrorFromDb(error)
  return categorySchema.array().parse(data ?? [])
}

/**
 * Alta y edición de categoría van directas a la tabla bajo RLS: hay policies
 * de insert/update/delete para `owner/admin/catalog` desde P02 y no hace falta
 * un borde propio para tres columnas.
 *
 * `organization_id`/`company_id` se escriben con los valores que el
 * `TenantProvider` derivó del JWT, y la policy `categories_insert_catalog`
 * vuelve a comprobarlos con `ebim.has_role`: un valor manipulado en el
 * navegador no pasa del `with check`.
 */
export async function saveCategory(input: {
  categoryId?: string | null
  organizationId: string
  companyId: string
  storeId: string
  values: CategoryFormValues
}): Promise<{ id: string }> {
  const supabase = catalogClient()
  const { values } = input

  if (input.categoryId) {
    const { data, error } = await supabase
      .from(CATEGORIES_TABLE)
      // `parent_id` viaja como cadena vacia desde el formulario: en la base es
      // NULL, que es lo que significa «raiz».
      .update({
        name: values.name,
        slug: values.slug,
        is_active: values.is_active,
        parent_id: values.parent_id || null,
      })
      .eq('id', input.categoryId)
      .select('id')
      .single()
    if (error) throw catalogErrorFromDb(error)
    return { id: (data as { id: string }).id }
  }

  const { data, error } = await supabase
    .from(CATEGORIES_TABLE)
    .insert({
      organization_id: input.organizationId,
      company_id: input.companyId,
      store_id: input.storeId,
      name: values.name,
      slug: values.slug,
      is_active: values.is_active,
      parent_id: values.parent_id || null,
    })
    .select('id')
    .single()

  if (error) throw catalogErrorFromDb(error)
  return { id: (data as { id: string }).id }
}

/** Desactivar conserva los datos: es la mitad "segura" del estándar §4.2. */
export async function setCategoryActive(input: {
  categoryId: string
  isActive: boolean
}): Promise<void> {
  const supabase = catalogClient()
  const { error } = await supabase
    .from(CATEGORIES_TABLE)
    .update({ is_active: input.isActive })
    .eq('id', input.categoryId)
  if (error) throw catalogErrorFromDb(error)
}

export async function fetchCategoryUsage(categoryId: string): Promise<CategoryUsage> {
  const supabase = catalogClient()
  const { data, error } = await supabase.rpc(CATEGORY_USAGE_RPC, { p_category_id: categoryId })
  if (error) throw catalogErrorFromDb(error)
  return categoryUsageSchema.parse(data)
}

/**
 * Borrado definitivo. Los productos que la usaban NO se van con ella: el FK es
 * `on delete set null`, así que quedan sin categoría en vez de desaparecer del
 * catálogo. Por eso el diálogo enseña cuántos son antes de confirmar.
 */
export async function deleteCategory(categoryId: string): Promise<void> {
  const supabase = catalogClient()
  const { error } = await supabase.from(CATEGORIES_TABLE).delete().eq('id', categoryId)
  if (error) throw catalogErrorFromDb(error)
}
