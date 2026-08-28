import type { MessageKey } from '@/shared/i18n/messages'
import { UiError, codeFromDbError, type PostgrestLike } from '@/shared/lib/appError'

/**
 * Error del motor de precios con una clave de i18n ya resuelta.
 *
 * Igual que en catálogo y pedidos: la pantalla nunca ve el `message` de
 * Postgres. Aquí importa el doble, porque los errores del motor llevan dentro
 * nombres de restricción que describen la estructura comercial del tenant.
 */
export class PricingError extends UiError {
  constructor(key: MessageKey, code: string) {
    super({ boundary: 'pricing', key, code })
    this.name = 'PricingError'
  }
}

export function mapPricingCode(code: string): MessageKey {
  switch (code) {
    case 'DUPLICADO':
    case '23505':
      return 'pricing.error.duplicate'
    case 'SIN_PERMISO':
    case 'NO_AUTENTICADO':
    case '42501':
      return 'pricing.error.forbidden'
    case 'SEGMENTO_NO_ENCONTRADO':
    case 'TIENDA_NO_ENCONTRADA':
    case 'NO_ENCONTRADO':
    case 'PGRST116':
      return 'pricing.error.notFound'
    case 'PRODUCTO_NO_DISPONIBLE':
    case 'VARIANTE_REQUERIDA':
    case 'VARIANTE_NO_APLICA':
    case 'VARIANTE_NO_DISPONIBLE':
    case 'UOM_NO_DISPONIBLE':
      return 'pricing.error.product'
    case 'CAMPO_INVALIDO':
    case 'CAMPO_NO_PERMITIDO':
    case 'DATOS_INVALIDOS':
    case 'CANTIDAD_INVALIDA':
    case 'ITEMS_REQUERIDOS':
    case '23503':
    case '23514':
      return 'pricing.error.invalid'
    default:
      return 'pricing.error.generic'
  }
}

export function pricingErrorFromDb(error: PostgrestLike): PricingError {
  const code = codeFromDbError(error)
  return new PricingError(mapPricingCode(code), code)
}
