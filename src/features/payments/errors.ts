import type { MessageKey } from '@/shared/i18n/messages'
import { UiError, codeFromDbError, type PostgrestLike } from '@/shared/lib/appError'

/**
 * Error de pagos con su clave de i18n ya resuelta.
 *
 * Aquí importa más que en ningún otro dominio que la pantalla NUNCA vea el
 * mensaje crudo: los de la base traen dentro nombres de restricción, importes y
 * referencias del proveedor, y los del proveedor traen su vocabulario. El
 * código de resultado del banco se enseña aparte y a propósito —hace falta para
 * llamarles—, pero como dato de una columna, no como texto de error.
 */
export class PaymentsError extends UiError {
  constructor(key: MessageKey, code: string) {
    super({ boundary: 'payments', key, code })
    this.name = 'PaymentsError'
  }
}

export function mapPaymentsCode(code: string): MessageKey {
  switch (code) {
    case 'SIN_PERMISO':
    case 'NO_AUTENTICADO':
    case 'OPERADOR_NO_ES_ACTOR':
    case 'ORIGEN_NO_PERMITIDO':
    case 'DEVOLUCION_CON_PASARELA':
    case '42501':
      return 'payments.error.forbidden'
    case 'MODULO_NO_CONTRATADO':
      return 'payments.error.notEntitled'
    case 'DUPLICADO':
    case '23505':
      return 'payments.error.duplicate'
    case 'COBRO_NO_ENCONTRADO':
    case 'INTENTO_NO_ENCONTRADO':
    case 'DEVOLUCION_NO_ENCONTRADA':
    case 'LIQUIDACION_NO_ENCONTRADA':
    case 'MEDIO_DE_PAGO_NO_ENCONTRADO':
    case 'PROVEEDOR_NO_ENCONTRADO':
    case 'NO_ENCONTRADO':
    case 'PGRST116':
      return 'payments.error.notFound'
    case 'DEVOLUCION_EXCEDE_COBRO':
      return 'payments.error.refundTooLarge'
    case 'IMPORTE_NO_VALIDO':
    case 'MONEDA_NO_VALIDA':
      return 'payments.error.amount'
    case 'EXTRACTO_NO_VALIDO':
      return 'payments.error.statement'
    case 'COBRO_DE_OTRO_TENANT':
    case 'PEDIDO_DE_OTRA_TIENDA':
      return 'payments.error.crossTenant'
    case 'IDEMPOTENCIA_INCOHERENTE':
      return 'payments.error.idempotency'
    case 'FIRMA_NO_VERIFICADA':
    case 'RETORNO_NO_DECIDE':
      return 'payments.error.untrusted'
    case 'CONFIG_INCOMPLETA':
      return 'auth.notConfigured'
    default:
      return 'payments.error.generic'
  }
}

export function paymentsErrorFromDb(error: PostgrestLike): PaymentsError {
  const code = codeFromDbError(error)
  return new PaymentsError(mapPaymentsCode(code), code)
}
