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
 * Limpia el término antes de meterlo en un filtro `or=` de PostgREST.
 *
 * Las comas y los paréntesis son separadores de la sintaxis del filtro: un
 * término con `,` no "no encuentra nada", sino que cambia la consulta. Los
 * comodines `%` y `_` se quitan para que el usuario no active un LIKE que no
 * pidió.
 */
export function sanitizeSearchTerm(term: string): string {
  return term
    .trim()
    .replace(/[,()%_*\\"']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
}
