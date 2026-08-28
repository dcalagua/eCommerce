import type { MessageKey } from '@/shared/i18n/messages'
import { UiError, codeFromDbError, type PostgrestLike } from '@/shared/lib/appError'

/**
 * Error de la pantalla de operación.
 *
 * El caso que importa es `SIN_PERMISO`: la salud operativa y la auditoría las
 * ven `owner` y `admin`, no cualquier miembro, y el enforcement está en la
 * policy y dentro de `ops_health`. Un `viewer` tiene que leer «no tienes
 * permiso», no «no hay datos»: lo segundo le haría creer que su tienda está
 * sana cuando lo que pasa es que no puede mirar.
 */
export class OpsError extends UiError {
  constructor(key: MessageKey, code: string) {
    super({ boundary: 'observability', key, code })
    this.name = 'OpsError'
  }
}

export function mapOpsCode(code: string): MessageKey {
  switch (code) {
    case 'SIN_PERMISO':
    case 'NO_AUTENTICADO':
    case '42501':
      return 'ops.error.forbidden'
    case 'INCIDENTE_NO_ENCONTRADO':
    case 'PGRST116':
      return 'ops.error.notFound'
    case 'MOTIVO_REQUERIDO':
      return 'ops.error.reasonRequired'
    case 'CORRELACION_INVALIDA':
      return 'ops.error.badCorrelation'
    case 'CONFIG_INCOMPLETA':
      return 'auth.notConfigured'
    default:
      return 'ops.error.generic'
  }
}

export function opsErrorFromDb(error: PostgrestLike): OpsError {
  const code = codeFromDbError(error)
  return new OpsError(mapOpsCode(code), code)
}

export function isForbidden(error: unknown): boolean {
  return error instanceof OpsError && (error.code === 'SIN_PERMISO' || error.code === '42501')
}
