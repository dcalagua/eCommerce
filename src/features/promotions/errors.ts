import type { MessageKey } from '@/shared/i18n/messages'
import { UiError, codeFromDbError, type PostgrestLike } from '@/shared/lib/appError'

/**
 * Error de promociones con su clave de i18n ya resuelta.
 *
 * La pantalla NUNCA ve el mensaje crudo de Postgres: los de este dominio traen
 * dentro nombres de restricción (`promotions_kind_shape`,
 * `promotion_scopes_bundle_shape`) que no dicen nada a quien monta una campaña y
 * sí dicen bastante a quien quiera adivinar el esquema. Lo que se enseña es el
 * CÓDIGO —estable y útil para diagnosticar— y un texto humano aparte.
 *
 * Por eso las violaciones de CHECK se traducen por su SQLSTATE (`23514`) y no
 * por el nombre de la restricción: leer el nombre exigiría interpretar el texto
 * del error, que en este repositorio solo pueden hacer tres módulos
 * (`shared/lib/appError.ts`, `shared/lib/edgeError.ts` y `features/auth`). El
 * detalle accionable —«ese tipo de campaña necesita un porcentaje», «un tope
 * sobre un importe fijo no significa nada»— lo da `validatePromotionForm`
 * ANTES de enviar, que es donde de verdad sirve: con el foco en el campo.
 */
export class PromotionsError extends UiError {
  constructor(key: MessageKey, code: string) {
    super({ boundary: 'promotions', key, code })
    this.name = 'PromotionsError'
  }
}

export function mapPromotionsCode(code: string): MessageKey {
  switch (code) {
    case 'SIN_PERMISO':
    case 'NO_AUTENTICADO':
    case '42501':
      return 'promotions.error.forbidden'
    case 'MODULO_NO_CONTRATADO':
      return 'promotions.error.notEntitled'
    case 'DUPLICADO':
    case '23505':
      return 'promotions.error.duplicate'
    // 23514 = violación de CHECK. En este dominio son SIEMPRE reglas de forma:
    // el tipo de campaña que no trae sus campos, el combo sin cantidad exigida,
    // la escala colgada de una campaña que no es de volumen o una vigencia
    // invertida. Todas las cubre `validatePromotionForm`; si una llega hasta
    // aquí es que la pantalla y la base se han separado, y eso hay que verlo.
    case '23514':
      return 'promotions.error.shape'
    // 23503 = clave ajena. En este dominio significa que el alcance apunta a un
    // producto, una variante, una categoría o una marca que ya no existe.
    case '23503':
      return 'promotions.error.missingTarget'
    case 'TARJETA_NO_ENCONTRADA':
    case 'PROMOCION_NO_ENCONTRADA':
    case 'TIENDA_NO_ENCONTRADA':
    case 'CLIENTE_NO_ENCONTRADO':
    case 'SEGMENTO_NO_ENCONTRADO':
    case 'NO_ENCONTRADO':
    case 'PGRST116':
      return 'promotions.error.notFound'
    case 'TARJETA_CADUCADA':
      return 'promotions.error.giftExpired'
    case 'TARJETA_NO_DISPONIBLE':
      return 'promotions.error.giftUnavailable'
    case 'SALDO_INSUFICIENTE':
      return 'promotions.error.giftBalance'
    case 'MOTIVO_REQUERIDO':
      return 'promotions.error.reasonRequired'
    case 'IMPORTE_INVALIDO':
    case 'CADUCIDAD_INVALIDA':
      return 'promotions.error.amount'
    case 'CUPONES_EXCESIVOS':
      return 'promotions.error.tooManyCoupons'
    case 'CONFIG_INCOMPLETA':
      return 'auth.notConfigured'
    default:
      return 'promotions.error.generic'
  }
}

export function promotionsErrorFromDb(error: PostgrestLike): PromotionsError {
  const code = codeFromDbError(error)
  return new PromotionsError(mapPromotionsCode(code), code)
}
