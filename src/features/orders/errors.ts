import type { MessageKey } from '@/shared/i18n/messages'
import { UiError, codeFromDbError, type PostgrestLike } from '@/shared/lib/appError'
import { codeFromInvokeError } from '@/shared/lib/edgeError'

/**
 * Error de pedidos con una clave de i18n ya resuelta. La pantalla nunca enseña
 * el mensaje crudo de Postgres ni el de la Edge Function.
 */
export class OrderError extends UiError {
  constructor(key: MessageKey, code: string) {
    super({ boundary: 'orders', key, code })
    this.name = 'OrderError'
  }
}

/**
 * Códigos del borde y de la base traducidos a algo accionable.
 *
 * `ORDER_TRANSICION_INVALIDA` merece mensaje propio: es el único error que el
 * usuario puede resolver solo (eligiendo otra transición), y decirle "algo
 * salió mal" lo dejaría probando el mismo botón.
 */
export function mapOrderCode(code: string): MessageKey {
  switch (code) {
    case 'ORDER_TRANSICION_INVALIDA':
    case 'PAGO_TRANSICION_INVALIDA':
    case 'ENTREGA_TRANSICION_INVALIDA':
    case 'APROBACION_TRANSICION_INVALIDA':
    case 'ESTADO_NO_VALIDO':
    case 'EJE_NO_VALIDO':
      return 'orders.error.transition'
    // P08: los dos errores que el operador puede resolver SOLO, y por eso
    // merecen mensaje propio. «Algo salió mal» le dejaría probando el mismo
    // botón hasta rendirse.
    case 'TRANSICION_SIN_CAMBIO':
      return 'orders.error.noChange'
    case 'PEDIDO_PENDIENTE_APROBACION':
      return 'orders.error.awaitingApproval'
    case 'APROBACION_NO_APLICA':
      return 'orders.error.approvalNotApplicable'
    case 'MOTIVO_REQUERIDO':
      return 'orders.error.reasonRequired'
    case 'ORDER_IMPORTES_INMUTABLES':
    case 'ORDER_SNAPSHOT_INMUTABLE':
    case 'ORDER_ITEM_INMUTABLE':
      return 'orders.error.amounts'
    case 'OPERADOR_NO_ES_ACTOR':
      return 'orders.error.suiteOperator'
    case 'PEDIDO_NO_ENCONTRADO':
    case 'NO_ENCONTRADO':
    case 'PGRST116':
      return 'orders.error.notFound'
    case 'SIN_PERMISO':
    case 'NO_AUTENTICADO':
    case 'PROHIBIDO':
    case '42501':
      return 'orders.error.forbidden'
    case 'CAMPO_INVALIDO':
    case 'CAMPO_NO_PERMITIDO':
    case 'TENANT_NO_ADMITIDO':
    case '23514':
      return 'orders.error.invalid'
    // 23505 = clave duplicada. En esta pantalla solo lo produce una etiqueta
    // que ya estaba puesta o una referencia externa repetida para el mismo
    // sistema y tipo; decir «ya existe» es accionable, «algo salió mal» no.
    case '23505':
      return 'orders.error.duplicate'
    default:
      return 'orders.error.generic'
  }
}

export function orderErrorFromDb(error: PostgrestLike): OrderError {
  const code = codeFromDbError(error)
  return new OrderError(mapOrderCode(code), code)
}

export async function orderErrorFromInvoke(error: unknown): Promise<OrderError> {
  const code = await codeFromInvokeError(error)
  return new OrderError(mapOrderCode(code), code)
}
