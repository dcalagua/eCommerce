/**
 * Lectura del error de una Edge Function invocada con `functions.invoke`.
 *
 * El SDK envuelve el fallo en un `FunctionsHttpError` y deja la respuesta
 * cruda en `error.context`. El código de negocio (`{error:{code}}`) es lo único
 * que la UI puede traducir: el mensaje del servidor está en un solo idioma y
 * puede cambiar sin aviso.
 */
export const INTERNAL_ERROR_CODE = 'ERROR_INTERNO'

export async function codeFromInvokeError(error: unknown): Promise<string> {
  const context = (error as { context?: unknown } | null)?.context
  if (context instanceof Response) {
    try {
      const payload: unknown = await context.clone().json()
      const code = (payload as { error?: { code?: unknown } })?.error?.code
      if (typeof code === 'string') return code
    } catch {
      /* la función no respondió JSON: se cae al genérico */
    }
  }
  return INTERNAL_ERROR_CODE
}
