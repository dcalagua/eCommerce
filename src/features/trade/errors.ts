import type { MessageKey } from '@/shared/i18n/messages'
import { UiError, codeFromDbError, type PostgrestLike } from '@/shared/lib/appError'

/**
 * Error comercial, con su clave de i18n ya resuelta.
 *
 * `COTIZACION_CERRADA` sí se traduce a una frase porque describe algo que quien
 * está delante entiende y puede resolver —duplicar y empezar de nuevo—; el
 * resto se degrada, porque los nombres de restricción de estas tablas describen
 * la política comercial del tenant y no tienen por qué salir a la pantalla.
 */
export class TradeError extends UiError {
  constructor(key: MessageKey, code: string) {
    super({ boundary: 'trade', key, code })
    this.name = 'TradeError'
  }
}

export function mapTradeCode(code: string): MessageKey {
  switch (code) {
    case 'COTIZACION_CERRADA':
      return 'trade.error.closed'
    case 'DUPLICADO':
    case '23505':
      return 'trade.error.duplicate'
    case 'SIN_PERMISO':
    case 'NO_AUTENTICADO':
    case '42501':
      return 'trade.error.forbidden'
    case 'MODULO_NO_CONTRATADO':
      return 'trade.error.notEntitled'
    case 'NO_ENCONTRADO':
    case 'PGRST116':
      return 'trade.error.notFound'
    case 'CAMPO_INVALIDO':
    case 'DATOS_INVALIDOS':
    case '23503':
    case '23514':
      return 'trade.error.invalid'
    default:
      return 'trade.error.generic'
  }
}

export function tradeErrorFromDb(error: PostgrestLike): TradeError {
  const code = codeFromDbError(error)
  return new TradeError(mapTradeCode(code), code)
}
