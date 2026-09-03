import type { MessageKey } from '@/shared/i18n/messages'
import { UiError, codeFromDbError, type PostgrestLike } from '@/shared/lib/appError'

/**
 * Error de planificación, con su clave de i18n ya resuelta.
 *
 * Nada de lo que esta frontera escribe es irreversible —una sugerencia se
 * descarta y se genera otra—, así que el catálogo es corto: permiso, addon,
 * duplicado y el genérico. Los nombres de restricción no salen a pantalla.
 */
export class PlanningError extends UiError {
  constructor(key: MessageKey, code: string) {
    super({ boundary: 'planning', key, code })
    this.name = 'PlanningError'
  }
}

export function mapPlanningCode(code: string): MessageKey {
  switch (code) {
    case 'DUPLICADO':
    case '23505':
      return 'planning.error.duplicate'
    case 'SIN_PERMISO':
    case 'NO_AUTENTICADO':
    case '42501':
      return 'planning.error.forbidden'
    case 'MODULO_NO_CONTRATADO':
      return 'planning.error.notEntitled'
    case 'NO_ENCONTRADO':
    case 'PGRST116':
      return 'planning.error.notFound'
    case 'CAMPO_INVALIDO':
    case 'DATOS_INVALIDOS':
    case '23503':
    case '23514':
      return 'planning.error.invalid'
    case 'CONFIG_INCOMPLETA':
      return 'auth.notConfigured'
    default:
      return 'planning.error.generic'
  }
}

export function planningErrorFromDb(error: PostgrestLike): PlanningError {
  const code = codeFromDbError(error)
  return new PlanningError(mapPlanningCode(code), code)
}
