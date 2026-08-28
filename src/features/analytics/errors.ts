import type { MessageKey } from '@/shared/i18n/messages'
import { UiError, codeFromDbError, type PostgrestLike } from '@/shared/lib/appError'

/**
 * Error de analítica con su clave de i18n ya resuelta.
 *
 * El caso que justifica que exista es `SIN_MODULO`: la base lo levanta cuando
 * la sociedad no tiene `analytics.advanced`, y traducirlo a «algo salió mal»
 * sería el error más caro de esta pantalla — el comercio pensaría que su embudo
 * está roto cuando lo que pasa es que no lo tiene contratado. Son dos
 * incidencias distintas para quien da soporte, exactamente como P02 argumentó
 * para `sin-contexto`.
 */
export class AnalyticsError extends UiError {
  constructor(key: MessageKey, code: string) {
    super({ boundary: 'analytics', key, code })
    this.name = 'AnalyticsError'
  }
}

export function mapAnalyticsCode(code: string): MessageKey {
  switch (code) {
    case 'SIN_MODULO':
      return 'analytics.error.notEntitled'
    case 'SIN_PERMISO':
    case 'NO_AUTENTICADO':
    case '42501':
      return 'analytics.error.forbidden'
    case 'CONFIG_INCOMPLETA':
      return 'auth.notConfigured'
    default:
      return 'analytics.error.generic'
  }
}

export function analyticsErrorFromDb(error: PostgrestLike): AnalyticsError {
  const code = codeFromDbError(error)
  return new AnalyticsError(mapAnalyticsCode(code), code)
}

/**
 * `SIN_MODULO` no es un fallo: es una respuesta. La pantalla la usa para
 * enseñar «no está en tu plan» dentro de la pestaña en vez de un error rojo, y
 * para no reintentar algo que no se arregla reintentando.
 */
export function isNotEntitled(error: unknown): boolean {
  return error instanceof AnalyticsError && error.code === 'SIN_MODULO'
}
