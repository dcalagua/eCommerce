/**
 * Fallbacks visuales de la vitrina.
 *
 * La regla del encargo es que la identidad salga siempre de `store_settings` y
 * que, cuando falte, lo que se pinte sea NEUTRO: ni el isotipo de EBIM haciendo
 * de logo del tenant, ni un color de casa disfrazado de marca suya.
 */

/** Una o dos iniciales del nombre de la tienda, para el hueco del logo. */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return '?'
  const first = words[0]?.[0] ?? ''
  const last = words.length > 1 ? (words[words.length - 1]?.[0] ?? '') : ''
  return `${first}${last}`.toUpperCase()
}
