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
