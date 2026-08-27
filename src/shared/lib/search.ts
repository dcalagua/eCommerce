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
