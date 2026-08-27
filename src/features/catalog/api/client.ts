import type { SupabaseClient } from '@supabase/supabase-js'
import { tryGetSupabaseClient } from '@/shared/lib/supabase'
import { CatalogError } from './errors'

/**
 * Única puerta de entrada a Supabase de todo el catálogo.
 *
 * Los componentes visuales no importan `supabase-js`: piden datos a estos
 * servicios y a los hooks que los envuelven. Así el día que el transporte
 * cambie (una Edge Function más, un proxy) no hay que tocar una sola pantalla.
 */
export function catalogClient(): SupabaseClient {
  const supabase = tryGetSupabaseClient()
  if (!supabase) throw new CatalogError('auth.notConfigured', 'CONFIG_INCOMPLETA')
  return supabase
}

/**
 * Reexporta el saneador compartido (`src/shared/lib/search.ts`): lo usan por
 * igual el buscador del backoffice y el de la vitrina pública, así que vive
 * fuera del dominio de catálogo y no en dos copias.
 */
export { sanitizeSearchTerm } from '@/shared/lib/search'
