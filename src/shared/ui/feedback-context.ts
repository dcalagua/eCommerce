import { createContext, useContext } from 'react'

export type FeedbackSeverity = 'success' | 'error' | 'info' | 'warning'

export interface FeedbackContextValue {
  /** Aviso efímero. El texto ya viene traducido: esto no traduce nada. */
  notify: (message: string, severity?: FeedbackSeverity) => void
}

/**
 * Contexto separado del componente a propósito: un archivo `.tsx` que exporta
 * a la vez un componente y un hook rompe el fast-refresh de Vite (y la regla
 * `react-refresh/only-export-components`). Mismo patrón que i18n y sesión.
 */
export const FeedbackCtx = createContext<FeedbackContextValue>({ notify: () => {} })

export function useFeedback(): FeedbackContextValue {
  return useContext(FeedbackCtx)
}
