import { createContext, useContext } from 'react'
import { dictionary, es, type Locale, type MessageKey } from './messages'

export const LOCALE_STORAGE_KEY = 'ecommerce-locale'

export interface I18nContextValue {
  locale: Locale
  setLocale: (locale: Locale) => void
  t: (key: MessageKey) => string
}

/**
 * Traduce con lo que HAY CARGADO.
 *
 * Desde P15-SaaS los idiomas que no son el de suite llegan por `import()`, así
 * que `dictionary()` puede devolver todavía el español. La cadena de fallback
 * es la de siempre —idioma pedido → español → la clave cruda— y el último
 * escalón sigue sin verse nunca: `messages.test.ts` recorre las dos listas
 * enteras para comprobarlo.
 */
export function translate(locale: Locale, key: MessageKey): string {
  return dictionary(locale)[key] ?? es[key] ?? key
}

export const I18nContext = createContext<I18nContextValue>({
  locale: 'es',
  setLocale: () => {},
  t: (key) => translate('es', key),
})

export function useI18n(): I18nContextValue {
  return useContext(I18nContext)
}

/** Atajo para componentes que solo traducen. */
export function useT(): (key: MessageKey) => string {
  return useI18n().t
}
