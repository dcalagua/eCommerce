import type { MessageKey } from '@/shared/i18n/messages'
import { codeFromInvokeError } from '@/shared/lib/edgeError'

/**
 * Error de catálogo con una clave de i18n ya resuelta.
 *
 * La UI nunca enseña el mensaje crudo de Postgres ni el de la Edge Function:
 * uno filtra internos de la base y el otro viene en un solo idioma. El `code`
 * se conserva para poder diagnosticar sin adivinar.
 */
export class CatalogError extends Error {
  readonly key: MessageKey
  readonly code: string

  constructor(key: MessageKey, code: string) {
    super(code)
    this.name = 'CatalogError'
    this.key = key
    this.code = code
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

type PostgrestLike = { message?: string; code?: string } | null | undefined

/**
 * Error de PostgREST o de una función de la base. Las funciones de negocio
 * levantan `CODIGO: mensaje` (mismo convenio que P02), así que primero se
 * intenta leer ese código y solo después el `SQLSTATE`.
 */
export function catalogErrorFromDb(error: PostgrestLike): CatalogError {
  const raw = (error?.message ?? '').trim()
  const business = /(?:^|[:\s])([A-Z][A-Z0-9_]{3,60}):\s/.exec(raw)?.[1]
  const code = business ?? error?.code ?? 'ERROR_INTERNO'
  return new CatalogError(mapCatalogCode(code), code)
}
