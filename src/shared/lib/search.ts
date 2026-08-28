/**
 * Limpia el término antes de meterlo en un filtro `or=`/`ilike` de PostgREST.
 *
 * Las comas y los paréntesis son separadores de la sintaxis del filtro: un
 * término con `,` no "no encuentra nada", sino que cambia la consulta. Los
 * comodines `%` y `_` se quitan para que quien busca no active un LIKE que no
 * pidió. Lo usan el buscador del backoffice y el de la vitrina pública: el
 * comprador anónimo es justo quien más motivos tiene para escribir cualquier
 * cosa en la caja.
 */
export function sanitizeSearchTerm(term: string): string {
  return term
    .trim()
    .replace(/[,()%_*\\"']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
}

/**
 * Filtro `or=` de PostgREST para buscar el mismo término en varias columnas.
 *
 * Estaba escrito a mano en tres sitios —catálogo del backoffice, pedidos y
 * vitrina pública— con la misma interpolación y tres juegos de columnas
 * distintos. Tres copias de una sintaxis en la que una coma de más cambia la
 * consulta en vez de no encontrar nada.
 *
 * Devuelve `null` cuando el término queda vacío tras sanearlo, para que el
 * llamante simplemente no añada el filtro: un `or=` vacío no es «sin filtro».
 *
 * NO es un `SearchPort`. Es la construcción del filtro y nada más; el puerto
 * llegará cuando exista un segundo motor que lo justifique (ver
 * `src/domain/ports/index.ts`).
 */
export function buildTextSearchFilter(term: string, columns: readonly string[]): string | null {
  const safe = sanitizeSearchTerm(term)
  if (!safe || columns.length === 0) return null
  return columns.map((column) => `${column}.ilike.%${safe}%`).join(',')
}
