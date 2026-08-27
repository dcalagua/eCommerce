import { tryGetSupabaseClient } from '@/shared/lib/supabase'
import { tenantBrandingSchema, type TenantBranding } from './types'

/**
 * Vista pública de solo lectura: expone únicamente datos publicables de la tienda.
 * El tenant se resuelve por `brand_slug` de la URL contra esta vista, nunca por un
 * identificador que declare el cliente.
 */
export const PUBLIC_STORE_VIEW = 'public_store_branding'

export class StoreNotFoundError extends Error {
  constructor(slug: string) {
    super(`No existe una tienda publicada para "${slug}".`)
    this.name = 'StoreNotFoundError'
  }
}

/** Devuelve `null` mientras el backend no esté conectado (fase P01). */
export async function fetchStoreBranding(slug: string): Promise<TenantBranding | null> {
  const supabase = tryGetSupabaseClient()
  if (!supabase) return null

  const { data, error } = await supabase
    .from(PUBLIC_STORE_VIEW)
    .select('name, logo_url, accent_color, white_label, brand_slug')
    .eq('brand_slug', slug)
    .maybeSingle()

  if (error) throw new Error(error.message)
  if (!data) throw new StoreNotFoundError(slug)

  return tenantBrandingSchema.parse(data)
}
