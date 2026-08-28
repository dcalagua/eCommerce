import { createContext, useContext } from 'react'
import type { CapabilityId } from '@/domain'
import type { PlatformContext } from './types'

export type CapabilitiesStatus = 'loading' | 'error' | 'ready'

export interface CapabilitiesContextValue {
  readonly status: CapabilitiesStatus
  /** `null` mientras carga o si falló. Nunca un objeto a medias. */
  readonly context: PlatformContext | null
  /**
   * ¿Está el módulo activo para la sociedad en curso?
   *
   * Devuelve `false` mientras carga y cuando falla: la duda es «no». Quien
   * necesite distinguir «todavía no sé» de «no lo tienes» —un guard de ruta,
   * por ejemplo— mira `status`, que para eso está separado.
   */
  readonly has: (capability: CapabilityId) => boolean
  readonly error: Error | null
  readonly refetch: () => void
}

export const CapabilitiesCtx = createContext<CapabilitiesContextValue | null>(null)

/**
 * Capacidades de la sociedad activa.
 *
 * Falla ruidosamente fuera del provider en vez de devolver «nada contratado»:
 * un gate que responde `false` porque olvidaron montar el provider apaga
 * módulos que el cliente sí pagó, y lo hace en silencio.
 */
export function useCapabilities(): CapabilitiesContextValue {
  const value = useContext(CapabilitiesCtx)
  if (!value) throw new Error('useCapabilities debe usarse dentro de <CapabilitiesProvider>')
  return value
}
