import type { SearchPort, SearchQuery, SearchResult, Suggestion } from '@/domain'
import { CATALOG_SEARCH_RPC } from '@/shared/lib/db-schema'
import { tryGetSupabaseClient } from '@/shared/lib/supabase'
import { toFilterPayload, toSearchResult } from '@/features/storefront/search'
import { ContentError, contentErrorFromDb } from './errors'

/**
 * `SearchPort` del BACKOFFICE: la segunda implementación viva (P11-SaaS).
 *
 * ## En qué se diferencia de la de la vitrina, y por qué eso justifica el puerto
 *
 * No es la misma consulta con otra credencial. Responde otra pregunta —incluye
 * lo NO publicado— para otro actor —alguien con membresía— bajo otra
 * autorización —`can_access` dentro de `public.catalog_search`—. Es la misma
 * forma que `InventoryPort` tiene desde P06: el backoffice recibe la cifra, la
 * vitrina el semáforo.
 *
 * Su llamante es el selector de productos del editor de contenido. Sin él,
 * montar una colección sería pegar uuids a mano — que es exactamente la deuda
 * que P10 dejó escrita al no poner buscador en el editor de alcance de
 * campañas.
 *
 * **`suggest` no está implementado y devuelve vacío**, a propósito: el
 * autocompletado es una ayuda para quien teclea en una vitrina, y aquí el
 * resultado que hace falta es la ficha entera —con su estado de publicación—
 * para poder añadirla a la colección. Devolver etiquetas obligaría a una
 * segunda consulta por cada elección.
 */
export function createAdminCatalogSearch(storeId: string | null): SearchPort {
  return {
    async search(query: SearchQuery): Promise<SearchResult> {
      const supabase = tryGetSupabaseClient()
      if (!supabase) throw new ContentError('auth.notConfigured', 'CONFIG_INCOMPLETA')
      if (!storeId) {
        return {
          items: [],
          total: 0,
          limit: query.limit ?? 24,
          offset: query.offset ?? 0,
          sort: query.sort ?? 'relevance',
          mode: 'empty',
          facets: {
            categories: [],
            brands: [],
            attributes: [],
            price: { min: null, max: null },
            availability: { inStock: 0, total: 0 },
          },
          query: query.term,
        }
      }

      const request = supabase.rpc(CATALOG_SEARCH_RPC, {
        p_store_id: storeId,
        p_query: query.term.trim() || null,
        p_filters: toFilterPayload(query.filters),
        p_sort: query.sort ?? 'relevance',
        p_limit: query.limit ?? 24,
        p_offset: query.offset ?? 0,
      })

      const { data, error } = await (query.signal ? request.abortSignal(query.signal) : request)
      if (error) throw contentErrorFromDb(error)
      return toSearchResult(data)
    },

    async suggest(): Promise<readonly Suggestion[]> {
      return []
    },
  }
}
