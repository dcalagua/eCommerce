/**
 * Configuración pública del bundle.
 * SOLO claves publicables. `service_role` jamás llega al frontend (contrato, bloqueante).
 */

function readEnv(key: string): string {
  const value = import.meta.env[key]
  return typeof value === 'string' ? value.trim() : ''
}

export const SUPABASE_URL = readEnv('VITE_SUPABASE_URL')
export const SUPABASE_PUBLISHABLE_KEY = readEnv('VITE_SUPABASE_PUBLISHABLE_KEY')
export const EBIM_HUB_URL = readEnv('VITE_EBIM_HUB_URL')
export const EBIM_APP_SLUG = readEnv('VITE_EBIM_APP_SLUG') || 'ecommerce'
export const APP_NAME = readEnv('VITE_APP_NAME') || 'eCommerce'
/**
 * Versión del build. La inyecta el despliegue; en local es `dev`.
 *
 * Existe para el área de diagnóstico (P02-SaaS): la primera pregunta de
 * cualquier incidencia es «¿qué versión estás viendo?», y la respuesta no puede
 * ser que el usuario mire el hash de un archivo en las herramientas del
 * navegador.
 */
export const APP_VERSION = readEnv('VITE_APP_VERSION') || 'dev'

/**
 * Host del proyecto Supabase, sin esquema ni ruta. Para diagnóstico.
 * Es el HOST, nunca la clave: la URL ya viaja en cada petición del navegador,
 * y una clave publicable pintada en pantalla es una clave publicable que
 * termina en una captura de pantalla en un chat.
 */
export function supabaseHost(url: string = SUPABASE_URL): string {
  if (!url) return ''
  try {
    return new URL(url).host
  } catch {
    return ''
  }
}

/** El proyecto arranca sin backend (P01); las pantallas muestran estado vacío. */
export const isSupabaseConfigured = Boolean(SUPABASE_URL && SUPABASE_PUBLISHABLE_KEY)

/**
 * Guard de build: una clave de servicio en el bundle es un incidente de seguridad.
 * Se evalúa en desarrollo para fallar temprano, no en runtime de producción.
 */
export function assertNoServiceKey(env: Record<string, unknown> = import.meta.env): void {
  const offenders = Object.entries(env)
    .filter(([key, value]) => {
      if (!key.startsWith('VITE_')) return false
      if (/SERVICE_ROLE|SERVICE_KEY|SECRET/i.test(key)) return true
      return typeof value === 'string' && /^sb_secret_|service_role/.test(value)
    })
    .map(([key]) => key)

  if (offenders.length > 0) {
    throw new Error(
      `Claves de servicio expuestas en el bundle: ${offenders.join(', ')}. ` +
        'El service_role solo puede vivir en Edge Functions.',
    )
  }
}
