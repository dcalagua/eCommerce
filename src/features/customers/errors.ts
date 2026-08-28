import type { MessageKey } from '@/shared/i18n/messages'
import { UiError, codeFromDbError, type PostgrestLike } from '@/shared/lib/appError'

/**
 * Error del dominio de clientes con una clave de i18n ya resuelta.
 *
 * La pantalla nunca ve el `message` de Postgres. Aquí importa especialmente:
 * los errores de estas tablas llevan dentro nombres de restricción que
 * describen la estructura comercial del tenant y, peor, el texto de la fila
 * puede contener datos personales del comprador.
 */
export class CustomersError extends UiError {
  constructor(key: MessageKey, code: string) {
    super({ boundary: 'customers', key, code })
    this.name = 'CustomersError'
  }
}

export function mapCustomersCode(code: string): MessageKey {
  switch (code) {
    case 'DUPLICADO':
    case '23505':
      return 'customers.error.duplicate'
    case 'SIN_PERMISO':
    case 'NO_AUTENTICADO':
    case '42501':
      return 'customers.error.forbidden'
    case 'CLIENTE_NO_ENCONTRADO':
    case 'CUENTA_NO_ENCONTRADA':
    case 'NO_ENCONTRADO':
    case 'PGRST116':
      return 'customers.error.notFound'
    case 'MONTO_INVALIDO':
    case 'CAMPO_INVALIDO':
    case 'DATOS_INVALIDOS':
    case '23503':
    case '23514':
      return 'customers.error.invalid'
    default:
      return 'customers.error.generic'
  }
}

export function customersErrorFromDb(error: PostgrestLike): CustomersError {
  const code = codeFromDbError(error)
  return new CustomersError(mapCustomersCode(code), code)
}
