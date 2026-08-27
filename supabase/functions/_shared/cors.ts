/**
 * CORS compartido.
 *
 * `Access-Control-Allow-Origin: *` solo se admite para el storefront público
 * (lectura y checkout anónimo). Las funciones de backoffice reciben una lista
 * blanca de orígenes: un `*` con `Authorization` es una invitación a que
 * cualquier página lea la sesión del usuario.
 */

export const ALLOWED_HEADERS = [
  'authorization',
  'x-client-info',
  'apikey',
  'content-type',
  'x-ebim-provisioning-key',
].join(', ')

export type CorsOptions = {
  /** Orígenes permitidos. Vacío o `['*']` = público. */
  allowedOrigins?: string[]
  methods?: string[]
}

export function resolveAllowedOrigin(
  requestOrigin: string | null,
  allowedOrigins: string[] | undefined,
): string | null {
  if (!allowedOrigins || allowedOrigins.length === 0 || allowedOrigins.includes('*')) {
    return '*'
  }
  if (!requestOrigin) return null
  return allowedOrigins.includes(requestOrigin) ? requestOrigin : null
}

export function corsHeaders(
  requestOrigin: string | null,
  options: CorsOptions = {},
): Record<string, string> {
  const origin = resolveAllowedOrigin(requestOrigin, options.allowedOrigins)
  const methods = (options.methods ?? ['POST', 'OPTIONS']).join(', ')

  const headers: Record<string, string> = {
    'Access-Control-Allow-Headers': ALLOWED_HEADERS,
    'Access-Control-Allow-Methods': methods,
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  }
  if (origin) headers['Access-Control-Allow-Origin'] = origin
  return headers
}

/** Lee la lista blanca de una variable de entorno separada por comas. */
export function parseAllowedOrigins(value: string | undefined | null): string[] {
  return (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
}
