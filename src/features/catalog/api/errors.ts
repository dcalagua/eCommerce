import type { MessageKey } from '@/shared/i18n/messages'
import { UiError, codeFromDbError, type PostgrestLike } from '@/shared/lib/appError'
import { codeFromInvokeError } from '@/shared/lib/edgeError'

/**
 * Error de catálogo con una clave de i18n ya resuelta.
 *
 * La UI nunca enseña el mensaje crudo de Postgres ni el de la Edge Function:
 * uno filtra internos de la base y el otro viene en un solo idioma. El `code`
 * se conserva para poder diagnosticar sin adivinar.
 */
export class CatalogError extends UiError {
  constructor(key: MessageKey, code: string) {
    super({ boundary: 'catalog', key, code })
    this.name = 'CatalogError'
  }
}

/** Códigos del borde y de la base traducidos a algo accionable. */
export function mapCatalogCode(code: string): MessageKey {
  switch (code) {
    case 'DUPLICADO':
    case '23505':
      return 'catalog.error.duplicate'
    case 'SIN_PERMISO':
    case 'NO_AUTENTICADO':
    case '42501':
      return 'catalog.error.forbidden'
    case 'PRODUCTO_NO_ENCONTRADO':
    case 'CATEGORIA_NO_ENCONTRADA':
    case 'IMAGEN_NO_ENCONTRADA':
    case 'TIENDA_NO_ENCONTRADA':
    case 'NO_ENCONTRADO':
    case 'PGRST116':
      return 'catalog.error.notFound'
    case 'CAMPO_INVALIDO':
    case 'CAMPO_NO_PERMITIDO':
    case 'DATOS_INVALIDOS':
    case 'TENANT_NO_ADMITIDO':
    case 'ITEMS_REQUERIDOS':
    case '23503':
    case '23514':
      return 'catalog.error.invalid'
    case 'SIN_CAMBIOS':
      return 'catalog.error.noChanges'
    default:
      return 'catalog.error.generic'
  }
}

export async function catalogErrorFromInvoke(error: unknown): Promise<CatalogError> {
  const code = await codeFromInvokeError(error)
  return new CatalogError(mapCatalogCode(code), code)
}

/**
 * Error de PostgREST o de una función de la base. La lectura del código vive en
 * `shared/lib/appError`: la comparten catálogo y pedidos.
 */
export function catalogErrorFromDb(error: PostgrestLike): CatalogError {
  const code = codeFromDbError(error)
  return new CatalogError(mapCatalogCode(code), code)
}
