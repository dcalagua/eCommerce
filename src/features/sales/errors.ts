import type { MessageKey } from '@/shared/i18n/messages'
import { UiError, codeFromDbError, type PostgrestLike } from '@/shared/lib/appError'

/**
 * Error de la operación comercial, con su clave de i18n ya resuelta.
 *
 * La pantalla nunca ve el `message` de Postgres, por la misma razón que en
 * clientes: los nombres de restricción de estas tablas describen la estructura
 * comercial del tenant —quién reporta a quién, qué cartera tiene cada uno— y
 * eso no se le enseña a nadie en un mensaje de error.
 *
 * La excepción son los dos códigos que el propio dominio lanza a propósito:
 * `VENDEDOR_CICLO` y `TERRITORIO_CICLO`. Esos SÍ se traducen a una frase útil,
 * porque describen algo que quien está delante del formulario puede arreglar.
 */
export class SalesError extends UiError {
  constructor(key: MessageKey, code: string) {
    super({ boundary: 'sales', key, code })
    this.name = 'SalesError'
  }
}

export function mapSalesCode(code: string): MessageKey {
  switch (code) {
    case 'VENDEDOR_CICLO':
      return 'sales.error.cycle'
    case 'TERRITORIO_CICLO':
      return 'sales.error.territoryCycle'
    case 'DUPLICADO':
    case '23505':
      return 'sales.error.duplicate'
    case 'SIN_PERMISO':
    case 'NO_AUTENTICADO':
    case '42501':
      return 'sales.error.forbidden'
    case 'MODULO_NO_CONTRATADO':
      return 'sales.error.notEntitled'
    case 'NO_ENCONTRADO':
    case 'PGRST116':
      return 'sales.error.notFound'
    case 'CAMPO_INVALIDO':
    case 'DATOS_INVALIDOS':
    case '23503':
    case '23514':
      return 'sales.error.invalid'
    default:
      return 'sales.error.generic'
  }
}

export function salesErrorFromDb(error: PostgrestLike): SalesError {
  const code = codeFromDbError(error)
  return new SalesError(mapSalesCode(code), code)
}
