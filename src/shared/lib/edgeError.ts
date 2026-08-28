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

/**
 * Fallo de una etapa del checkout (P07-SaaS).
 *
 * `code` es lo mismo de siempre. Lo nuevo es `stage` —en qué paso del pipeline
 * murió— y `retryable` —si insistir tiene sentido—, y las dos las decide el
 * SERVIDOR: deducirlas en el navegador a partir del código sería una segunda
 * tabla de clasificación que se desincronizaría de la primera.
 *
 * El `message` del servidor no se lee ni se devuelve, igual que arriba: viene
 * en un solo idioma y el texto que ve el comprador sale de i18n.
 */
export interface EdgeFailure {
  code: string
  stage: string | null
  retryable: boolean
}

export async function failureFromInvokeError(error: unknown): Promise<EdgeFailure> {
  const context = (error as { context?: unknown } | null)?.context
  if (context instanceof Response) {
    try {
      const payload: unknown = await context.clone().json()
      const body = (payload as { error?: { code?: unknown; stage?: unknown; retryable?: unknown } })
        ?.error
      if (body && typeof body.code === 'string') {
        return {
          code: body.code,
          stage: typeof body.stage === 'string' ? body.stage : null,
          retryable: body.retryable === true,
        }
      }
    } catch {
      /* la función no respondió JSON: se cae al genérico */
    }
  }
  return { code: INTERNAL_ERROR_CODE, stage: null, retryable: false }
}
