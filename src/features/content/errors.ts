import type { MessageKey } from '@/shared/i18n/messages'
import { UiError, codeFromDbError, type PostgrestLike } from '@/shared/lib/appError'

/**
 * Error del editor de contenido con su clave de i18n ya resuelta.
 *
 * La pantalla nunca ve el mensaje crudo de Postgres. En este dominio eso
 * importa más que en otros: los CHECK que fallan aquí se llaman
 * `content_blocks_body_safe`, `content_blocks_cta_href_safe` y
 * `content_blocks_settings_safe`, y sus nombres son un mapa de qué se está
 * validando — justo lo que no se le enseña a quien esté probando qué se cuela.
 *
 * `23514` (violación de CHECK) se traduce por su SQLSTATE y no por el nombre de
 * la restricción, como en promociones: leer el nombre exigiría interpretar el
 * texto del error, y en este repositorio solo tres módulos pueden hacerlo. El
 * detalle accionable lo da `validateBlockForm` ANTES de enviar.
 */
export class ContentError extends UiError {
  constructor(key: MessageKey, code: string) {
    super({ boundary: 'content', key, code })
    this.name = 'ContentError'
  }
}

export function mapContentCode(code: string): MessageKey {
  switch (code) {
    case 'SIN_PERMISO':
    case 'NO_AUTENTICADO':
    case '42501':
      return 'content.error.forbidden'
    case 'MODULO_NO_CONTRATADO':
      return 'content.error.notEntitled'
    case 'DUPLICADO':
    case '23505':
      return 'content.error.duplicate'
    case '23514':
      return 'content.error.shape'
    // 23503 = clave ajena. Aquí significa que la colección apunta a un producto,
    // una variante o una categoría que ya no existe — que es exactamente el
    // fallo que las columnas tipadas convierten en un error y un `rules jsonb`
    // habría convertido en un hueco silencioso en la portada.
    case '23503':
      return 'content.error.missingTarget'
    case 'CONTENIDO_NO_ENCONTRADO':
    case 'TIENDA_NO_ENCONTRADA':
    case 'SEGMENTO_NO_ENCONTRADO':
    case 'NO_ENCONTRADO':
    case 'PGRST116':
      return 'content.error.notFound'
    case 'DOMINIO_NO_DECLARADO':
      return 'content.error.domainMissing'
    case 'CONFIG_INCOMPLETA':
      return 'auth.notConfigured'
    default:
      return 'content.error.generic'
  }
}

export function contentErrorFromDb(error: PostgrestLike): ContentError {
  const code = codeFromDbError(error)
  return new ContentError(mapContentCode(code), code)
}
