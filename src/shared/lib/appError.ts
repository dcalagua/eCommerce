/**
 * Lectura del CÓDIGO de un error que viene de la base.
 *
 * Las funciones de negocio de este proyecto levantan `CODIGO: mensaje` (P02) y
 * PostgREST devuelve el `SQLSTATE`. La UI traduce el código, nunca el mensaje:
 * el de Postgres filtra internos del esquema y el de la Edge Function viene en
 * un solo idioma.
 *
 * Vive en `shared` porque lo usan por igual el catálogo y los pedidos, y dos
 * copias de la misma expresión regular se separan solas (precedente P05 #45).
 */
export type PostgrestLike = { message?: string; code?: string } | null | undefined

export const INTERNAL_DB_CODE = 'ERROR_INTERNO'

export function codeFromDbError(error: PostgrestLike): string {
  const raw = (error?.message ?? '').trim()
  const business = /(?:^|[:\s])([A-Z][A-Z0-9_]{3,60}):\s/.exec(raw)?.[1]
  return business ?? error?.code ?? INTERNAL_DB_CODE
}
